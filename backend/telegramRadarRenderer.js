function formatPrice(value) {
  const price = Number(value);
  if (!Number.isFinite(price)) return "---";
  if (price >= 1000) return `$${price.toFixed(2)}`;
  if (price >= 1) return `$${price.toFixed(4)}`;
  if (price >= 0.01) return `$${price.toFixed(6)}`;
  return `$${price.toFixed(8)}`;
}

function mapTrendColor(trend) {
  if (trend === "ALTA") return "#00e58b";
  if (trend === "BAIXA") return "#ff5c72";
  return "#7f8da6";
}

function mapScenarioLabel(value) {
  const labels = {
    CONTINUACAO_DE_ALTA: "Continuacao de alta",
    PULLBACK_DE_ALTA: "Pullback de alta",
    CONTINUACAO_DE_BAIXA: "Continuacao de baixa",
    PULLBACK_DE_BAIXA: "Pullback de baixa",
    ROMPIMENTO_PENDENTE: "Rompimento pendente",
    CONSOLIDACAO: "Consolidacao",
  };
  return labels[value] || value || "--";
}

function describeSignal(signalType) {
  if (signalType === "LONG") return "Sinal atual: Compra";
  if (signalType === "SHORT") return "Sinal atual: Venda";
  return "Sinal atual: Sem setup";
}

function describeMarket(trend, scenario) {
  if (trend === "ALTA") return "Mercado geral: Tendencia de alta";
  if (trend === "BAIXA") return "Mercado geral: Tendencia de baixa";
  if (scenario === "ROMPIMENTO_PENDENTE") return "Mercado geral: Andando de lado, perto de rompimento";
  return "Mercado geral: Andando de lado";
}

function describeProjection(signalType, trend) {
  if (signalType === "LONG") return "Leitura visual: compra de curto prazo";
  if (signalType === "SHORT") return "Leitura visual: venda de curto prazo";
  if (trend === "ALTA") return "Leitura visual: forca compradora";
  if (trend === "BAIXA") return "Leitura visual: forca vendedora";
  return "Leitura visual: sem direcao forte";
}

function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function getProjectionPoints(candles, signal) {
  if (!Array.isArray(candles) || !candles.length) return [];
  const closes = candles.map((c) => Number(c.close));
  const lastClose = closes[closes.length - 1];
  const indicators = signal?.indicators || {};
  const atr = Number(indicators.atr || 0);
  const trend = indicators.trend || "LATERAL";
  const scenario = indicators.trendScenario || "CONSOLIDACAO";
  const signalType = signal?.signal || "NONE";
  const points = [];
  let drift = 0;

  if (signalType === "LONG") drift = atr * 0.35;
  else if (signalType === "SHORT") drift = -atr * 0.35;
  else {
    if (trend === "ALTA") drift = atr * 0.45;
    else if (trend === "BAIXA") drift = -atr * 0.45;
    if (scenario.includes("PULLBACK")) drift *= 0.35;
    if (trend === "LATERAL") drift = 0;
  }

  for (let i = 1; i <= 5; i += 1) {
    const wave =
      signalType === "LONG"
        ? Math.abs(Math.sin(i)) * atr * 0.08
        : signalType === "SHORT"
          ? -Math.abs(Math.sin(i)) * atr * 0.08
          : trend === "LATERAL"
            ? Math.sin(i) * atr * 0.25
            : 0;
    const value = lastClose + drift * i + wave;
    points.push({
      value,
      high: value + atr * 0.5,
      low: value - atr * 0.5,
    });
  }

  return points;
}

function buildChartGeometry(candles, signal) {
  const recent = candles.slice(-80);
  const closes = recent.map((c) => Number(c.close));
  const projection = getProjectionPoints(recent, signal);
  const allValues = closes.concat(projection.flatMap((point) => [point.high, point.low]));
  const min = Math.min(...allValues);
  const max = Math.max(...allValues);
  const range = Math.max(max - min, Math.max(max * 0.01, 1e-8));
  const width = 1080;
  const height = 640;
  const leftPad = 60;
  const topPad = 250;
  const plotWidth = 760;
  const plotHeight = 300;
  const projectionWidth = 180;
  const step = plotWidth / Math.max(recent.length - 1, 1);

  const yOf = (value) => topPad + ((max - value) / range) * plotHeight;
  const xOf = (index) => leftPad + index * step;
  const projectXOf = (index) => leftPad + plotWidth + (projectionWidth / 5) * index;

  const linePath = closes
    .map((value, index) => `${index === 0 ? "M" : "L"} ${xOf(index).toFixed(2)} ${yOf(value).toFixed(2)}`)
    .join(" ");
  const projectionPath = projection
    .map((point, index) => `${index === 0 ? "M" : "L"} ${projectXOf(index + 1).toFixed(2)} ${yOf(point.value).toFixed(2)}`)
    .join(" ");
  const areaPath = projection.length
    ? [
        `M ${projectXOf(1).toFixed(2)} ${yOf(projection[0].high).toFixed(2)}`,
        ...projection.map((point, index) => `L ${projectXOf(index + 1).toFixed(2)} ${yOf(point.high).toFixed(2)}`),
        ...projection
          .slice()
          .reverse()
          .map((point, revIndex) => {
            const index = projection.length - revIndex;
            return `L ${projectXOf(index).toFixed(2)} ${yOf(point.low).toFixed(2)}`;
          }),
        "Z",
      ].join(" ")
    : "";

  return {
    width,
    height,
    leftPad,
    topPad,
    plotWidth,
    plotHeight,
    linePath,
    projectionPath,
    areaPath,
  };
}

