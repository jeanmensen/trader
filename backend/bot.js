// bot.js - Trading Bot Engine
// Usa WebSocket para candles. REST apenas para ordens e saldo (não em loop).
const { v4: uuidv4 } = require("uuid");
const logger = require("./logger");
const ConservativeStrategy = require("./strategy");

class TradingBot {
  constructor(binanceClient, config, broadcastFn, tradeStore = null) {
    this.client = binanceClient;
    this.config = config;
    this.broadcast = broadcastFn || (() => {});
    this.tradeStore = tradeStore;
    this.config.scanSymbols = this._normalizeSymbolList(config.scanSymbols);
    this.strategy = new ConservativeStrategy(config);
    this._symbolSetupDone = new Set();

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
    this._balanceTotalCache = 0;
    this._balanceFetchedAt = 0;
    this._balanceTTL = 60000; // 60s

    // Cooldown entre trades (evita entrar 2x no mesmo sinal)
    this._lastTradeAt = 0;
    this._tradeCooldown = 5 * 60 * 1000; // 5 minutos

    // Pausa de ordens por ban de IP
    this._ordersPaused = false;
    this._ordersPausedAt = 0;

    // Cache de PnL realizado diário (Binance income endpoint)
    this._todayStatsCache = { pnl: 0, wins: 0, losses: 0 };
    this._todayPnlFetchedAt = 0;
    this._todayPnlTTL = 60000; // 60s

    // Fallback quando Binance retorna -4120 para SL/TP nativo.
    this._nativeConditionalSupported = true;
    this._syntheticProtections = new Map();
    this._syntheticClosing = new Set();
  }

  _normalizeSymbolList(input) {
    const raw = Array.isArray(input)
      ? input
      : typeof input === "string"
        ? input.split(",")
        : [];
    const unique = new Set();
    for (const item of raw) {
      const sym = String(item || "")
        .trim()
        .toUpperCase();
      if (sym) unique.add(sym);
    }
    if (this.config.symbol) unique.add(String(this.config.symbol).toUpperCase());
    return [...unique];
  }

  _getScanSymbols() {
    const watchlist = this._normalizeSymbolList(this.config.scanSymbols);
    if (!watchlist.length && this.config.symbol) {
      return [String(this.config.symbol).toUpperCase()];
    }
    return watchlist;
  }

