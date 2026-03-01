// binanceClient.js - Binance Futures Client
// REST apenas para ordens/conta. Candles e preço via WebSocket.
const axios = require("axios");
const crypto = require("crypto");
const WebSocket = require("ws");
const logger = require("./logger");

const LIVE_BASE = "https://fapi.binance.com";
const TEST_BASE = "https://testnet.binancefuture.com";
const LIVE_WS = "wss://fstream.binance.com";
const TEST_WS = "wss://stream.binancefuture.com";

class BinanceClient {
  constructor(apiKey, apiSecret, testnet = true) {
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.testnet = testnet;
    this.baseUrl = testnet ? TEST_BASE : LIVE_BASE;
    this.wsBase = testnet ? TEST_WS : LIVE_WS;
    this.streams = {};
    this._closedKeys = new Set(); // chaves fechadas intencionalmente (não reconectar)

    this.http = axios.create({
      baseURL: this.baseUrl,
      headers: { "X-MBX-APIKEY": this.apiKey },
      timeout: 10000,
    });

    // Rate limit: no máximo 1 req REST a cada 500ms
    this._queue = [];
    this._lastCall = 0;
    this._minDelay = 500;
    this._timeOffset = 0; // diferença entre relógio local e servidor Binance
  }

  // ── Sincronizar relógio com servidor Binance (resolve erro -1021) ──────────
  async syncTime() {
    try {
      const res = await this.http.get("/fapi/v1/time");
      const server = res.data.serverTime;
      this._timeOffset = server - Date.now();
      logger.info(`⏱️ Relógio sincronizado (offset: ${this._timeOffset}ms)`);
    } catch (e) {
      logger.warn(`⚠️ Não foi possível sincronizar relógio: ${e.message}`);
    }
  }

  // ── Rate-limited REST ──────────────────────────────────────────────────────
  async _request(fn) {
    const now = Date.now();
    const wait = Math.max(0, this._minDelay - (now - this._lastCall));
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this._lastCall = Date.now();
    return fn();
  }

  sign(params) {
    const timestamp = Date.now() + this._timeOffset;
    const query = new URLSearchParams({ ...params, timestamp }).toString();
    const sig = crypto
      .createHmac("sha256", this.apiSecret)
      .update(query)
      .digest("hex");
    return `${query}&signature=${sig}`;
  }

  // ── Account (REST — chamado manualmente, não em loop) ─────────────────────
  async getBalance() {
    return this._request(async () => {
      const qs = this.sign({});
      const res = await this.http.get(`/fapi/v2/balance?${qs}`);
      return res.data;
    });
  }

  async getPositions(symbol) {
    return this._request(async () => {
      // Testnet exige símbolo — sempre passar
      if (!symbol) throw new Error("symbol é obrigatório para getPositions");
      const qs = this.sign({ symbol });
      const res = await this.http.get(`/fapi/v2/positionRisk?${qs}`);
      return res.data.filter((p) => parseFloat(p.positionAmt) !== 0);
    });
  }

  // ── Candles via REST — chamado apenas 1x no início para popular histórico ──
  async getKlines(symbol, interval = "15m", limit = 200) {
    return this._request(async () => {
      const res = await this.http.get("/fapi/v1/klines", {
        params: { symbol, interval, limit },
      });
      return res.data.map((k) => ({
        openTime: k[0],
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
        volume: parseFloat(k[5]),
        closeTime: k[6],
      }));
    });
  }

  async getTicker(symbol) {
    return this._request(async () => {
      const res = await this.http.get("/fapi/v1/ticker/24hr", {
        params: { symbol },
      });
      return res.data;
    });
  }

  async getMarkPrice(symbol) {
    return this._request(async () => {
      const res = await this.http.get("/fapi/v1/premiumIndex", {
        params: { symbol },
      });
      return res.data;
    });
  }

  // ── Orders (REST — só quando há sinal) ────────────────────────────────────
  async setLeverage(symbol, leverage) {
    return this._request(async () => {
      const qs = this.sign({ symbol, leverage });
      const res = await this.http.post(`/fapi/v1/leverage?${qs}`);
      return res.data;
    });
  }

  async setMarginType(symbol, marginType = "ISOLATED") {
    try {
      return await this._request(async () => {
        const qs = this.sign({ symbol, marginType });
        const res = await this.http.post(`/fapi/v1/marginType?${qs}`);
        return res.data;
      });
    } catch (e) {
      if (e.response?.data?.code === -4046) return { msg: "already set" };
      throw e;
    }
  }