function renderMetric(x, y, label, value, color = "#d6e8ff") {
  return `
    <text x="${x}" y="${y}" fill="#6f8fb1" font-size="16" font-family="'Share Tech Mono', monospace">${escapeXml(label)}</text>
    <text x="${x}" y="${y + 30}" fill="${color}" font-size="24" font-family="'Share Tech Mono', monospace">${escapeXml(value)}</text>
  `;
}

function renderRadarSvg(payload = {}) {
  const signal =
    payload.signal && typeof payload.signal === "object"
      ? payload.signal
      : payload;
  const candles = Array.isArray(payload.candles) ? payload.candles : [];
  if (!candles.length) return null;

  const indicators = signal.indicators || {};
  const trend = indicators.trend || "LATERAL";
  const trendColor = mapTrendColor(trend);
  const scenario = mapScenarioLabel(indicators.trendScenario);
  const strength = indicators.trendStrength || "--";
  const htf = indicators.htfBias || "--";
  const projection = `${Number(indicators.projectedMovePct || 0).toFixed(2)}% / 5 candles`;
  const signalLabel = describeSignal(signal.signal);
  const marketLabel = describeMarket(trend, indicators.trendScenario);
  const projectionLabel = describeProjection(signal.signal, trend);
  const chart = buildChartGeometry(candles, signal);
  const timestamp = payload.time ? new Date(payload.time).toLocaleString("pt-BR") : new Date().toLocaleString("pt-BR");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${chart.width}" height="${chart.height}" viewBox="0 0 ${chart.width} ${chart.height}">
  <defs>
    <linearGradient id="bg" x1="0" x2="1" y1="0" y2="1">
      <stop offset="0%" stop-color="#08101d" />
      <stop offset="100%" stop-color="#13263e" />
    </linearGradient>
    <linearGradient id="forecast-fill" x1="0" x2="0" y1="0" y2="1">
      <stop offset="0%" stop-color="${trendColor}" stop-opacity="0.28" />
      <stop offset="100%" stop-color="${trendColor}" stop-opacity="0.05" />
    </linearGradient>
  </defs>

  <rect x="0" y="0" width="${chart.width}" height="${chart.height}" rx="28" fill="url(#bg)" />
  <rect x="24" y="24" width="${chart.width - 48}" height="${chart.height - 48}" rx="22" fill="rgba(7,17,31,0.55)" stroke="rgba(55,200,255,0.18)" />

  <text x="60" y="72" fill="#6f8fb1" font-size="18" font-family="'Share Tech Mono', monospace">${escapeXml(payload.symbol || "--")} · ${escapeXml(String(payload.timeframe || "--").toUpperCase())}</text>
  <text x="60" y="122" fill="${trendColor}" font-size="44" font-weight="700" font-family="'Share Tech Mono', monospace">${escapeXml(trend)}</text>
  <text x="60" y="156" fill="#d6e8ff" font-size="20" font-family="'Share Tech Mono', monospace">${escapeXml(signalLabel)}</text>
  <text x="60" y="184" fill="#6f8fb1" font-size="16" font-family="'Share Tech Mono', monospace">${escapeXml(marketLabel)}</text>
  <text x="860" y="72" fill="#6f8fb1" font-size="16" text-anchor="end" font-family="'Share Tech Mono', monospace">Radar de tendencia</text>
  <text x="860" y="102" fill="#d6e8ff" font-size="18" text-anchor="end" font-family="'Share Tech Mono', monospace">${escapeXml(timestamp)}</text>

  ${renderMetric(60, 200, "CENARIO", scenario)}
  ${renderMetric(320, 200, "FORCA", strength)}
  ${renderMetric(500, 200, "HTF", htf)}
  ${renderMetric(650, 200, "RSI", indicators.rsi != null ? Number(indicators.rsi).toFixed(1) : "--")}
  ${renderMetric(820, 200, "VOL", `${indicators.volRatio || "--"}x`)}

  ${renderMetric(60, 560, "ENTRADA", formatPrice(signal.price))}
  ${renderMetric(250, 560, "ATUAL", formatPrice(signal.currentPrice || signal.price))}
  ${renderMetric(440, 560, "ALVO", formatPrice(signal.takeProfit), "#00e58b")}
  ${renderMetric(610, 560, "STOP", formatPrice(signal.stopLoss), "#ff5c72")}
  ${renderMetric(760, 560, "R/R", `${Number(signal.riskReward || 0).toFixed(2)}x`)}
  ${renderMetric(900, 560, "PROJECAO", projection)}

  <rect x="${chart.leftPad - 16}" y="${chart.topPad - 24}" width="${chart.plotWidth + 44}" height="${chart.plotHeight + 48}" rx="18" fill="rgba(4,10,19,0.35)" />
  <line x1="${chart.leftPad + chart.plotWidth}" y1="${chart.topPad}" x2="${chart.leftPad + chart.plotWidth}" y2="${chart.topPad + chart.plotHeight}" stroke="rgba(111,143,177,0.35)" stroke-dasharray="6 6" />
  <path d="${chart.areaPath}" fill="url(#forecast-fill)" />
  <path d="${chart.linePath}" fill="none" stroke="#d6e8ff" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" />
  <path d="${chart.projectionPath}" fill="none" stroke="${trendColor}" stroke-width="4" stroke-dasharray="10 8" stroke-linecap="round" stroke-linejoin="round" />

  <text x="${chart.leftPad + chart.plotWidth + 12}" y="${chart.topPad + 16}" fill="#6f8fb1" font-size="16" font-family="'Share Tech Mono', monospace">leitura visual</text>
  <text x="60" y="612" fill="#6f8fb1" font-size="14" font-family="'Share Tech Mono', monospace">${escapeXml(projectionLabel)}. Nao e previsao exata.</text>
</svg>`;
}

module.exports = {
  renderRadarSvg,
};
