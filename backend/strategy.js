// strategy.js - Conservative Trading Strategy v2
// 5 pilares independentes: Trend | Momentum | Price Position | Market Regime | Volume
// Filtro HTF via EMA200. Score mínimo 6/10 para entrada.

const { EMA, RSI, BollingerBands, ATR } = require("technicalindicators");

class ConservativeStrategy {
  constructor(config = {}) {
    this.emaFast   = config.emaFast   || 9;
    this.emaSlow   = config.emaSlow   || 21;
    this.emaLong   = config.emaLong   || 50;
    this.emaFilter = config.emaFilter || 200; // proxy de tendência maior (HTF)
    this.rsiPeriod = config.rsiPeriod || 14;
    this.bbPeriod  = config.bbPeriod  || 20;
    this.bbStdDev  = config.bbStdDev  || 2;
    this.atrPeriod = config.atrPeriod || 14;
    this.atrMult   = config.atrMult   || 1.5;
  }

  // ── Cálculo de indicadores ─────────────────────────────────────────────────
  calculate(candles) {
    if (candles.length < 210) return null; // mínimo para EMA200 ter margem

    const closes  = candles.map((c) => c.close);
    const highs   = candles.map((c) => c.high);
    const lows    = candles.map((c) => c.low);
    const volumes = candles.map((c) => c.volume);

    // EMAs
    const emaFastArr   = EMA.calculate({ period: this.emaFast,   values: closes });
    const emaSlowArr   = EMA.calculate({ period: this.emaSlow,   values: closes });
    const emaLongArr   = EMA.calculate({ period: this.emaLong,   values: closes });
    const emaFilterArr = EMA.calculate({ period: this.emaFilter, values: closes });

    // RSI
    const rsiArr = RSI.calculate({ period: this.rsiPeriod, values: closes });

    // Bollinger Bands
    const bbArr = BollingerBands.calculate({
      period: this.bbPeriod,
      values: closes,
      stdDev: this.bbStdDev,
    });

    // ATR para SL/TP dinâmico
    const atrArr = ATR.calculate({
      period: this.atrPeriod,
      high: highs,
      low: lows,
      close: closes,
    });

    const price      = closes[closes.length - 1];
    const emaFastV   = emaFastArr[emaFastArr.length - 1];
    const emaFastP   = emaFastArr[emaFastArr.length - 2]; // candle anterior
    const emaSlowV   = emaSlowArr[emaSlowArr.length - 1];
    const emaSlowP   = emaSlowArr[emaSlowArr.length - 2];
    const emaLongV   = emaLongArr[emaLongArr.length - 1];
    const emaFilterV = emaFilterArr[emaFilterArr.length - 1];
    const rsi        = rsiArr[rsiArr.length - 1];
    const rsiPrev    = rsiArr[rsiArr.length - 2];
    const bb         = bbArr[bbArr.length - 1];
    const atr        = atrArr[atrArr.length - 1];

    // Largura do BB: compara atual com média dos últimos 5 para detectar squeeze
    const recentBBWidths = bbArr.slice(-6, -1).map(
      (b) => (b.upper - b.lower) / b.middle,
    );
    const avgBBWidth = recentBBWidths.reduce((a, b) => a + b, 0) / recentBBWidths.length;
    const bbWidth    = (bb.upper - bb.lower) / bb.middle;
    const bbExpanding = bbWidth > avgBBWidth;

    // Volume
    const recentVol = volumes.slice(-20);
    const avgVol    = recentVol.reduce((a, b) => a + b, 0) / recentVol.length;
    const volRatio  = volumes[volumes.length - 1] / avgVol;

    return {
      price,
      emaFastV, emaFastP,
      emaSlowV, emaSlowP,
      emaLongV, emaFilterV,
      rsi, rsiPrev,
      bb, bbWidth, bbExpanding,
      atr, volRatio,
    };
  }