  async placeOrder(params) {
    return this._request(async () => {
      const qs = this.sign(params);
      const res = await this.http.post(`/fapi/v1/order?${qs}`);
      return res.data;
    });
  }

  async placeMarketOrder(symbol, side, quantity) {
    return this.placeOrder({ symbol, side, type: "MARKET", quantity });
  }

  async placeStopOrder(symbol, side, quantity, stopPrice) {
    return this.placeOrder({
      symbol,
      side,
      type: "STOP_MARKET",
      quantity,
      stopPrice,
      closePosition: false,
    });
  }

  async placeTakeProfitOrder(symbol, side, quantity, stopPrice) {
    return this.placeOrder({
      symbol,
      side,
      type: "TAKE_PROFIT_MARKET",
      quantity,
      stopPrice,
      closePosition: false,
    });
  }

  async cancelAllOrders(symbol) {
    return this._request(async () => {
      const qs = this.sign({ symbol });
      const res = await this.http.delete(`/fapi/v1/allOpenOrders?${qs}`);
      return res.data;
    });
  }

  async getOrderHistory(symbol, limit = 50) {
    return this._request(async () => {
      const qs = this.sign({ symbol, limit });
      const res = await this.http.get(`/fapi/v1/allOrders?${qs}`);
      return res.data.slice(-limit);
    });
  }

  async closePosition(symbol, side, quantity) {
    const closeSide = side === "LONG" ? "SELL" : "BUY";
    return this.placeMarketOrder(symbol, closeSide, Math.abs(quantity));
  }

  // ── WebSocket: Kline stream (candle a candle, sem polling REST) ────────────
  subscribeKline(symbol, interval, onCandle) {
    const key = `kline_${symbol}_${interval}`;
    if (this.streams[key]) {
      this.streams[key].terminate();
      delete this.streams[key];
    }

    const stream = `${symbol.toLowerCase()}@kline_${interval}`;
    const url = `${this.wsBase}/ws/${stream}`;
    logger.info(`📡 WS Kline conectando: ${url}`);

    const connect = () => {
      const ws = new WebSocket(url);

      ws.on("open", () =>
        logger.info(`✅ WS Kline conectado: ${symbol} ${interval}`),
      );

      ws.on("message", (raw) => {
        try {
          const msg = JSON.parse(raw);
          const k = msg.k;
          if (!k) return;
          onCandle({
            openTime: k.t,
            open: parseFloat(k.o),
            high: parseFloat(k.h),
            low: parseFloat(k.l),
            close: parseFloat(k.c),
            volume: parseFloat(k.v),
            closeTime: k.T,
            closed: k.x, // true = vela fechada
          });
        } catch (e) {}
      });

      ws.on("error", (e) => logger.error(`WS Kline error: ${e.message}`));

      ws.on("close", () => {
        delete this.streams[key];
        if (this._closedKeys.has(key)) {
          this._closedKeys.delete(key);
          return; // fechado intencionalmente — não reconectar
        }
        logger.warn(`WS Kline fechado (${key}), reconectando em 5s...`);
        setTimeout(() => {
          const newWs = connect();
          this.streams[key] = newWs;
        }, 5000);
      });

      return ws;
    };

    const ws = connect();
    this.streams[key] = ws;
    return ws;
  }

  // ── WebSocket: Ticker (preço ao vivo) ─────────────────────────────────────
  subscribeTicker(symbol, onTick) {
    const key = `ticker_${symbol}`;
    if (this.streams[key]) {
      this.streams[key].terminate();
      delete this.streams[key];
    }

    const stream = `${symbol.toLowerCase()}@miniTicker`;
    const url = `${this.wsBase}/ws/${stream}`;

    const connect = () => {
      const ws = new WebSocket(url);
      ws.on("message", (raw) => {
        try {
          onTick(JSON.parse(raw));
        } catch (e) {}
      });
      ws.on("error", (e) => logger.error(`WS Ticker error: ${e.message}`));
      ws.on("close", () => {
        delete this.streams[key];
        if (this._closedKeys.has(key)) {
          this._closedKeys.delete(key);
          return; // fechado intencionalmente — não reconectar
        }
        setTimeout(() => {
          this.streams[key] = connect();
        }, 5000);
      });
      return ws;
    };

    const ws = connect();
    this.streams[key] = ws;
    return ws;
  }

  closeAllStreams() {
    Object.keys(this.streams).forEach((key) => {
      this._closedKeys.add(key); // marca como intencional antes de terminar
      try {
        this.streams[key].terminate();
      } catch (e) {}
    });
    this.streams = {};
    logger.info("Todos WS streams fechados");
  }
}

module.exports = BinanceClient;
