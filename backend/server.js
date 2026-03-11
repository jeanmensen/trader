// server.js - Express + WebSocket Server
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const http = require("http");
const WebSocket = require("ws");
const path = require("path");
const logger = require("./logger");
const BinanceClient = require("./binanceClient");
const SignalAdvisor = require("./bot");
const fs = require("fs");

if (!fs.existsSync("logs")) fs.mkdirSync("logs");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/ws" });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "../frontend")));

// ── State ──────────────────────────────────────────────────────────────────
let binance = null;
let bot = null;
const clients = new Set();

function parseSymbolsList(raw, fallback = []) {
  const arr = Array.isArray(raw)
    ? raw
    : String(raw || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
  const set = new Set(
    arr.map((s) => String(s || "").trim().toUpperCase()).filter(Boolean),
  );
  for (const sym of fallback) {
    const s = String(sym || "").trim().toUpperCase();
    if (s) set.add(s);
  }
  return [...set];
}

let botConfig = {
  symbol: process.env.DEFAULT_SYMBOL || "BTCUSDT",
  timeframe: process.env.DEFAULT_TIMEFRAME || "4h",
  leverage: parseInt(process.env.DEFAULT_LEVERAGE || "2"),
  riskPerTrade: parseFloat(process.env.RISK_PER_TRADE || "0.5"),
  stopLossPct: parseFloat(process.env.STOP_LOSS_PCT || "1.2"),
  takeProfitPct: parseFloat(process.env.TAKE_PROFIT_PCT || "3.0"),
  maxOpenTrades: parseInt(process.env.MAX_OPEN_TRADES || "1"),
  testnet: process.env.USE_TESTNET !== "false",
  bypassDailyLimit: false,
  scanSymbols: parseSymbolsList(process.env.SCAN_SYMBOLS, [
    "BTCUSDT","ETHUSDT","XRPUSDT","SOLUSDT","ADAUSDT",
    "XLMUSDT","LINKUSDT","HBARUSDT","BCHUSDT","AVAXUSDT",
    "LTCUSDT","DOTUSDT","UNIUSDT","AAVEUSDT","NEARUSDT",
    "ETCUSDT","ALGOUSDT","ATOMUSDT","POLUSDT","ARBUSDT",
    "QNTUSDT","TIAUSDT","OPUSDT","IMXUSDT","GRTUSDT",
    "LDOUSDT","XTZUSDT",
  ]),
};

// ── Auto-conectar usando credenciais do .env ───────────────────────────────
// Não faz NENHUMA chamada REST aqui — apenas instancia o client.
// A validação real acontece só quando o bot é iniciado ou conta é consultada.
function autoConnect() {
  const apiKey = process.env.BINANCE_API_KEY;
  const apiSecret = process.env.BINANCE_API_SECRET;

  if (
    !apiKey ||
    apiKey === "cole_sua_api_key_aqui" ||
    !apiSecret ||
    apiSecret === "cole_sua_api_secret_aqui"
  ) {
    logger.warn(
      "⚠️  Credenciais não configuradas no .env — edite o arquivo .env e reinicie",
    );
    return;
  }

  // Só instancia — zero chamadas REST
  binance = new BinanceClient(apiKey, apiSecret, botConfig.testnet);
  const modo = botConfig.testnet ? "TESTNET" : "LIVE";
  logger.info(`✅ Credenciais carregadas [${modo}] — pronto para operar`);
  broadcast({ type: "connected", data: { testnet: botConfig.testnet } });
}

// ── WebSocket Broadcast ────────────────────────────────────────────────────
function broadcast(msg) {
  const data = JSON.stringify(msg);
  clients.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  });
}

wss.on("connection", (ws) => {
  clients.add(ws);
  logger.info("Painel conectado via WebSocket");

  ws.send(JSON.stringify({ type: "config", data: botConfig }));
  ws.send(
    JSON.stringify({
      type: "connection_status",
      data: { connected: !!binance, testnet: botConfig.testnet },
    }),
  );

  if (bot) ws.send(JSON.stringify({ type: "state", data: bot.getState() }));
  if (binance)
    ws.send(
      JSON.stringify({
        type: "connected",
        data: { testnet: botConfig.testnet },
      }),
    );

  ws.on("close", () => clients.delete(ws));
  ws.on("error", (e) => logger.error("WS error: " + e.message));
});

// ── REST API ───────────────────────────────────────────────────────────────

// Health / status
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    connected: !!binance,
    testnet: botConfig.testnet,
    botRunning: bot?.getState().running || false,
    time: new Date().toISOString(),
  });
});

// Reconectar manualmente (sem precisar de credenciais no body)
app.post("/api/reconnect", (req, res) => {
  autoConnect();
  res.json({ ok: !!binance, connected: !!binance, testnet: botConfig.testnet });
});

// Get config
app.get("/api/config", (req, res) => res.json(botConfig));