  _getTrackedSymbols() {
    const set = new Set(this._getScanSymbols());
    for (const t of this.state.trades) {
      if (t?.status === "OPEN" && t.symbol) set.add(String(t.symbol).toUpperCase());
    }
    for (const p of this.state.positions) {
      if (p?.symbol) set.add(String(p.symbol).toUpperCase());
    }
    for (const symbol of this._syntheticProtections.keys()) set.add(symbol);
    return [...set];
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────
  async start() {
    if (this.state.running) return { ok: false, msg: "Already running" };
    this.log("🚀 Bot iniciado - Estratégia Conservadora");

    if (this.tradeStore) {
      try {
        await this.tradeStore.init();
        const persisted = await this.tradeStore.loadRecent(200);
        if (persisted.length) this.state.trades = persisted;
      } catch (e) {
        this.log(`⚠️ Persistência trade history: ${e.message}`, "warn");
      }
    }

    // Sincronizar relógio com Binance primeiro (evita erro -1021)
    await this.client.syncTime();

    // Setup de alavancagem/margem do símbolo padrão
    await this._ensureSymbolSetup(this.config.symbol);

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
    await this._refreshSessionStats();

    this.state.running = true;
    this.broadcast({ type: "bot_status", data: { running: true } });
    this._broadcastState();
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
    if (typeof this.client.closeStreamsByPrefix === "function") {
      this.client.closeStreamsByPrefix("kline_");
    }
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
      this.broadcast({
        type: "candle",
        data: { ...candle, symbol, interval },
      });
    });
  }

  // ── WebSocket Ticker Stream ────────────────────────────────────────────────
  _startTickerStream() {
    if (typeof this.client.closeStreamsByPrefix === "function") {
      this.client.closeStreamsByPrefix("ticker_");
    }
    const symbols = this._getTrackedSymbols();
    for (const symbol of symbols) {
      this.client.subscribeTicker(symbol, (tick) => {
        const price = parseFloat(tick.c);
        this.broadcast({ type: "tick", data: { price, symbol: tick.s } });
        this._checkSyntheticProtection(tick.s, price).catch((e) =>
          this.log(`⚠️ Synthetic protection error: ${e.message}`, "warn"),
        );
      });
    }
  }

  // ── Análise e Trading (chamado apenas no fechamento de vela) ──────────────
  async _analyzeAndTrade() {
    try {
      const best = await this._findBestSignalOpportunity();
      this.state.lastSignal = { ...best.signal, symbol: best.symbol, time: new Date().toISOString() };
      this.broadcast({ type: "signal", data: this.state.lastSignal });

      if (best.signal.signal === "NONE") {
        this.log(`ℹ️ Sem entrada: ${best.signal.reason || "sinal NONE"}`);
        return;
      }

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

      const executed = await this.executeSignal(best.signal, best.symbol);
      if (executed) this._lastTradeAt = now;
    } catch (e) {
      this.log(`❌ Analyze error: ${e.message}`, "error");
    }
  }

  async _findBestSignalOpportunity() {
    const timeframe = this.config.timeframe || "15m";
    const symbols = this._getScanSymbols();
    let best = null;

    for (const symbol of symbols) {
      try {
        let candles = [];
        if (
          symbol === String(this.config.symbol).toUpperCase() &&
          Array.isArray(this.state.candles) &&
          this.state.candles.length >= 210
        ) {
          candles = this.state.candles;
        } else {
          candles = await this.client.getKlines(symbol, timeframe, 250);
        }

        const signal = this.strategy.getSignal(candles);
        if (!signal || signal.signal === "NONE") continue;

        if (
          !best ||
          (signal.score || 0) > (best.signal.score || 0) ||
          ((signal.score || 0) === (best.signal.score || 0) &&
            Number(signal.indicators?.volRatio || 0) >
              Number(best.signal.indicators?.volRatio || 0))
        ) {
          best = { symbol, signal };
        }
      } catch (e) {
        this.log(`⚠️ Scan ${symbol}: ${e.response?.data?.msg || e.message}`, "warn");
      }
    }

    if (!best) {
      return {
        symbol: String(this.config.symbol).toUpperCase(),
        signal: {
          signal: "NONE",
          reason: "Nenhum ativo da watchlist com score mínimo para entrada",
        },
      };
    }

    return best;
  }

  async _ensureSymbolSetup(symbol) {
    const sym = String(symbol || "").toUpperCase();
    if (!sym || this._symbolSetupDone.has(sym)) return;
    try {
      await this.client.setLeverage(sym, this.config.leverage);
      await this.client.setMarginType(sym, "ISOLATED");
      this._symbolSetupDone.add(sym);
      this.log(`✅ Setup ${sym}: ${this.config.leverage}x | ISOLATED`);
    } catch (e) {
      this.log(`⚠️ Setup ${sym}: ${e.response?.data?.msg || e.message}`, "warn");
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
      const totalBalance = await this.getCachedTotalBalance();
      const dailyBase = totalBalance > 0 ? totalBalance : balance;
      const dailyLimit = dailyBase * 0.03;
      const todayStats = await this.getTodayRealizedStats();
      const todayPnl = todayStats.pnl;
      this.state.stats.pnl = todayStats.pnl;
      this.state.stats.wins = todayStats.wins;
      this.state.stats.losses = todayStats.losses;
      this.state.stats.totalTrades = Math.max(
        this.state.stats.totalTrades,
        todayStats.wins + todayStats.losses,
      );

      if (todayPnl < -dailyLimit) {
        this.log(
          `⛔ Limite diário de perda (3%) atingido. PnL: $${todayPnl.toFixed(2)} | Limite: -$${dailyLimit.toFixed(2)}.`,
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

  async getTodayRealizedStats() {
    const now = Date.now();
    if (now - this._todayPnlFetchedAt < this._todayPnlTTL)
      return this._todayStatsCache;

    const symbols = this._getTrackedSymbols();
    const incomes = [];
    for (const symbol of symbols) {
      try {
        const rows = await this.client.getIncomeHistory(symbol, "REALIZED_PNL", 200);
        incomes.push(...rows);
      } catch (e) {
        this.log(`⚠️ PnL ${symbol}: ${e.response?.data?.msg || e.message}`, "warn");
      }
    }

    const today = new Date().toISOString().slice(0, 10);
    const seen = new Set();
    const todayIncomes = incomes
      .filter((i) => {
        if (!i?.time) return false;
        const d = new Date(i.time).toISOString().slice(0, 10);
        if (d !== today) return false;
        const key = `${i.tranId || ""}_${i.time}_${i.income}_${i.symbol || ""}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    const pnl = todayIncomes.reduce(
      (sum, i) => sum + parseFloat(i.income || 0),
      0,
    );
    const wins = todayIncomes.filter((i) => parseFloat(i.income || 0) > 0)
      .length;
    const losses = todayIncomes.filter((i) => parseFloat(i.income || 0) < 0)
      .length;

    this._todayStatsCache = { pnl, wins, losses };
    this._todayPnlFetchedAt = now;
    return this._todayStatsCache;
  }

  // ── Posições (REST — apenas a cada 5min, não em loop curto) ──────────────
  async syncPositions() {
    try {
      const symbols = this._getTrackedSymbols();
      const all = [];
      for (const symbol of symbols) {
        try {
          const positions = await this.client.getPositions(symbol);
          all.push(
            ...positions.map((p) => ({
              symbol: p.symbol,
              side: parseFloat(p.positionAmt) > 0 ? "LONG" : "SHORT",
              size: Math.abs(parseFloat(p.positionAmt)),
              entryPrice: parseFloat(p.entryPrice),
              markPrice: parseFloat(p.markPrice),
              pnl: parseFloat(p.unRealizedProfit),
              pnlPct: parseFloat(p.percentage || 0),
              leverage: parseInt(p.leverage),
            })),
          );
        } catch (e) {
          this.log(
            `⚠️ Sync ${symbol}: ${e.response?.data?.msg || e.message}`,
            "warn",
          );
        }
      }
      this.state.positions = all;
      const openSymbols = new Set(this.state.positions.map((p) => p.symbol));
      for (const symbol of this._syntheticProtections.keys()) {
        if (!openSymbols.has(symbol)) this._syntheticProtections.delete(symbol);
      }
      this._ensureSyntheticProtectionForOpenPositions();
      await this._refreshSessionStats();
      this.broadcast({ type: "positions", data: this.state.positions });
      this._broadcastState();
    } catch (e) {
      const code = e.response?.status;
      if (code === 418 || code === 429) {
        this._pauseOrders(e.response?.data?.msg || e.message);
      }
      const detail = e.response?.data ? JSON.stringify(e.response.data) : e.message;
      this.log(`⚠️ Sync positions: ${detail}`, "warn");
    }
  }

  // ── Execução de Ordem ──────────────────────────────────────────────────────
  async executeSignal(signal, targetSymbol = this.config.symbol) {
    try {
      const symbol = String(targetSymbol || this.config.symbol).toUpperCase();
      const balance = await this.getCachedBalance();
      const size = this.calcPositionSize(balance, signal);

      if (size <= 0) {
        this.log(
          "⚠️ Tamanho de posição inválido (saldo insuficiente?)",
          "warn",
        );
        return false;
      }

      this.log(
        `📊 Sinal: ${signal.signal} | Score: ${signal.score}/${signal.maxScore || 10} | Preço: $${signal.price}`,
      );
      if (symbol !== String(this.config.symbol).toUpperCase()) {
        this.log(`🎯 Melhor oportunidade detectada em ${symbol}`);
      }
      this.log(`   Razões: ${signal.reasons.join(", ")}`);

      await this._ensureSymbolSetup(symbol);
      const side = signal.signal === "LONG" ? "BUY" : "SELL";
      await this.client.placeMarketOrder(symbol, side, size);
      this.log(
        `✅ Ordem executada: ${side} ${size} ${symbol} @ ~$${signal.price}`,
      );

      await this.placeSLTP(symbol, signal);

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
      if (this.tradeStore) await this.tradeStore.insertOpenTrade(trade);
      this._balanceFetchedAt = 0;
      this._todayPnlFetchedAt = 0;
      this.broadcast({ type: "trade_opened", data: trade });
      await this.syncPositions();
      this._broadcastState();
      return true;
    } catch (e) {
      const code = e.response?.status;
      const msg = e.response?.data?.msg || e.message;

      // Ban de IP (418) ou rate limit (429)
      if (code === 418 || code === 429) {
        this._pauseOrders(msg);
        return false;
      }

      this.log(`❌ Execute error: ${msg}`, "error");
      return false;
    }
  }

  async placeSLTP(symbol, signal) {
    if (!this._nativeConditionalSupported) {
      this._armSyntheticProtection(
        symbol,
        signal.signal,
        signal.stopLoss,
        signal.takeProfit,
      );
      return { slOk: false, tpOk: false, synthetic: true };
    }

    const slSide = signal.signal === "LONG" ? "SELL" : "BUY";
    let slOk = false;
    let tpOk = false;
    let unsupportedAlgo = false;

    try {
      await this.client.placeStopOrder(symbol, slSide, signal.stopLoss);
      this.log(`🛑 Stop Loss @ $${signal.stopLoss}`);
      slOk = true;
    } catch (e) {
      this.log(`⚠️ SL error (${symbol}): ${this._formatApiError(e)}`, "warn");
      if (this._isConditionalUnsupported(e)) unsupportedAlgo = true;
    }

    try {
      await this.client.placeTakeProfitOrder(
        symbol,
        slSide,
        signal.takeProfit,
      );
      this.log(`🎯 Take Profit @ $${signal.takeProfit}`);
      tpOk = true;
    } catch (e) {
      this.log(`⚠️ TP error (${symbol}): ${this._formatApiError(e)}`, "warn");
      if (this._isConditionalUnsupported(e)) unsupportedAlgo = true;
    }

    if (unsupportedAlgo) {
      this._nativeConditionalSupported = false;
      this._armSyntheticProtection(
        symbol,
        signal.signal,
        signal.stopLoss,
        signal.takeProfit,
      );
      this.log(
        "🛡️ Binance retornou -4120. SL/TP nativo desativado e proteção sintética ativada.",
        "warn",
      );
    }

    if (!slOk && !unsupportedAlgo) {
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
    const slDistance = Math.abs(signal.price - signal.stopLoss);
    if (!price || price <= 0) return 0;

    if (!slDistance || slDistance <= 0) return 0;

    // Quantidade baseada em risco real até o stop
    const riskBasedQty = riskAmount / slDistance;
    // Limite de notional pela margem disponível e alavancagem
    const maxQtyByMargin = (balance * this.config.leverage) / price;
    let size = Math.min(riskBasedQty, maxQtyByMargin);
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
    this._balanceTotalCache = usdt ? parseFloat(usdt.balance) : this._balanceCache;
    this._balanceFetchedAt = now;
    return this._balanceCache;
  }

  async getCachedTotalBalance() {
    const now = Date.now();
    if (now - this._balanceFetchedAt < this._balanceTTL)
      return this._balanceTotalCache || this._balanceCache;
    await this.getCachedBalance();
    return this._balanceTotalCache || this._balanceCache;
  }

  // ── Ordem Manual ───────────────────────────────────────────────────────────
  async placeManualOrder(params) {
    const { symbol, side, quantity, stopLoss, takeProfit } = params;
    await this.client.placeMarketOrder(symbol, side, quantity);
    const tradeSide = side === "BUY" ? "LONG" : "SHORT";
    let unsupportedAlgo = false;

    if (this._nativeConditionalSupported && stopLoss) {
      try {
        const sl = side === "BUY" ? "SELL" : "BUY";
        await this.client.placeStopOrder(symbol, sl, stopLoss);
      } catch (e) {
        this.log(`⚠️ SL manual error: ${this._formatApiError(e)}`, "warn");
        if (this._isConditionalUnsupported(e)) unsupportedAlgo = true;
      }
    }
    if (this._nativeConditionalSupported && takeProfit) {
      try {
        const tp = side === "BUY" ? "SELL" : "BUY";
        await this.client.placeTakeProfitOrder(symbol, tp, takeProfit);
      } catch (e) {
        this.log(`⚠️ TP manual error: ${this._formatApiError(e)}`, "warn");
        if (this._isConditionalUnsupported(e)) unsupportedAlgo = true;
      }
    }
    if (unsupportedAlgo) this._nativeConditionalSupported = false;
    if (!this._nativeConditionalSupported && (stopLoss || takeProfit)) {
      this._armSyntheticProtection(symbol, tradeSide, stopLoss, takeProfit);
    }

    this.log(`📋 Ordem manual: ${side} ${quantity} ${symbol}`);
    await this.syncPositions();
  }

  _formatApiError(err) {
    const status = err?.response?.status;
    const code = err?.response?.data?.code;
    const msg = err?.response?.data?.msg || err?.message || "unknown error";
    const parts = [];
    if (status) parts.push(`status=${status}`);
    if (code !== undefined) parts.push(`code=${code}`);
    parts.push(`msg=${msg}`);
    return parts.join(" | ");
  }

  _isConditionalUnsupported(err) {
    return err?.response?.data?.code === -4120;
  }

  _armSyntheticProtection(symbol, tradeSide, stopLoss, takeProfit) {
    this._syntheticProtections.set(symbol, {
      side: tradeSide,
      stopLoss: stopLoss ?? null,
      takeProfit: takeProfit ?? null,
      armedAt: Date.now(),
    });
    this.log(
      `🛡️ Proteção sintética armada ${symbol} (${tradeSide}) SL=${stopLoss ?? "-"} TP=${takeProfit ?? "-"}`,
      "warn",
    );
  }

  async _checkSyntheticProtection(symbol, price) {
    const prot = this._syntheticProtections.get(symbol);
    if (!prot || !Number.isFinite(price)) return;
    if (this._syntheticClosing.has(symbol)) return;

    const isLong = prot.side === "LONG";
    const hitSL =
      prot.stopLoss !== null &&
      ((isLong && price <= prot.stopLoss) || (!isLong && price >= prot.stopLoss));
    const hitTP =
      prot.takeProfit !== null &&
      ((isLong && price >= prot.takeProfit) || (!isLong && price <= prot.takeProfit));
    if (!hitSL && !hitTP) return;

    this._syntheticClosing.add(symbol);
    try {
      let pos = this.state.positions.find((p) => p.symbol === symbol);
      if (!pos) {
        await this.syncPositions();
        pos = this.state.positions.find((p) => p.symbol === symbol);
      }
      if (!pos) {
        this._syntheticProtections.delete(symbol);
        return;
      }

      const reason = hitSL ? "SL" : "TP";
      this.log(`🚨 Proteção sintética acionada (${reason}) ${symbol} @ ~$${price}`, "warn");
      await this.closePosition(
        pos.symbol,
        pos.side,
        pos.size,
        hitSL ? "SYNTHETIC_SL" : "SYNTHETIC_TP",
      );
      this._syntheticProtections.delete(symbol);
    } finally {
      this._syntheticClosing.delete(symbol);
    }
  }

  _ensureSyntheticProtectionForOpenPositions() {
    for (const pos of this.state.positions) {
      if (this._syntheticProtections.has(pos.symbol)) continue;

      const openTrade = this.state.trades.find(
        (t) => t.status === "OPEN" && t.symbol === pos.symbol && t.side === pos.side,
      );

      let stopLoss = openTrade?.stopLoss ?? null;
      let takeProfit = openTrade?.takeProfit ?? null;

      if (stopLoss === null || takeProfit === null) {
        const slPct = parseFloat(this.config.stopLossPct || 0);
        const tpPct = parseFloat(this.config.takeProfitPct || 0);
        if (slPct > 0 && tpPct > 0 && pos.entryPrice > 0) {
          const slMult = slPct / 100;
          const tpMult = tpPct / 100;
          if (pos.side === "LONG") {
            stopLoss = +(pos.entryPrice * (1 - slMult)).toFixed(2);
            takeProfit = +(pos.entryPrice * (1 + tpMult)).toFixed(2);
          } else {
            stopLoss = +(pos.entryPrice * (1 + slMult)).toFixed(2);
            takeProfit = +(pos.entryPrice * (1 - tpMult)).toFixed(2);
          }
        }
      }

      if (stopLoss === null && takeProfit === null) continue;

      this._armSyntheticProtection(pos.symbol, pos.side, stopLoss, takeProfit);

      // Se já estiver no gatilho no momento da sincronização, fecha imediatamente.
      const refPrice = Number.isFinite(pos.markPrice) ? pos.markPrice : pos.entryPrice;
      this._checkSyntheticProtection(pos.symbol, refPrice).catch((e) =>
        this.log(`⚠️ Synthetic protection error: ${e.message}`, "warn"),
      );
    }
  }

  async closeAllPositions() {
    const cancelSymbols = new Set();
    for (const pos of this.state.positions) {
      const exitPrice = Number.isFinite(pos.markPrice) ? pos.markPrice : null;
      await this.client.closePosition(pos.symbol, pos.side, pos.size);
      await this._markTradeClosed(pos.symbol, pos.side, exitPrice, "MANUAL_CLOSE_ALL");
      this.log(`🔒 Posição fechada: ${pos.side} ${pos.symbol}`);
      cancelSymbols.add(pos.symbol);
      this._syntheticProtections.delete(pos.symbol);
      this._syntheticClosing.delete(pos.symbol);
    }
    for (const symbol of cancelSymbols) {
      await this.client.cancelAllOrders(symbol);
    }
    await this.syncPositions();
    this._broadcastState();
  }

  async closePosition(symbol, side, size, closeReason = "MANUAL_CLOSE") {
    const pos = this.state.positions.find((p) => p.symbol === symbol && p.side === side);
    const exitPrice = pos && Number.isFinite(pos.markPrice) ? pos.markPrice : null;
    await this.client.closePosition(symbol, side, size);
    await this._markTradeClosed(symbol, side, exitPrice, closeReason);
    this.log(`🔒 Posição fechada: ${side} ${symbol}`);
    await this.client.cancelAllOrders(symbol);
    this._syntheticProtections.delete(symbol);
    this._syntheticClosing.delete(symbol);
    this._balanceFetchedAt = 0;
    this._todayPnlFetchedAt = 0;
    await this.syncPositions();
    this._broadcastState();
  }

  async _markTradeClosed(symbol, side, closePrice, closeReason) {
    const openTrade = this.state.trades.find(
      (t) => t.status === "OPEN" && t.symbol === symbol && t.side === side,
    );
    if (!openTrade) return;

    const cp = Number.isFinite(closePrice) ? closePrice : openTrade.entryPrice;
    const pnl =
      side === "LONG"
        ? (cp - openTrade.entryPrice) * openTrade.size
        : (openTrade.entryPrice - cp) * openTrade.size;

    openTrade.closeTime = new Date().toISOString();
    openTrade.closePrice = cp;
    openTrade.closeReason = closeReason;
    openTrade.pnl = +pnl.toFixed(8);
    openTrade.status = "CLOSED";

    if (this.tradeStore) await this.tradeStore.closeTrade(openTrade);
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

  async _refreshSessionStats() {
    try {
      const todayStats = await this.getTodayRealizedStats();
      this.state.stats.pnl = todayStats.pnl;
      this.state.stats.wins = todayStats.wins;
      this.state.stats.losses = todayStats.losses;
      this.state.stats.totalTrades = Math.max(
        this.state.stats.totalTrades,
        todayStats.wins + todayStats.losses,
      );
    } catch (e) {
      // stats é auxiliar de painel; não deve bloquear o fluxo principal
    }
  }

  _broadcastState() {
    this.broadcast({ type: "state", data: this.getSafeState() });
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
  async updateConfig(cfg) {
    const prevSymbol = this.config.symbol;
    const prevTimeframe = this.config.timeframe;
    const prevLeverage = this.config.leverage;
    const prevScan = this._normalizeSymbolList(this.config.scanSymbols).join(",");
    this.config = { ...this.config, ...cfg };
    this.config.scanSymbols = this._normalizeSymbolList(this.config.scanSymbols);
    const nextScan = this.config.scanSymbols.join(",");
    this.strategy = new ConservativeStrategy(this.config);
    if (prevLeverage !== this.config.leverage) {
      this._symbolSetupDone.clear();
    }

    const symbolChanged = prevSymbol !== this.config.symbol;
    const timeframeChanged = prevTimeframe !== this.config.timeframe;
    const scanChanged = prevScan !== nextScan;
    if (this.state.running && (symbolChanged || timeframeChanged)) {
      this.log(
        `🔄 Reiniciando streams (${prevSymbol} ${prevTimeframe} -> ${this.config.symbol} ${this.config.timeframe})`,
      );
      try {
        this.state.candles = await this.client.getKlines(
          this.config.symbol,
          this.config.timeframe || "15m",
          250,
        );
      } catch (e) {
        this.log(`⚠️ Erro ao recarregar candles: ${e.message}`, "warn");
      }
      this._startKlineStream();
      if (symbolChanged) {
        this._startTickerStream();
        this._syntheticProtections.clear();
        this._syntheticClosing.clear();
        await this.syncPositions();
      }
    }
    if (this.state.running && scanChanged && !symbolChanged) {
      this._startTickerStream();
    }
    await this._ensureSymbolSetup(this.config.symbol);
    this.log(`⚙️ Config atualizada`);
  }
}

module.exports = TradingBot;
