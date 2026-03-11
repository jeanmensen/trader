// strategy.js - Swing strategy focused on bullish pullbacks with fixed-profit exits.

const { EMA, RSI, BollingerBands, ATR } = require("technicalindicators");

class ConservativeStrategy {
  constructor(config = {}) {
    this.emaFast = config.emaFast || 20;
    this.emaSlow = config.emaSlow || 50;
    this.emaLong = config.emaLong || 100;
    this.emaFilter = config.emaFilter || 200;
    this.rsiPeriod = config.rsiPeriod || 14;
    this.bbPeriod = config.bbPeriod || 20;
    this.bbStdDev = config.bbStdDev || 2;
    this.atrPeriod = config.atrPeriod || 14;
    this.atrMult = config.atrMult || 1.5;
    this.stopLossPct = config.stopLossPct || null;
    this.takeProfitPct = config.takeProfitPct || 3;
  }

  calculate(candles) {
    if (candles.length < 210) return null;

    const closes = candles.map((c) => c.close);
    const highs = candles.map((c) => c.high);
    const lows = candles.map((c) => c.low);
    const volumes = candles.map((c) => c.volume);

    const emaFastArr = EMA.calculate({ period: this.emaFast, values: closes });
    const emaSlowArr = EMA.calculate({ period: this.emaSlow, values: closes });
    const emaLongArr = EMA.calculate({ period: this.emaLong, values: closes });
    const emaFilterArr = EMA.calculate({ period: this.emaFilter, values: closes });
    const rsiArr = RSI.calculate({ period: this.rsiPeriod, values: closes });
    const bbArr = BollingerBands.calculate({
      period: this.bbPeriod,
      values: closes,
      stdDev: this.bbStdDev,
    });
    const atrArr = ATR.calculate({
      period: this.atrPeriod,
      high: highs,
      low: lows,
      close: closes,
    });

    const price = closes[closes.length - 1];
    const emaFastV = emaFastArr[emaFastArr.length - 1];
    const emaFastP = emaFastArr[emaFastArr.length - 2];
    const emaSlowV = emaSlowArr[emaSlowArr.length - 1];
    const emaSlowP = emaSlowArr[emaSlowArr.length - 2];
    const emaLongV = emaLongArr[emaLongArr.length - 1];
    const emaFilterV = emaFilterArr[emaFilterArr.length - 1];
    const rsi = rsiArr[rsiArr.length - 1];
    const rsiPrev = rsiArr[rsiArr.length - 2];
    const bb = bbArr[bbArr.length - 1];
    const atr = atrArr[atrArr.length - 1];

    const recentBBWidths = bbArr
      .slice(-6, -1)
      .map((b) => (b.upper - b.lower) / b.middle);
    const avgBBWidth =
      recentBBWidths.reduce((sum, value) => sum + value, 0) / recentBBWidths.length;
    const bbWidth = (bb.upper - bb.lower) / bb.middle;
    const bbExpanding = bbWidth > avgBBWidth;

    const recentVol = volumes.slice(-20);
    const avgVol = recentVol.reduce((sum, value) => sum + value, 0) / recentVol.length;
    const volRatio = volumes[volumes.length - 1] / avgVol;

    return {
      price,
      emaFastV,
      emaFastP,
      emaSlowV,
      emaSlowP,
      emaLongV,
      emaFilterV,
      rsi,
      rsiPrev,
      bb,
      bbWidth,
      bbExpanding,
      atr,
      volRatio,
    };
  }

