// bot.js - Multi-Symbol Mosaic Signal Advisor
// Monitora N ativos simultaneamente, gerando sinais independentes por símbolo.
const logger = require("./logger");
const ConservativeStrategy = require("./strategy");

const DEFAULT_SYMBOLS = [
  "BTCUSDT","ETHUSDT","XRPUSDT","SOLUSDT","ADAUSDT",
  "XLMUSDT","LINKUSDT","HBARUSDT","BCHUSDT","AVAXUSDT",
  "LTCUSDT","DOTUSDT","UNIUSDT","AAVEUSDT","NEARUSDT",
  "ETCUSDT","ALGOUSDT","ATOMUSDT","POLUSDT","ARBUSDT",
  "QNTUSDT","TIAUSDT","OPUSDT","IMXUSDT","GRTUSDT",
  "LDOUSDT","XTZUSDT",
];

class SignalAdvisor {
  constructor(binanceClient, config, broadcastFn, notifier = null) {
    this.client = binanceClient;
    this.config = config;
    this.broadcast = broadcastFn || (() => {});
    this.notifier = notifier;
    this.strategy = new ConservativeStrategy(config);
    this.symbols = this._buildSymbolList();
    this.lastAlertMap = {};

    this.state = {
      running: false,
      candlesMap: {},  // symbol -> candle[]
      signalsMap: {},  // symbol -> latest signal result
      priceMap: {},    // symbol -> current price
      stats: { totalSignals: 0, longSignals: 0, shortSignals: 0 },
      logs: [],
    };

    for (const sym of this.symbols) {
      this.state.candlesMap[sym] = [];
      this.state.signalsMap[sym] = null;
      this.state.priceMap[sym] = null;
    }
  }

  _buildSymbolList() {
    const extra = Array.isArray(this.config.scanSymbols)
      ? this.config.scanSymbols.map((s) => String(s).toUpperCase().trim()).filter(Boolean)
      : DEFAULT_SYMBOLS;
    const set = new Set(extra.length ? extra : DEFAULT_SYMBOLS);
    return [...set];
  }

  _resetSymbolState(symbols) {
    this.state.candlesMap = {};
    this.state.signalsMap = {};
    this.state.priceMap = {};
    for (const sym of symbols) {
      this.state.candlesMap[sym] = [];
      this.state.signalsMap[sym] = null;
      this.state.priceMap[sym] = null;
    }
  }