// Update config
app.put("/api/config", async (req, res) => {
  const { leverage, riskPerTrade, stopLossPct, takeProfitPct, maxOpenTrades } =
    req.body;
  let scanSymbols = req.body?.scanSymbols;
  if (leverage !== undefined && (leverage < 1 || leverage > 125))
    return res.status(400).json({ error: "leverage deve ser entre 1 e 125" });
  if (riskPerTrade !== undefined && (riskPerTrade <= 0 || riskPerTrade > 10))
    return res
      .status(400)
      .json({ error: "riskPerTrade deve ser entre 0.1 e 10" });
  if (stopLossPct !== undefined && (stopLossPct <= 0 || stopLossPct > 20))
    return res
      .status(400)
      .json({ error: "stopLossPct deve ser entre 0.1 e 20" });
  if (takeProfitPct !== undefined && (takeProfitPct <= 0 || takeProfitPct > 50))
    return res
      .status(400)
      .json({ error: "takeProfitPct deve ser entre 0.1 e 50" });
  if (maxOpenTrades !== undefined && (maxOpenTrades < 1 || maxOpenTrades > 10))
    return res
      .status(400)
      .json({ error: "maxOpenTrades deve ser entre 1 e 10" });
  if (scanSymbols !== undefined) {
    scanSymbols = parseSymbolsList(scanSymbols, [req.body?.symbol || botConfig.symbol]);
    if (!scanSymbols.length) {
      return res.status(400).json({ error: "scanSymbols não pode ser vazio" });
    }
  }

  botConfig = {
    ...botConfig,
    ...req.body,
    scanSymbols:
      scanSymbols !== undefined
        ? scanSymbols
        : parseSymbolsList(botConfig.scanSymbols, [req.body?.symbol || botConfig.symbol]),
  };
  try {
    if (bot) await bot.updateConfig(botConfig);
    broadcast({ type: "config", data: botConfig });
    res.json({ ok: true, config: botConfig });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Start bot
app.post("/api/bot/start", async (req, res) => {
  try {
    if (!binance)
      return res
        .status(400)
        .json({
          error:
            "Binance não conectada. Verifique o .env e reinicie o servidor.",
        });
    if (!bot) bot = new SignalAdvisor(binance, botConfig, broadcast);
    const result = await bot.start();
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Analyze now (mosaic)
app.post("/api/bot/analyze", (req, res) => {
  if (!bot) return res.status(400).json({ error: "Bot não inicializado" });
  const result = bot.analyzeNow();
  res.json(result);
});

// Stop bot
app.post("/api/bot/stop", (req, res) => {
  if (!bot) return res.status(400).json({ error: "Bot não inicializado" });
  res.json(bot.stop());
});

// Bot state
app.get("/api/bot/state", (req, res) => {
  if (!bot)
    return res.json({ running: false, positions: [], trades: [], logs: [] });
  res.json(bot.getState());
});

// Account info
app.get("/api/account", async (req, res) => {
  try {
    if (!binance) return res.status(400).json({ error: "Não conectado" });
    const balances = await binance.getBalance();
    const usdt = balances.find((b) => b.asset === "USDT");
    res.json({
      balance: parseFloat(usdt?.balance || 0),
      availableBalance: parseFloat(usdt?.availableBalance || 0),
      unrealizedPnl: 0,
      positions: [],
    });
  } catch (e) {
    res.status(500).json({ error: e.response?.data?.msg || e.message });
  }
});

// Market data
app.get("/api/market/:symbol", async (req, res) => {
  try {
    if (!binance) return res.status(400).json({ error: "Não conectado" });
    const { symbol } = req.params;
    const interval = req.query.interval || "15m";
    const canUseBotCache =
      !!bot &&
      bot.getCandles().length > 0 &&
      symbol === botConfig.symbol &&
      interval === botConfig.timeframe;
    if (canUseBotCache) {
      const candles = bot.getCandles();
      const lastClose = candles[candles.length - 1]?.close || 0;
      return res.json({
        ticker: { lastPrice: lastClose, symbol },
        candles,
        markPrice: { markPrice: lastClose },
      });
    }
    const [ticker, candles] = await Promise.all([
      binance.getTicker(symbol),
      binance.getKlines(symbol, interval, 100),
    ]);
    res.json({ ticker, candles, markPrice: { markPrice: ticker.lastPrice } });
  } catch (e) {
    res.status(500).json({ error: e.response?.data?.msg || e.message });
  }
});

// Signal analysis
app.get("/api/signal/:symbol", async (req, res) => {
  try {
    if (!binance) return res.status(400).json({ error: "Não conectado" });
    if (bot && bot.getCandles().length > 0) {
      const signal = bot.analyzeNow();
      return res.json({
        symbol: req.params.symbol,
        signal,
        time: new Date().toISOString(),
      });
    }
    const ConservativeStrategy = require("./strategy");
    const strategy = new ConservativeStrategy();
    const candles = await binance.getKlines(
      req.params.symbol,
      req.query.interval || "15m",
      250,
    );
    const signal = strategy.getSignal(candles);
    res.json({
      symbol: req.params.symbol,
      signal,
      time: new Date().toISOString(),
    });
  } catch (e) {
    res.status(500).json({ error: e.response?.data?.msg || e.message });
  }
});

// Positions (modo sinal — sempre vazio)
app.get("/api/positions", (req, res) => res.json([]));

// (Endpoints de execução de ordens removidos — modo sinal apenas)

// Catch-all → frontend
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "../frontend/index.html"));
});

// ── Start ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  logger.info(`🚀 Servidor rodando em http://localhost:${PORT}`);
  logger.info(`📡 WebSocket em ws://localhost:${PORT}/ws`);
  logger.info(`🌐 Painel em http://localhost:${PORT}`);
  autoConnect();
});
