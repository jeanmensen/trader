// bot.js - Trading Bot Engine
// Usa WebSocket para candles. REST apenas para ordens e saldo (não em loop).
const { v4: uuidv4 } = require("uuid");
const logger = require("./logger");
const ConservativeStrategy = require("./strategy");

class TradingBot {
  constructor(binanceClient, config, broadcastFn) {
    this.client = binanceClient;
    this.config = config;
    this.broadcast = broadcastFn || (() => {});
    this.strategy = new ConservativeStrategy();

    this.state = {
      running: false,
      positions: [],
      trades: [],
      candles: [], // histórico de candles (mantido em memória)
      lastSignal: null,
      stats: { totalTrades: 0, wins: 0, losses: 0, pnl: 0 },
      logs: [],
    };

    // Cache de saldo — atualizado apenas quando necessário
    this._balanceCache = 0;
    this._balanceFetchedAt = 0;
    this._balanceTTL = 60000; // 60s

    // Cooldown entre trades (evita entrar 2x no mesmo sinal)
    this._lastTradeAt = 0;
    this._tradeCooldown = 5 * 60 * 1000; // 5 minutos

    // Pausa de ordens por ban de IP
    this._ordersPaused = false;
    this._ordersPausedAt = 0;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────
  async start() {
    if (this.state.running) return { ok: false, msg: "Already running" };
    this.log("🚀 Bot iniciado - Estratégia Conservadora");

    // Sincronizar relógio com Binance primeiro (evita erro -1021)
    await this.client.syncTime();

    // Setup de alavancagem/margem (2 chamadas REST apenas no início)
    try {
      await this.client.setLeverage(this.config.symbol, this.config.leverage);
      await this.client.setMarginType(this.config.symbol, "ISOLATED");
      this.log(`✅ Alavancagem: ${this.config.leverage}x | Margem: ISOLATED`);
    } catch (e) {
      this.log(`⚠️ Setup: ${e.response?.data?.msg || e.message}`, "warn");
    }

    // Carregar histórico de candles via REST (1 única chamada)
    this.log(`📥 Carregando histórico de candles...`);
    try {
      this.state.candles = await this.client.getKlines(
        this.config.symbol,
        this.config.timeframe || "15m",
        250,
      );
      this.log(`✅ ${this.state.candles.length} candles carregados`);
    } catch (e) {
      this.log(`⚠️ Erro ao carregar candles: ${e.message}`, "warn");
    }

    // Iniciar WebSocket de candles — ZERO polling REST
    this._startKlineStream();

    // Iniciar WebSocket de preço ao vivo
    this._startTickerStream();

    // Sincronizar posições UMA ÚNICA VEZ no início
    // Depois só atualiza quando uma ordem é executada (sem polling REST)
    await this.syncPositions();

    this.state.running = true;
    this.broadcast({ type: "bot_status", data: { running: true } });
    return { ok: true, msg: "Bot started" };
  }

  stop() {
    if (!this.state.running) return { ok: false, msg: "Not running" };

    this.client.closeAllStreams();

    this.state.running = false;
    this.log("⛔ Bot parado");
    this.broadcast({ type: "bot_status", data: { running: false } });
    return { ok: true, msg: "Bot stopped" };
  }

  // ── WebSocket Kline Stream ─────────────────────────────────────────────────
  _startKlineStream() {
    const symbol = this.config.symbol;
    const interval = this.config.timeframe || "15m";

    this.client.subscribeKline(symbol, interval, (candle) => {
      // Atualizar ou adicionar candle ao histórico
      const last = this.state.candles[this.state.candles.length - 1];

      if (last && last.openTime === candle.openTime) {
        // Atualizar vela atual (ainda aberta)
        this.state.candles[this.state.candles.length - 1] = candle;
      } else {
        // Nova vela
        this.state.candles.push(candle);
        if (this.state.candles.length > 300) this.state.candles.shift();
      }

      // Analisar sinal apenas quando a vela fecha (evita ruído)
      if (candle.closed) {
        this.log(`🕯️ Vela fechada @ $${candle.close.toFixed(2)}`);
        this._analyzeAndTrade();
      }

      // Broadcast candle atualizado para o painel
      this.broadcast({ type: "candle", data: candle });
    });
  }

  // ── WebSocket Ticker Stream ────────────────────────────────────────────────
  _startTickerStream() {
    this.client.subscribeTicker(this.config.symbol, (tick) => {
      const price = parseFloat(tick.c);
      this.broadcast({ type: "tick", data: { price, symbol: tick.s } });
    });
  }

  // ── Análise e Trading (chamado apenas no fechamento de vela) ──────────────
  async _analyzeAndTrade() {
    try {
      const signal = this.strategy.getSignal(this.state.candles);
      this.state.lastSignal = { ...signal, time: new Date().toISOString() };
      this.broadcast({ type: "signal", data: this.state.lastSignal });

      if (signal.signal === "NONE") return;

      // Verificar se ordens estão pausadas por ban
      if (this._ordersPaused) {
        this.log(
          "⏸️ Ordens pausadas (ban de IP ativo) — analisando mas não executando",
          "warn",
        );
        return;
      }

      // Cooldown entre trades
      const now = Date.now();
      if (now - this._lastTradeAt < this._tradeCooldown) {
        this.log(`⏳ Cooldown ativo, aguardando próxima janela`);
        return;
      }

      const canTrade = await this.checkRiskLimits();
      if (!canTrade) return;

      await this.executeSignal(signal);
      this._lastTradeAt = now;
    } catch (e) {
      this.log(`❌ Analyze error: ${e.message}`, "error");
    }
  }

  // ── Análise manual (botão ANALISAR no painel) ─────────────────────────────
  analyzeNow() {
    const signal = this.strategy.getSignal(this.state.candles);
    this.state.lastSignal = { ...signal, time: new Date().toISOString() };
    this.broadcast({ type: "signal", data: this.state.lastSignal });
    return signal;
  }

  // ── Risk Management ────────────────────────────────────────────────────────
  async checkRiskLimits() {
    if (this.state.positions.length >= this.config.maxOpenTrades) {
      this.log(
        `⛔ Máx. trades abertos (${this.config.maxOpenTrades}) atingido`,
      );
      return false;
    }

    try {
      const balance = await this.getCachedBalance();
      const dailyLimit = balance * 0.03;
      const todayPnl = this.getTodayPnl();

      if (todayPnl < -dailyLimit) {
        this.log(
          "⛔ Limite diário de perda (3%) atingido. Sem novas entradas.",
          "warn",
        );
        return false;
      }
    } catch (e) {
      const code = e.response?.status;
      if (code === 418 || code === 429) {
        this._pauseOrders(e.response?.data?.msg || e.message);
      } else {
        this.log(`⚠️ checkRiskLimits: ${e.message}`, "warn");
      }
      return false;
    }

    return true;
  }

  getTodayPnl() {
    const today = new Date().toDateString();
    return this.state.trades
      .filter(
        (t) => t.closeTime && new Date(t.closeTime).toDateString() === today,
      )
      .reduce((sum, t) => sum + (t.pnl || 0), 0);
  }

  // ── Posições (REST — apenas a cada 5min, não em loop curto) ──────────────
  async syncPositions() {
    try {
      const positions = await this.client.getPositions(this.config.symbol);
      this.state.positions = positions.map((p) => ({
        symbol: p.symbol,
        side: parseFloat(p.positionAmt) > 0 ? "LONG" : "SHORT",
        size: Math.abs(parseFloat(p.positionAmt)),
        entryPrice: parseFloat(p.entryPrice),
        markPrice: parseFloat(p.markPrice),
        pnl: parseFloat(p.unRealizedProfit),
        pnlPct: parseFloat(p.percentage || 0),
        leverage: parseInt(p.leverage),
      }));
      this.broadcast({ type: "positions", data: this.state.positions });
    } catch (e) {
      const detail = e.response?.data
        ? JSON.stringify(e.response.data)
        : e.message;
      this.log(`⚠️ Sync positions: ${detail}`, "warn");
    }
  }

  // ── Execução de Ordem ──────────────────────────────────────────────────────
  async executeSignal(signal) {
    try {
      const { symbol } = this.config;
      const balance = await this.getCachedBalance();
      const size = this.calcPositionSize(balance, signal);

      if (size <= 0) {
        this.log(
          "⚠️ Tamanho de posição inválido (saldo insuficiente?)",
          "warn",
        );
        return;
      }

      this.log(
        `📊 Sinal: ${signal.signal} | Score: ${signal.score}/${signal.maxScore || 10} | Preço: $${signal.price}`,
      );
      this.log(`   Razões: ${signal.reasons.join(", ")}`);

      const side = signal.signal === "LONG" ? "BUY" : "SELL";
      await this.client.placeMarketOrder(symbol, side, size);
      this.log(
        `✅ Ordem executada: ${side} ${size} ${symbol} @ ~$${signal.price}`,
      );

      await this.placeSLTP(symbol, signal, size);

      const trade = {
        id: uuidv4(),
        symbol,
        side: signal.signal,
        size,
        entryPrice: signal.price,
        stopLoss: signal.stopLoss,
        takeProfit: signal.takeProfit,
        score: signal.score,
        reasons: signal.reasons,
        openTime: new Date().toISOString(),
        status: "OPEN",
      };
      this.state.trades.unshift(trade);
      this.state.stats.totalTrades++;
      this._balanceFetchedAt = 0;
      this.broadcast({ type: "trade_opened", data: trade });
      await this.syncPositions();
    } catch (e) {
      const code = e.response?.status;
      const msg = e.response?.data?.msg || e.message;

      // Ban de IP (418) ou rate limit (429)
      if (code === 418 || code === 429) {
        this._pauseOrders(msg);
        return;
      }

      this.log(`❌ Execute error: ${msg}`, "error");
    }
  }

  async placeSLTP(symbol, signal, size) {
    const slSide = signal.signal === "LONG" ? "SELL" : "BUY";
    let slOk = false;
    let tpOk = false;

    try {
      await this.client.placeStopOrder(symbol, slSide, size, signal.stopLoss);
      this.log(`🛑 Stop Loss @ $${signal.stopLoss}`);
      slOk = true;
    } catch (e) {
      this.log(`⚠️ SL error: ${e.message}`, "warn");
    }

    try {
      await this.client.placeTakeProfitOrder(
        symbol,
        slSide,
        size,
        signal.takeProfit,
      );
      this.log(`🎯 Take Profit @ $${signal.takeProfit}`);
      tpOk = true;
    } catch (e) {
      this.log(`⚠️ TP error: ${e.message}`, "warn");
    }

    if (!slOk) {
      this.log(
        `🚨 ATENÇÃO: Stop Loss NÃO foi colocado! Posição ${symbol} está desprotegida. Feche manualmente se necessário.`,
        "error",
      );
    }

    return { slOk, tpOk };
  }

  calcPositionSize(balance, signal) {
    const riskAmount = balance * (this.config.riskPerTrade / 100);
    const price = signal.price;
    if (!price || price <= 0) return 0;
    let size = (riskAmount * this.config.leverage) / price;
    size = Math.floor(size * 1000) / 1000;
    return size;
  }

  // Saldo com cache — evita chamada REST repetida
  async getCachedBalance() {
    const now = Date.now();
    if (now - this._balanceFetchedAt < this._balanceTTL)
      return this._balanceCache;
    const balances = await this.client.getBalance();
    const usdt = balances.find((b) => b.asset === "USDT");
    this._balanceCache = usdt ? parseFloat(usdt.availableBalance) : 0;
    this._balanceFetchedAt = now;
    return this._balanceCache;
  }

  // ── Ordem Manual ───────────────────────────────────────────────────────────
  async placeManualOrder(params) {
    const { symbol, side, quantity, stopLoss, takeProfit } = params;
    await this.client.placeMarketOrder(symbol, side, quantity);
    if (stopLoss) {
      const sl = side === "BUY" ? "SELL" : "BUY";
      await this.client.placeStopOrder(symbol, sl, quantity, stopLoss);
    }
    if (takeProfit) {
      const tp = side === "BUY" ? "SELL" : "BUY";
      await this.client.placeTakeProfitOrder(symbol, tp, quantity, takeProfit);
    }
    this.log(`📋 Ordem manual: ${side} ${quantity} ${symbol}`);
    await this.syncPositions();
  }

  async closeAllPositions() {
    for (const pos of this.state.positions) {
      await this.client.closePosition(pos.symbol, pos.side, pos.size);
      this.log(`🔒 Posição fechada: ${pos.side} ${pos.symbol}`);
    }
    await this.client.cancelAllOrders(this.config.symbol);
    await this.syncPositions();
  }

  // ── Pausa por ban de IP ────────────────────────────────────────────────────
  _pauseOrders(msg) {
    if (this._ordersPaused) return; // já está pausado, não duplicar timer
    const banMatch = (msg || "").match(/banned until (\d+)/);
    const banTs = banMatch ? parseInt(banMatch[1]) : 0;
    const banUntil = banTs
      ? new Date(banTs).toLocaleTimeString("pt-BR")
      : "?";
    // Usa o tempo real do ban + 30s de margem; mínimo 11 min
    const pauseMs = banTs
      ? Math.max(banTs - Date.now() + 30_000, 11 * 60 * 1000)
      : 11 * 60 * 1000;
    const pauseMin = Math.ceil(pauseMs / 60_000);
    this.log(
      `🚫 IP banido pela Binance até ${banUntil}. Ordens pausadas por ${pauseMin} min — WebSocket continua ativo.`,
      "error",
    );
    this._ordersPaused = true;
    this._ordersPausedAt = Date.now();
    setTimeout(() => {
      this._ordersPaused = false;
      this.log("✅ Pausa de ordens encerrada — bot voltando ao normal", "info");
    }, pauseMs);
  }

  // ── Helpers ────────────────────────────────────────────────────────────────
  log(msg, level = "info") {
    logger[level](msg);
    const entry = { time: new Date().toISOString(), msg, level };
    this.state.logs.unshift(entry);
    if (this.state.logs.length > 200) this.state.logs.pop();
    this.broadcast({ type: "log", data: entry });
  }

  getSafeState() {
    return {
      running: this.state.running,
      positions: this.state.positions,
      trades: this.state.trades.slice(0, 50),
      lastSignal: this.state.lastSignal,
      stats: this.state.stats,
      logs: this.state.logs.slice(0, 50),
      candlesCount: this.state.candles.length,
    };
  }

  getState() {
    return this.getSafeState();
  }
  getCandles() {
    return this.state.candles;
  }
  updateConfig(cfg) {
    this.config = { ...this.config, ...cfg };
    this.log(`⚙️ Config atualizada`);
  }
}

module.exports = TradingBot;