  async _reloadSymbols() {
    this.symbols = this._buildSymbolList();
    this._resetSymbolState(this.symbols);

    if (typeof this.client.closeAllStreams === "function") {
      this.client.closeAllStreams();
    }

    for (const sym of this.symbols) {
      try {
        this.state.candlesMap[sym] = await this.client.getKlines(
          sym,
          this.config.timeframe || "4h",
          250,
        );
        this._analyzeSymbol(sym);
      } catch (e) {
        this.log(`⚠️ ${sym}: erro ao carregar ativo`, "warn");
      }
    }

    for (const sym of this.symbols) {
      this._startKlineStream(sym);
      this.client.subscribeTicker(sym, (tick) => {
        const price = parseFloat(tick.c);
        this.state.priceMap[sym] = price;
        this.broadcast({ type: "tick", data: { symbol: sym, price } });
      });
    }

    this._broadcastMosaicState();
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────
  async start() {
    if (this.state.running) return { ok: false, msg: "Already running" };
    this.log(`🚀 Mosaic Advisor iniciado — ${this.symbols.length} ativos`);

    await this.client.syncTime();

    // Carregar candles de cada ativo sequencialmente (respeita rate limit)
    this.log(`📥 Carregando histórico para ${this.symbols.length} ativos...`);
    for (const sym of this.symbols) {
      try {
        const candles = await this.client.getKlines(sym, this.config.timeframe || "1h", 250);
        this.state.candlesMap[sym] = candles;
        this._analyzeSymbol(sym); // análise inicial
      } catch (e) {
        this.log(`⚠️ ${sym}: ${e.response?.data?.msg || e.message}`, "warn");
      }
    }
    this.log(`✅ Histórico carregado`);

    // Iniciar stream de kline para cada ativo
    for (const sym of this.symbols) {
      this._startKlineStream(sym);
    }

    // Iniciar stream de preço ao vivo para cada ativo
    for (const sym of this.symbols) {
      this.client.subscribeTicker(sym, (tick) => {
        const price = parseFloat(tick.c);
        this.state.priceMap[sym] = price;
        this.broadcast({ type: "tick", data: { symbol: sym, price } });
      });
    }

    this.state.running = true;
    this.broadcast({ type: "bot_status", data: { running: true } });
    this._broadcastMosaicState();
    return { ok: true, msg: "Advisor started" };
  }

  stop() {
    if (!this.state.running) return { ok: false, msg: "Not running" };
    this.client.closeAllStreams();
    this.state.running = false;
    this.log("⛔ Advisor parado");
    this.broadcast({ type: "bot_status", data: { running: false } });
    return { ok: true, msg: "Advisor stopped" };
  }

  // ── WebSocket Kline por símbolo ────────────────────────────────────────────
  _startKlineStream(symbol) {
    const interval = this.config.timeframe || "1h";
    this.client.subscribeKline(symbol, interval, (candle) => {
      if (!this.state.candlesMap[symbol]) this.state.candlesMap[symbol] = [];
      const candles = this.state.candlesMap[symbol];
      const last = candles[candles.length - 1];

      if (last && last.openTime === candle.openTime) {
        candles[candles.length - 1] = candle;
      } else {
        candles.push(candle);
        if (candles.length > 300) candles.shift();
      }

      if (candle.closed) {
        this._analyzeSymbol(symbol);
      }

      this.broadcast({ type: "candle", data: { ...candle, symbol, interval } });
    });
  }

  // ── Análise de sinal por símbolo ───────────────────────────────────────────
  _analyzeSymbol(symbol) {
    const candles = this.state.candlesMap[symbol];
    if (!candles || candles.length < 210) return;

    try {
      const previousSignal = this.state.signalsMap[symbol];
      const signal = this.strategy.getSignal(candles);
      const lastCandle = candles[candles.length - 1];
      const signalData = {
        ...signal,
        symbol,
        time: new Date().toISOString(),
        price: this.state.priceMap[symbol] || lastCandle?.close,
        candlesCount: candles.length,
      };

      this.state.signalsMap[symbol] = signalData;
      this.broadcast({ type: "signal_update", data: signalData });

      if (signal.signal !== "NONE") {
        this.state.stats.totalSignals++;
        if (signal.signal === "LONG") this.state.stats.longSignals++;
        else if (signal.signal === "SHORT") this.state.stats.shortSignals++;

        const emoji = signal.signal === "LONG" ? "📈" : "📉";
        this.log(
          `${emoji} SINAL: ${signal.signal} ${symbol} | Score: ${signal.score}/${signal.maxScore || 10} | $${signalData.price?.toFixed(4)}`,
        );
      }
      if (this._shouldSendTelegramAlert(previousSignal, signalData)) {
        this._notifyTelegram(signalData);
      }
    } catch (e) {
      this.log(`❌ Analyze ${symbol}: ${e.message}`, "error");
    }
  }

  // ── Broadcast do estado completo do mosaico ────────────────────────────────
  _shouldSendTelegramAlert(previousSignal, signalData) {
    if (!this.notifier || !signalData || signalData.signal === "NONE") return false;

    const alertKey = [
      signalData.symbol,
      signalData.signal,
      Number(signalData.price || 0).toFixed(8),
      Number(signalData.takeProfit || 0).toFixed(8),
      Number(signalData.stopLoss || 0).toFixed(8),
    ].join("|");

    const previousKey = this.lastAlertMap[signalData.symbol];
    const signalChanged =
      !previousSignal ||
      previousSignal.signal !== signalData.signal ||
      Number(previousSignal.takeProfit || 0) !== Number(signalData.takeProfit || 0) ||
      Number(previousSignal.stopLoss || 0) !== Number(signalData.stopLoss || 0);

    if (!signalChanged || previousKey === alertKey) return false;
    this.lastAlertMap[signalData.symbol] = alertKey;
    return true;
  }

  async _notifyTelegram(signalData) {
    const sent = await this.notifier.sendEntry(signalData);
    if (sent) this.log(`Telegram enviado para ${signalData.symbol}`);
  }

  _broadcastMosaicState() {
    this.broadcast({
      type: "mosaic_state",
      data: {
        signals: this.state.signalsMap,
        prices: this.state.priceMap,
        symbols: this.symbols,
        running: this.state.running,
        stats: this.state.stats,
        topOpportunities: this.getTopOpportunities(),
      },
    });
  }

  // ── Análise manual (botão ANALISAR) ───────────────────────────────────────
  analyzeNow() {
    for (const sym of this.symbols) {
      this._analyzeSymbol(sym);
    }
    this._broadcastMosaicState();
    return { analyzed: this.symbols.length };
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
      positions: [],
      trades: [],
      lastSignal: null,
      stats: this.state.stats,
      logs: this.state.logs.slice(0, 50),
      candlesCount: 0,
      symbols: this.symbols,
      signals: this.state.signalsMap,
      prices: this.state.priceMap,
      topOpportunities: this.getTopOpportunities(),
    };
  }

  getTopOpportunities(limit = 5) {
    return Object.values(this.state.signalsMap)
      .filter((signal) => signal && signal.signal !== "NONE")
      .sort((a, b) => {
        if ((b.score || 0) !== (a.score || 0)) return (b.score || 0) - (a.score || 0);
        return (b.riskReward || 0) - (a.riskReward || 0);
      })
      .slice(0, limit);
  }

  getState() { return this.getSafeState(); }

  getCandles() { return []; }

  async updateConfig(cfg) {
    const prevTimeframe = this.config.timeframe;
    const prevSymbols = JSON.stringify(this.symbols);
    this.config = { ...this.config, ...cfg };
    this.strategy = new ConservativeStrategy(this.config);
    const nextSymbols = this._buildSymbolList();
    const symbolsChanged = JSON.stringify(nextSymbols) !== prevSymbols;

    if (this.state.running && symbolsChanged) {
      this.log(`🔄 Ativos monitorados atualizados: ${nextSymbols.join(", ")}`);
      await this._reloadSymbols();
      this.log(`⚙️ Config atualizada`);
      return;
    }

    if (this.state.running && prevTimeframe !== this.config.timeframe) {
      this.log(`🔄 Timeframe alterado: ${prevTimeframe} → ${this.config.timeframe}`);
      if (typeof this.client.closeStreamsByPrefix === "function") {
        this.client.closeStreamsByPrefix("kline_");
      }
      for (const sym of this.symbols) {
        try {
          this.state.candlesMap[sym] = await this.client.getKlines(sym, this.config.timeframe, 250);
          this._analyzeSymbol(sym);
        } catch (e) {
          this.log(`⚠️ ${sym}: erro ao recarregar candles`, "warn");
        }
        this._startKlineStream(sym);
      }
      this._broadcastMosaicState();
    }

    this.log(`⚙️ Config atualizada`);
  }
}

module.exports = SignalAdvisor;
