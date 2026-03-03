// strategy.js - Conservative Trading Strategy v2
// 5 pillars: Trend | Momentum | Price Position | Market Regime | Volume
// HTF filter via EMA200. Minimum score 6/10.

const { EMA, RSI, BollingerBands, ATR } = require("technicalindicators");

class ConservativeStrategy {
  constructor(config = {}) {
    this.emaFast = config.emaFast || 9;
    this.emaSlow = config.emaSlow || 21;
    this.emaLong = config.emaLong || 50;
    this.emaFilter = config.emaFilter || 200;
    this.rsiPeriod = config.rsiPeriod || 14;
    this.bbPeriod = config.bbPeriod || 20;
    this.bbStdDev = config.bbStdDev || 2;
    this.atrPeriod = config.atrPeriod || 14;
    this.atrMult = config.atrMult || 1.5;
    this.stopLossPct = config.stopLossPct || null;
    this.takeProfitPct = config.takeProfitPct || null;
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

    const recentBBWidths = bbArr.slice(-6, -1).map((b) => (b.upper - b.lower) / b.middle);
    const avgBBWidth = recentBBWidths.reduce((a, b) => a + b, 0) / recentBBWidths.length;
    const bbWidth = (bb.upper - bb.lower) / bb.middle;
    const bbExpanding = bbWidth > avgBBWidth;

    const recentVol = volumes.slice(-20);
    const avgVol = recentVol.reduce((a, b) => a + b, 0) / recentVol.length;
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

    const htfBull = price > emaFilterV;
    const htfBear = price < emaFilterV;

    const freshGoldenCross = emaFastP <= emaSlowP && emaFastV > emaSlowV;
    const freshDeathCross = emaFastP >= emaSlowP && emaFastV < emaSlowV;
    const bullTrend = !freshGoldenCross && emaFastV > emaSlowV && emaSlowV > emaLongV;
    const bearTrend = !freshDeathCross && emaFastV < emaSlowV && emaSlowV < emaLongV;

    const rsiRising = rsi > rsiPrev;
    const rsiFalling = rsi < rsiPrev;
    const rsiLong = rsi >= 40 && rsi <= 70;
    const rsiShort = rsi >= 30 && rsi <= 60;

    const bbLong = price > bb.middle && price < bb.upper;
    const bbShort = price < bb.middle && price > bb.lower;

    const regimeOK = bbExpanding;
    const volConfirm = volRatio > 1.2;

    let longScore = 0;
    const longReasons = [];

    if (freshGoldenCross) {
      longScore += 4;
      longReasons.push("Golden Cross");
    } else if (bullTrend) {
      longScore += 3;
      longReasons.push("EMA Uptrend Aligned");
    }

    if (rsiLong) {
      longScore += rsiRising ? 2 : 1;
      longReasons.push(rsiRising ? "RSI [40-70] Rising" : "RSI [40-70]");
    }

    if (bbLong) {
      longScore += 2;
      longReasons.push("Price above BB Mid");
    }

    if (regimeOK) {
      longScore += 1;
      longReasons.push("BB Expanding");
    }

    if (volConfirm) {
      longScore += 1;
      longReasons.push("Volume Confirmed");
    }

    if (!htfBull) {
      longScore = 0;
      longReasons.length = 0;
    }

    let shortScore = 0;
    const shortReasons = [];

    if (freshDeathCross) {
      shortScore += 4;
      shortReasons.push("Death Cross");
    } else if (bearTrend) {
      shortScore += 3;
      shortReasons.push("EMA Downtrend Aligned");
    }

    if (rsiShort) {
      shortScore += rsiFalling ? 2 : 1;
      shortReasons.push(rsiFalling ? "RSI [30-60] Falling" : "RSI [30-60]");
    }

    if (bbShort) {
      shortScore += 2;
      shortReasons.push("Price below BB Mid");
    }

    if (regimeOK) {
      shortScore += 1;
      shortReasons.push("BB Expanding");
    }

    if (volConfirm) {
      shortScore += 1;
      shortReasons.push("Volume Confirmed");
    }

    if (!htfBear) {
      shortScore = 0;
      shortReasons.length = 0;
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
      bbExpanding: ind.bbExpanding,
      atr,
      volRatio: volRatio.toFixed(2),
      htfBias: htfBull ? "BULL" : htfBear ? "BEAR" : "NEUTRAL",
    };

    const slDistance = this.stopLossPct
      ? price * (this.stopLossPct / 100)
      : atr * this.atrMult;
    const tpMultiple =
      this.stopLossPct && this.takeProfitPct
        ? this.takeProfitPct / this.stopLossPct
        : 2.0;

    if (longScore >= MIN_SCORE && longScore > shortScore) {
      return {
        signal: "LONG",
        score: longScore,
        maxScore: MAX_SCORE,
        reasons: longReasons,
        price,
        stopLoss: +(price - slDistance).toFixed(2),
        takeProfit: +(price + slDistance * tpMultiple).toFixed(2),
        slDistance: +slDistance.toFixed(2),
        indicators,
      };
    }

    if (shortScore >= MIN_SCORE && shortScore > longScore) {
      return {
        signal: "SHORT",
        score: shortScore,
        maxScore: MAX_SCORE,
        reasons: shortReasons,
        price,
        stopLoss: +(price + slDistance).toFixed(2),
        takeProfit: +(price - slDistance * tpMultiple).toFixed(2),
        slDistance: +slDistance.toFixed(2),
        indicators,
      };
    }

    const htfStr = htfBull ? "BULL" : htfBear ? "BEAR" : "NEUTRAL";
    return {
      signal: "NONE",
      reason: `Score insuficiente (Long:${longScore} Short:${shortScore} Min:${MIN_SCORE}/${MAX_SCORE}) | HTF: ${htfStr}`,
      indicators,
      longScore,
      shortScore,
      maxScore: MAX_SCORE,
    };
  }
}

module.exports = ConservativeStrategy;