  getSignal(candles) {
    const ind = this.calculate(candles);
    if (!ind) {
      return {
        signal: "NONE",
        reason: "Dados insuficientes (minimo 210 candles)",
        indicators: null,
      };
    }

    const {
      price,
      emaFastV,
      emaFastP,
      emaSlowV,
      emaSlowP,
      emaLongV,
      emaFilterV,
      rsi,
      rsiPrev,
      bb,
      bbExpanding,
      atr,
      volRatio,
    } = ind;

    const lastCandle = candles[candles.length - 1];
    const prevCandle = candles[candles.length - 2];
    const priorCandle = candles[candles.length - 3];

    const htfBull = price > emaFilterV;
    const freshGoldenCross = emaFastP <= emaSlowP && emaFastV > emaSlowV;
    const bullTrend = emaFastV > emaSlowV && emaSlowV > emaLongV;
    const strongTrend = htfBull && bullTrend;

    const rsiRising = rsi > rsiPrev;
    const healthyMomentum = rsi >= 48 && rsi <= 68;
    const notOverextended = price < bb.upper * 0.992;
    const regimeOK = bbExpanding || price > bb.middle;
    const volConfirm = volRatio >= 1.05;

    const distanceToFast = Math.abs(price - emaFastV) / emaFastV;
    const distanceToSlow = Math.abs(price - emaSlowV) / emaSlowV;
    const touchedValueZone =
      distanceToFast <= 0.018 ||
      distanceToSlow <= 0.012 ||
      lastCandle.low <= emaFastV * 1.003;
    const bullishClose = lastCandle.close > lastCandle.open;
    const reboundConfirmed =
      bullishClose &&
      lastCandle.close > prevCandle.close &&
      lastCandle.close > emaFastV &&
      prevCandle.low <= emaFastV * 1.01;
    const higherLow =
      lastCandle.low >= Math.min(prevCandle.low, priorCandle.low) * 0.995;
    const swingStructure = touchedValueZone && reboundConfirmed && higherLow;

    let longScore = 0;
    const longReasons = [];

    if (strongTrend) {
      longScore += 3;
      longReasons.push("Tendencia de alta alinhada");
    } else if (freshGoldenCross && htfBull) {
      longScore += 2;
      longReasons.push("Cruzamento altista recente");
    }

    if (touchedValueZone) {
      longScore += 2;
      longReasons.push("Pullback em zona de valor");
    }

    if (reboundConfirmed) {
      longScore += 2;
      longReasons.push("Retomada confirmada");
    }

    if (healthyMomentum) {
      longScore += rsiRising ? 2 : 1;
      longReasons.push(rsiRising ? "RSI saudavel e subindo" : "RSI saudavel");
    }

    if (higherLow) {
      longScore += 1;
      longReasons.push("Fundo mais alto preservado");
    }

    if (regimeOK) {
      longScore += 1;
      longReasons.push("Regime favoravel");
    }

    if (volConfirm) {
      longScore += 1;
      longReasons.push("Volume confirma");
    }

    if (!htfBull || !notOverextended || !swingStructure) {
      longScore = 0;
      longReasons.length = 0;
    }

    const MIN_SCORE = 6;
    const MAX_SCORE = 10;

    const indicators = {
      ema9: emaFastV,
      ema21: emaSlowV,
      ema50: emaLongV,
      ema200: emaFilterV,
      rsi,
      bbUpper: bb.upper,
      bbMiddle: bb.middle,
      bbLower: bb.lower,
      bbExpanding,
      atr,
      volRatio: volRatio.toFixed(2),
      htfBias: htfBull ? "BULL" : "NEUTRAL",
      swingPullback: touchedValueZone,
      reboundConfirmed,
      notOverextended,
    };

    const slDistance = this.stopLossPct
      ? price * (this.stopLossPct / 100)
      : atr * this.atrMult;
    const targetPct = this.takeProfitPct || 3;
    const rewardDistance = price * (targetPct / 100);
    const riskReward = slDistance > 0 ? rewardDistance / slDistance : 0;

    if (longScore >= MIN_SCORE) {
      return {
        signal: "LONG",
        score: longScore,
        maxScore: MAX_SCORE,
        reasons: longReasons,
        price,
        stopLoss: +(price - slDistance).toFixed(2),
        takeProfit: +(price * (1 + targetPct / 100)).toFixed(2),
        slDistance: +slDistance.toFixed(2),
        targetPct,
        setup: "SWING_PULLBACK_LONG",
        confidence:
          longScore >= 8 ? "ALTA" : longScore >= 7 ? "MEDIA" : "MODERADA",
        riskReward: +riskReward.toFixed(2),
        indicators,
      };
    }

    return {
      signal: "NONE",
      reason: `Setup de swing ausente (Score:${longScore} Min:${MIN_SCORE}/${MAX_SCORE}) | HTF: ${htfBull ? "BULL" : "NEUTRAL"}`,
      indicators,
      longScore,
      maxScore: MAX_SCORE,
    };
  }
}

module.exports = ConservativeStrategy;
