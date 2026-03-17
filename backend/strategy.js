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
    this.takeProfitMode = String(
      config.takeProfitMode || (config.takeProfitPct ? "FIXED_PCT" : "ATR"),
    ).toUpperCase();
    this.takeProfitPct = config.takeProfitPct || null;
    this.takeProfitMult = config.takeProfitMult || 3.0;
    this.tradeDirection = String(config.tradeDirection || "LONG").toUpperCase();
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
    const volRatio = avgVol > 0 ? volumes[volumes.length - 1] / avgVol : 0;

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

  formatLevel(value, price) {
    if (!Number.isFinite(value)) return value;
    const ref = Number.isFinite(price) ? price : value;
    let decimals = 2;
    if (ref < 1000) decimals = 4;
    if (ref < 1) decimals = 6;
    if (ref < 0.01) decimals = 8;
    return Number(value.toFixed(decimals));
  }

  buildTrendContext(ind) {
    const {
      price,
      emaFastV,
      emaFastP,
      emaSlowV,
      emaSlowP,
      emaLongV,
      emaFilterV,
      rsi,
      bb,
      bbWidth,
      bbExpanding,
      atr,
      volRatio,
    } = ind;

    const htfBull = price > emaFilterV;
    const htfBear = price < emaFilterV;
    const bullTrend = emaFastV > emaSlowV && emaSlowV > emaLongV;
    const bearTrend = emaFastV < emaSlowV && emaSlowV < emaLongV;
    const emaFastSlope = (emaFastV - emaFastP) / emaFastP;
    const emaSlowSlope = (emaSlowV - emaSlowP) / emaSlowP;
    const compressedBands = bbWidth < 0.06;
    const priceNearMiddleBand = Math.abs(price - bb.middle) / price < 0.015;
    const consolidationZone = compressedBands && priceNearMiddleBand;

    let trend = "LATERAL";
    let strengthScore = 0;

    if (htfBull && bullTrend) {
      trend = "ALTA";
      strengthScore += 2;
    } else if (htfBear && bearTrend) {
      trend = "BAIXA";
      strengthScore += 2;
    }

    if (Math.abs(emaFastSlope) > 0.0025) strengthScore += 1;
    if (Math.abs(emaSlowSlope) > 0.0015) strengthScore += 1;
    if (bbExpanding) strengthScore += 1;
    if (volRatio >= 1.05) strengthScore += 1;

    if (trend === "LATERAL") {
      trend = "LATERAL";
    }

    const strength =
      trend === "LATERAL"
        ? compressedBands ? "BAIXA" : "MEDIA"
        : consolidationZone
          ? "BAIXA"
        : strengthScore >= 5
          ? "FORTE"
          : strengthScore >= 3
            ? "MEDIA"
            : "BAIXA";

    let scenario = "CONSOLIDACAO";
    if (trend === "ALTA") {
      scenario = consolidationZone
        ? "PULLBACK_DE_ALTA"
        : price > emaFastV && rsi >= 55
          ? "CONTINUACAO_DE_ALTA"
          : "PULLBACK_DE_ALTA";
    } else if (trend === "BAIXA") {
      scenario = consolidationZone
        ? "PULLBACK_DE_BAIXA"
        : price < emaFastV && rsi <= 45
          ? "CONTINUACAO_DE_BAIXA"
          : "PULLBACK_DE_BAIXA";
    } else if (bbExpanding) {
      scenario = "ROMPIMENTO_PENDENTE";
    }

    const projectedMovePct = price > 0 ? +(((atr * 1.5) / price) * 100).toFixed(2) : 0;

    return {
      trend,
      strength,
      scenario,
      projectedMovePct,
      emaFastSlopePct: +(emaFastSlope * 100).toFixed(3),
      emaSlowSlopePct: +(emaSlowSlope * 100).toFixed(3),
      compressedBands,
    };
  }

  getSignal(candles) {
    const ind = this.calculate(candles);
    if (!ind) {
      return {
        signal: "NONE",
        reason: "Dados insuficientes (minimo 210 candles)",
        indicators: null,
        maxScore: 12,
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
    const trendContext = this.buildTrendContext(ind);

    const lastCandle = candles[candles.length - 1];
    const prevCandle = candles[candles.length - 2];
    const priorCandle = candles[candles.length - 3];

    const allowLong = this.tradeDirection === "LONG" || this.tradeDirection === "BOTH";
    const allowShort = this.tradeDirection === "SHORT" || this.tradeDirection === "BOTH";

    const htfBull = price > emaFilterV;
    const htfBear = price < emaFilterV;
    const freshGoldenCross = emaFastP <= emaSlowP && emaFastV > emaSlowV;
    const freshDeathCross = emaFastP >= emaSlowP && emaFastV < emaSlowV;
    const bullTrend = emaFastV > emaSlowV && emaSlowV > emaLongV;
    const bearTrend = emaFastV < emaSlowV && emaSlowV < emaLongV;
    const strongTrend = htfBull && bullTrend;
    const strongDowntrend = htfBear && bearTrend;

    const rsiRising = rsi > rsiPrev;
    const rsiFalling = rsi < rsiPrev;
    const healthyMomentum = rsi >= 48 && rsi <= 68;
    const healthyShortMomentum = rsi >= 32 && rsi <= 52;
    const notOverextended = price < bb.upper * 0.992;
    const notOverextendedShort = price > bb.lower * 1.008;
    const regimeOK = bbExpanding || price > bb.middle;
    const shortRegimeOK = bbExpanding || price < bb.middle;
    const volConfirm = volRatio >= 1.3;

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
      lastCandle.low >= Math.min(prevCandle.low, priorCandle.low);
    const swingStructure = touchedValueZone && reboundConfirmed && higherLow;
    const touchedShortValueZone =
      Math.abs(lastCandle.high - emaFastV) / emaFastV <= 0.018 ||
      Math.abs(lastCandle.high - emaSlowV) / emaSlowV <= 0.012 ||
      lastCandle.high >= emaFastV * 0.997;
    const bearishClose = lastCandle.close < lastCandle.open;
    const rejectionConfirmed =
      bearishClose &&
      lastCandle.close < prevCandle.close &&
      lastCandle.close < emaFastV &&
      prevCandle.high >= emaFastV * 0.99;
    const lowerHigh =
      lastCandle.high <= Math.max(prevCandle.high, priorCandle.high) * 1.005;
    const swingShortStructure = touchedShortValueZone && rejectionConfirmed && lowerHigh;

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

    const longTrendOK = strongTrend || (freshGoldenCross && htfBull);
    if (!longTrendOK || !notOverextended || !swingStructure) {
      longScore = 0;
      longReasons.length = 0;
    }

    let shortScore = 0;
    const shortReasons = [];

    if (strongDowntrend) {
      shortScore += 3;
      shortReasons.push("Tendencia de baixa alinhada");
    } else if (freshDeathCross && htfBear) {
      shortScore += 2;
      shortReasons.push("Cruzamento baixista recente");
    }

    if (touchedShortValueZone) {
      shortScore += 2;
      shortReasons.push("Pullback em resistencia");
    }

    if (rejectionConfirmed) {
      shortScore += 2;
      shortReasons.push("Rejeicao confirmada");
    }

    if (healthyShortMomentum) {
      shortScore += rsiFalling ? 2 : 1;
      shortReasons.push(rsiFalling ? "RSI saudavel e caindo" : "RSI saudavel");
    }

    if (lowerHigh) {
      shortScore += 1;
      shortReasons.push("Topo mais baixo preservado");
    }

    if (shortRegimeOK) {
      shortScore += 1;
      shortReasons.push("Regime favoravel");
    }

    if (volConfirm) {
      shortScore += 1;
      shortReasons.push("Volume confirma");
    }

    const shortTrendOK = strongDowntrend || (freshDeathCross && htfBear);
    if (!shortTrendOK || !notOverextendedShort || !swingShortStructure) {
      shortScore = 0;
      shortReasons.length = 0;
    }

    const MIN_SCORE = 6;
    const MAX_SCORE = 12;

    const indicators = {
      ema20: emaFastV,
      ema50: emaSlowV,
      ema100: emaLongV,
      ema200: emaFilterV,
      rsi,
      bbUpper: bb.upper,
      bbMiddle: bb.middle,
      bbLower: bb.lower,
      bbExpanding,
      atr,
      volRatio: volRatio.toFixed(2),
      htfBias: htfBull ? "BULL" : htfBear ? "BEAR" : "NEUTRAL",
      trend: trendContext.trend,
      trendStrength: trendContext.strength,
      trendScenario: trendContext.scenario,
      projectedMovePct: trendContext.projectedMovePct,
      emaFastSlopePct: trendContext.emaFastSlopePct,
      emaSlowSlopePct: trendContext.emaSlowSlopePct,
      compressedBands: trendContext.compressedBands,
      takeProfitMode: this.takeProfitMode,
      swingPullback: touchedValueZone,
      reboundConfirmed,
      notOverextended,
      shortPullback: touchedShortValueZone,
      rejectionConfirmed,
    };

    const slDistance = this.stopLossPct
      ? price * (this.stopLossPct / 100)
      : atr * this.atrMult;
    const useFixedTakeProfit =
      this.takeProfitMode === "FIXED_PCT" && Number.isFinite(this.takeProfitPct);
    const rewardDistance = useFixedTakeProfit
      ? price * (this.takeProfitPct / 100)
      : atr * this.takeProfitMult;
    const riskReward = slDistance > 0 ? rewardDistance / slDistance : 0;
    const effectiveTargetPct = +((rewardDistance / price) * 100).toFixed(2);
    const formattedSlDistance = this.formatLevel(slDistance, price);

    if (allowLong && longScore >= MIN_SCORE && longScore >= shortScore) {
      return {
        signal: "LONG",
        score: longScore,
        maxScore: MAX_SCORE,
        reasons: longReasons,
        price,
        stopLoss: this.formatLevel(price - slDistance, price),
        takeProfit: this.formatLevel(price + rewardDistance, price),
        slDistance: formattedSlDistance,
        targetPct: effectiveTargetPct,
        setup: "SWING_PULLBACK_LONG",
        confidence:
          longScore >= 10 ? "ALTA" : longScore >= 8 ? "MEDIA" : "MODERADA",
        riskReward: +riskReward.toFixed(2),
        indicators,
      };
    }

    if (allowShort && shortScore >= MIN_SCORE) {
      return {
        signal: "SHORT",
        score: shortScore,
        maxScore: MAX_SCORE,
        reasons: shortReasons,
        price,
        stopLoss: this.formatLevel(price + slDistance, price),
        takeProfit: this.formatLevel(price - rewardDistance, price),
        slDistance: formattedSlDistance,
        targetPct: effectiveTargetPct,
        setup: "SWING_PULLBACK_SHORT",
        confidence:
          shortScore >= 10 ? "ALTA" : shortScore >= 8 ? "MEDIA" : "MODERADA",
        riskReward: +riskReward.toFixed(2),
        indicators,
      };
    }

    return {
      signal: "NONE",
      reason: `Setup ausente (Long:${longScore} Short:${shortScore} Min:${MIN_SCORE}/${MAX_SCORE}) | HTF: ${htfBull ? "BULL" : htfBear ? "BEAR" : "NEUTRAL"}`,
      indicators,
      longScore,
      shortScore,
      maxScore: MAX_SCORE,
    };
  }
}

module.exports = ConservativeStrategy;