  // ── Geração de sinal ───────────────────────────────────────────────────────
  getSignal(candles) {
    const ind = this.calculate(candles);
    if (!ind)
      return {
        signal: "NONE",
        reason: "Dados insuficientes (mínimo 210 candles)",
        indicators: null,
      };

    const {
      price,
      emaFastV, emaFastP,
      emaSlowV, emaSlowP,
      emaLongV, emaFilterV,
      rsi, rsiPrev,
      bb, bbExpanding,
      atr, volRatio,
    } = ind;

    // ── Filtro HTF — proxy de tendência maior via EMA200 ──────────────────────
    // Bloqueia trades contra a tendência dominante
    const htfBull = price > emaFilterV; // bias de alta
    const htfBear = price < emaFilterV; // bias de baixa

    // ── Pillar 1: TREND via estrutura EMA (mutuamente exclusivo) ─────────────
    // Golden Cross = cruzamento fresco neste candle (sinal mais forte)
    // Bull Trend   = tendência estabelecida (EMA9 > EMA21 > EMA50)
    const freshGoldenCross = emaFastP <= emaSlowP && emaFastV > emaSlowV;
    const freshDeathCross  = emaFastP >= emaSlowP && emaFastV < emaSlowV;
    const bullTrend = !freshGoldenCross && emaFastV > emaSlowV && emaSlowV > emaLongV;
    const bearTrend = !freshDeathCross  && emaFastV < emaSlowV && emaSlowV < emaLongV;

    // ── Pillar 2: MOMENTUM via RSI (zonas sem sobreposição) ──────────────────
    // LONG zone: 40–70 (espaço de momentum, não sobrecomprado)
    // SHORT zone: 30–60 (espaço de momentum, não sobrevendido)
    // Zonas intencionalmente separadas: RSI < 40 = sem momentum long
    //                                   RSI > 60 = sem momentum short
    const rsiRising  = rsi > rsiPrev;
    const rsiFalling = rsi < rsiPrev;
    const rsiLong  = rsi >= 40 && rsi <= 70;
    const rsiShort = rsi >= 30 && rsi <= 60;

    // ── Pillar 3: POSIÇÃO DE PREÇO via Bollinger Bands ───────────────────────
    const bbLong  = price > bb.middle && price < bb.upper; // acima do meio, não no topo
    const bbShort = price < bb.middle && price > bb.lower; // abaixo do meio, não no fundo

    // ── Pillar 4: REGIME DE MERCADO via largura do BB ────────────────────────
    // BB expandindo = mercado em tendência → aceitar entrada
    // BB contraindo = mercado lateral/squeeze → ignorar sinais
    const regimeOK = bbExpanding;

    // ── Pillar 5: VOLUME ──────────────────────────────────────────────────────
    const volConfirm = volRatio > 1.2; // 20% acima da média

    // ── Pontuação LONG (max 10) ───────────────────────────────────────────────
    let longScore = 0;
    const longReasons = [];

    // Pillar 1 (max 4 — mutuamente exclusivo)
    if (freshGoldenCross) {
      longScore += 4;
      longReasons.push("Golden Cross");
    } else if (bullTrend) {
      longScore += 3;
      longReasons.push("EMA Uptrend Aligned");
    }

    // Pillar 2 (max 2)
    if (rsiLong) {
      longScore += rsiRising ? 2 : 1;
      longReasons.push(rsiRising ? "RSI [40-70] Rising" : "RSI [40-70]");
    }

    // Pillar 3 (max 2)
    if (bbLong) {
      longScore += 2;
      longReasons.push("Price above BB Mid");
    }

    // Pillar 4 (max 1)
    if (regimeOK) {
      longScore += 1;
      longReasons.push("BB Expanding");
    }

    // Pillar 5 (max 1)
    if (volConfirm) {
      longScore += 1;
      longReasons.push("Volume Confirmed");
    }

    // Filtro HTF: bloqueia LONG contra tendência dominante
    if (!htfBull) {
      longScore = 0;
      longReasons.length = 0;
    }

    // ── Pontuação SHORT (max 10) ──────────────────────────────────────────────
    let shortScore = 0;
    const shortReasons = [];

    // Pillar 1 (max 4 — mutuamente exclusivo)
    if (freshDeathCross) {
      shortScore += 4;
      shortReasons.push("Death Cross");
    } else if (bearTrend) {
      shortScore += 3;
      shortReasons.push("EMA Downtrend Aligned");
    }

    // Pillar 2 (max 2)
    if (rsiShort) {
      shortScore += rsiFalling ? 2 : 1;
      shortReasons.push(rsiFalling ? "RSI [30-60] Falling" : "RSI [30-60]");
    }

    // Pillar 3 (max 2)
    if (bbShort) {
      shortScore += 2;
      shortReasons.push("Price below BB Mid");
    }

    // Pillar 4 (max 1)
    if (regimeOK) {
      shortScore += 1;
      shortReasons.push("BB Expanding");
    }

    // Pillar 5 (max 1)
    if (volConfirm) {
      shortScore += 1;
      shortReasons.push("Volume Confirmed");
    }

    // Filtro HTF: bloqueia SHORT contra tendência dominante
    if (!htfBear) {
      shortScore = 0;
      shortReasons.length = 0;
    }

    // ── Saída ─────────────────────────────────────────────────────────────────
    const MIN_SCORE = 6;
    const indicators = {
      ema9:        emaFastV,
      ema21:       emaSlowV,
      ema50:       emaLongV,
      ema200:      emaFilterV,
      rsi,
      bbUpper:     bb.upper,
      bbMiddle:    bb.middle,
      bbLower:     bb.lower,
      bbExpanding: ind.bbExpanding,
      atr,
      volRatio:    volRatio.toFixed(2),
      htfBias:     htfBull ? "BULL" : htfBear ? "BEAR" : "NEUTRAL",
    };

    const slDistance = atr * this.atrMult;
    const tpMultiple = 2.0; // risco:retorno mínimo 1:2

    if (longScore >= MIN_SCORE && longScore > shortScore) {
      return {
        signal:     "LONG",
        score:      longScore,
        maxScore:   10,
        reasons:    longReasons,
        price,
        stopLoss:   +(price - slDistance).toFixed(2),
        takeProfit: +(price + slDistance * tpMultiple).toFixed(2),
        slDistance: +slDistance.toFixed(2),
        indicators,
      };
    }

    if (shortScore >= MIN_SCORE && shortScore > longScore) {
      return {
        signal:     "SHORT",
        score:      shortScore,
        maxScore:   10,
        reasons:    shortReasons,
        price,
        stopLoss:   +(price + slDistance).toFixed(2),
        takeProfit: +(price - slDistance * tpMultiple).toFixed(2),
        slDistance: +slDistance.toFixed(2),
        indicators,
      };
    }

    const htfStr = htfBull ? "BULL" : htfBear ? "BEAR" : "NEUTRAL";
    return {
      signal:     "NONE",
      reason:     `Score insuficiente (Long:${longScore} Short:${shortScore} Min:${MIN_SCORE}/10) | HTF: ${htfStr}`,
      indicators,
      longScore,
      shortScore,
    };
  }
}

module.exports = ConservativeStrategy;
