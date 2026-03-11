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
      timeout: 15000,
    });

    // Rate limit: no máximo 1 req REST a cada 500ms
    this._queue = [];
    this._lastCall = 0;
    this._minDelay = 500;
    this._timeOffset = 0; // diferença entre relógio local e servidor Binance
    this._restBlockedUntil = 0;
    this._restBlockReason = "";
    this._recvWindow = parseInt(process.env.BINANCE_RECV_WINDOW || "10000", 10);
    this._exchangeInfoCache = null;
    this._exchangeInfoFetchedAt = 0;
    this._exchangeInfoTTL = 60 * 60 * 1000; // 1 hora
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
    if (now < this._restBlockedUntil) {
      const waitMs = this._restBlockedUntil - now;
      const err = new Error(
        `REST temporariamente bloqueado por ${Math.ceil(waitMs / 1000)}s (${this._restBlockReason || "IP ban/rate limit"})`,
      );
      err.response = {
        status: 418,
        data: {
          msg: this._restBlockReason || "REST blocked by local circuit breaker",
        },
      };
      throw err;
    }

    const nowAfterBlockCheck = Date.now();
    const wait = Math.max(0, this._minDelay - (nowAfterBlockCheck - this._lastCall));
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this._lastCall = Date.now();
    try {
      return await fn();
    } catch (e) {
      const status = e.response?.status;
      if (status === 418 || status === 429) {
        const msg = e.response?.data?.msg || e.message || "";
        const match = msg.match(/banned until (\d+)/i);
        const banTs = match ? parseInt(match[1], 10) : 0;
        const until = banTs
          ? Math.max(banTs + 30_000, Date.now() + 11 * 60 * 1000)
          : Date.now() + 11 * 60 * 1000;
        this._restBlockedUntil = Math.max(this._restBlockedUntil, until);
        this._restBlockReason = msg || "IP ban/rate limit";
        logger.warn(
          `REST circuit breaker ativo por ${Math.ceil((this._restBlockedUntil - Date.now()) / 60000)} min`,
        );
      }
      throw e;
    }
  }

  sign(params) {
    const timestamp = Date.now() + this._timeOffset;
    const query = new URLSearchParams({
      recvWindow: this._recvWindow,
      ...params,
      timestamp,
    }).toString();
    const sig = crypto
      .createHmac("sha256", this.apiSecret)
      .update(query)
      .digest("hex");
    return `${query}&signature=${sig}`;
  }

  _buildClientOrderId(prefix = "bot") {
    const rnd = crypto.randomBytes(6).toString("hex");
    return `${prefix}_${Date.now()}_${rnd}`.slice(0, 36);
  }

  _isExecutionStatusUnknown(err) {
    const msg = (err?.response?.data?.msg || err?.message || "").toLowerCase();
    return (
      msg.includes("execution status unknown") ||
      msg.includes("send status unknown") ||
      err?.code === "ECONNABORTED"
    );
  }

  async getExchangeInfo(force = false) {
    const now = Date.now();
    if (
      !force &&
      this._exchangeInfoCache &&
      now - this._exchangeInfoFetchedAt < this._exchangeInfoTTL
    ) {
      return this._exchangeInfoCache;
    }
    const data = await this._request(async () => {
      const res = await this.http.get("/fapi/v1/exchangeInfo");
      return res.data;
    });
    this._exchangeInfoCache = data;
    this._exchangeInfoFetchedAt = now;
    return data;
  }

  async _getSymbolInfo(symbol) {
    const sym = String(symbol || "").toUpperCase();
    if (!sym) return null;
    let info = await this.getExchangeInfo(false);
    let symbolInfo = info?.symbols?.find((s) => s.symbol === sym);
    if (!symbolInfo) {
      info = await this.getExchangeInfo(true);
      symbolInfo = info?.symbols?.find((s) => s.symbol === sym);
    }
    return symbolInfo || null;
  }

  _countDecimals(num) {
    if (!Number.isFinite(num)) return 0;
    const s = num.toString();
    if (s.includes("e-")) {
      const [, exp] = s.split("e-");
      return parseInt(exp, 10) || 0;
    }
    const idx = s.indexOf(".");
    return idx >= 0 ? s.length - idx - 1 : 0;
  }

  _roundDownToStep(value, step) {
    if (!Number.isFinite(value) || !Number.isFinite(step) || step <= 0) {
      return value;
    }
    const n = Math.floor(value / step + 1e-12) * step;
    const decimals = this._countDecimals(step);
    return Number(n.toFixed(Math.min(decimals, 12)));
  }

  async normalizeOrderQuantity(symbol, quantity) {
    const qty = Number(quantity);
    if (!Number.isFinite(qty) || qty <= 0) return qty;

    const symbolInfo = await this._getSymbolInfo(symbol);
    if (!symbolInfo) return qty;

    const filters = symbolInfo.filters || [];
    const lotFilter =
      filters.find((f) => f.filterType === "MARKET_LOT_SIZE") ||
      filters.find((f) => f.filterType === "LOT_SIZE");

    const step = Number(lotFilter?.stepSize || 0);
    const minQty = Number(lotFilter?.minQty || 0);
    const maxQty = Number(lotFilter?.maxQty || 0);
    const precision = Number.isInteger(symbolInfo.quantityPrecision)
      ? symbolInfo.quantityPrecision
      : this._countDecimals(step);

    let normalized = qty;
    if (step > 0) normalized = this._roundDownToStep(normalized, step);
    if (precision >= 0) normalized = Number(normalized.toFixed(Math.min(precision, 12)));
    if (minQty > 0 && normalized < minQty) {
      throw new Error(
        `Quantidade ${normalized} abaixo do mínimo ${minQty} para ${symbol}`,
      );
    }
    if (maxQty > 0 && normalized > maxQty) normalized = maxQty;
    if (step > 0) normalized = this._roundDownToStep(normalized, step);

    if (!Number.isFinite(normalized) || normalized <= 0) {
      throw new Error(`Quantidade inválida após normalização para ${symbol}`);
    }
    return normalized;
  }

  // ── Account (REST — chamado manualmente, não em loop) ─────────────────────
  async getMinNotional(symbol) {
    const symbolInfo = await this._getSymbolInfo(symbol);
    if (!symbolInfo) return 0;
    const filters = symbolInfo.filters || [];
    const notionalFilter = filters.find((f) => f.filterType === "NOTIONAL");
    const minNotionalFilter = filters.find((f) => f.filterType === "MIN_NOTIONAL");
    const value =
      Number(notionalFilter?.notional || 0) ||
      Number(minNotionalFilter?.minNotional || 0);
    return Number.isFinite(value) ? value : 0;
  }
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
    const normalizedQty = await this.normalizeOrderQuantity(symbol, quantity);
    const clientOrderId = this._buildClientOrderId("mkt");
    try {
      return await this.placeOrder({
        symbol,
        side,
        type: "MARKET",
        quantity: normalizedQty,
        newClientOrderId: clientOrderId,
      });
    } catch (e) {
      if (!this._isExecutionStatusUnknown(e)) throw e;

      logger.warn(
        `Order timeout/unknown (${symbol} ${side} ${normalizedQty}). Reconciliando por clientOrderId=${clientOrderId}`,
      );

      // Binance pode aceitar a ordem mas atrasar a resposta.
      for (let i = 0; i < 4; i++) {
        await new Promise((r) => setTimeout(r, 1200));
        try {
          const order = await this.getOrder(symbol, {
            origClientOrderId: clientOrderId,
          });
          if (order?.orderId) {
            logger.warn(
              `Ordem reconciliada com sucesso (orderId=${order.orderId}, status=${order.status})`,
            );
            return order;
          }
        } catch (reconcileErr) {
          const msg = reconcileErr?.response?.data?.msg || reconcileErr?.message || "";
          if (!/order does not exist/i.test(msg)) throw reconcileErr;
        }
      }
      throw e;
    }
  }

  async getOrder(symbol, { orderId, origClientOrderId } = {}) {
    return this._request(async () => {
      const params = { symbol };
      if (orderId !== undefined) params.orderId = orderId;
      if (origClientOrderId) params.origClientOrderId = origClientOrderId;
      const qs = this.sign(params);
      const res = await this.http.get(`/fapi/v1/order?${qs}`);
      return res.data;
    });
  }

  async placeStopOrder(symbol, side, stopPrice) {
    return this.placeOrder({
      symbol,
      side,
      type: "STOP_MARKET",
      stopPrice,
      closePosition: true,
      workingType: "MARK_PRICE",
      priceProtect: true,
    });
  }

  async placeTakeProfitOrder(symbol, side, stopPrice) {
    return this.placeOrder({
      symbol,
      side,
      type: "TAKE_PROFIT_MARKET",
      stopPrice,
      closePosition: true,
      workingType: "MARK_PRICE",
      priceProtect: true,
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

  async getIncomeHistory(symbol, incomeType = "REALIZED_PNL", limit = 100) {
    return this._request(async () => {
      const qs = this.sign({ symbol, incomeType, limit });
      const res = await this.http.get(`/fapi/v1/income?${qs}`);
      return res.data;
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

  closeStreamsByPrefix(prefix) {
    Object.keys(this.streams)
      .filter((key) => key.startsWith(prefix))
      .forEach((key) => {
        this._closedKeys.add(key);
        try {
          this.streams[key].terminate();
        } catch (e) {}
        delete this.streams[key];
      });
  }
}

module.exports = BinanceClient;

