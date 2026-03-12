const axios = require("axios");
const logger = require("./logger");

class TelegramNotifier {
  constructor(config = {}) {
    this.enabled = !!config.enabled;
    this.token = config.token || "";
    this.chatId = config.chatId || "";
  }

  isReady() {
    return this.enabled && !!this.token && !!this.chatId;
  }

  async sendEntry(signal) {
    if (!this.isReady() || !signal || !["LONG", "SHORT"].includes(signal.signal)) return false;

    const direction = signal.signal === "SHORT" ? "SHORT" : "LONG";
    const targetPrefix = signal.signal === "SHORT" ? "-" : "+";
    const actionLabel = signal.signal === "SHORT" ? "Recompra" : "Alvo";

    const lines = [
      `Nexus Signal - Nova entrada ${direction}`,
      `${signal.symbol}`,
      `Entrada: ${this.formatPrice(signal.price)}`,
      `Stop: ${this.formatPrice(signal.stopLoss)}`,
      `${actionLabel} ${targetPrefix}${Number(signal.targetPct || 0).toFixed(1)}%: ${this.formatPrice(signal.takeProfit)}`,
      `Score: ${signal.score}/${signal.maxScore || 10}`,
      `Confianca: ${signal.confidence || "--"}`,
      `R/R: ${Number(signal.riskReward || 0).toFixed(2)}x`,
    ];

    try {
      await axios.post(`https://api.telegram.org/bot${this.token}/sendMessage`, {
        chat_id: this.chatId,
        text: lines.join("\n"),
      }, {
        timeout: 10000,
      });
      return true;
    } catch (error) {
      logger.warn(`Telegram notify failed: ${error.response?.data?.description || error.message}`);
      return false;
    }
  }

  async sendTestMessage() {
    if (!this.isReady()) return false;
    try {
      await axios.post(`https://api.telegram.org/bot${this.token}/sendMessage`, {
        chat_id: this.chatId,
        text: "Nexus Signal - teste de integracao com Telegram OK.",
      }, {
        timeout: 10000,
      });
      return true;
    } catch (error) {
      logger.warn(`Telegram test failed: ${error.response?.data?.description || error.message}`);
      return false;
    }
  }

  formatPrice(value) {
    const price = Number(value);
    if (!Number.isFinite(price)) return "---";
    if (price >= 1000) return `$${price.toFixed(2)}`;
    if (price >= 1) return `$${price.toFixed(4)}`;
    if (price >= 0.01) return `$${price.toFixed(6)}`;
    return `$${price.toFixed(8)}`;
  }
}

module.exports = TelegramNotifier;
