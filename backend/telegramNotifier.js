const axios = require("axios");
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const logger = require("./logger");
const { renderRadarSvg } = require("./telegramRadarRenderer");

class TelegramNotifier {
  constructor(config = {}) {
    this.enabled = !!config.enabled;
    this.token = config.token || "";
    this.storagePath =
      config.storagePath || path.join(__dirname, "data", "telegram-chats.json");
    this.chatIds = new Set(this.parseChatIds(config.chatId));
    this.pollOffset = 0;
    this.pollTimer = null;
    this.polling = false;

    this.loadStoredChats();
    this.startPolling();
  }

  setEnabled(enabled) {
    this.enabled = !!enabled;
    if (this.enabled) {
      this.startPolling();
      return;
    }
    this.polling = false;
    clearTimeout(this.pollTimer);
  }

  isReady() {
    return this.enabled && !!this.token && this.chatIds.size > 0;
  }

  hasCredentials() {
    return this.enabled && !!this.token;
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
      `Atual: ${this.formatPrice(signal.currentPrice || signal.price)}`,
      `Stop: ${this.formatPrice(signal.stopLoss)}`,
      `${actionLabel} ${targetPrefix}${Number(signal.targetPct || 0).toFixed(1)}%: ${this.formatPrice(signal.takeProfit)}`,
      `Score: ${signal.score}/${signal.maxScore || 12}`,
      `Confianca: ${signal.confidence || "--"}`,
      `R/R: ${Number(signal.riskReward || 0).toFixed(2)}x`,
    ];

    try {
      const sentText = await this.sendMessage(lines.join("\n"));
      const sentRadar = await this.sendRadar(signal);
      return sentText || sentRadar;
    } catch (error) {
      logger.warn(`Telegram notify failed: ${error.response?.data?.description || error.message}`);
      return false;
    }
  }

  async sendTestMessage() {
    if (!this.isReady()) return false;
    try {
      return await this.sendMessage("Nexus Signal - teste de integracao com Telegram OK.");
    } catch (error) {
      logger.warn(`Telegram test failed: ${error.response?.data?.description || error.message}`);
      return false;
    }
  }

  async sendMessage(text) {
    if (!this.isReady()) return false;

    const results = await Promise.allSettled(
      [...this.chatIds].map((chatId) =>
        axios.post(
          `https://api.telegram.org/bot${this.token}/sendMessage`,
          {
            chat_id: chatId,
            text,
          },
          {
            timeout: 10000,
          },
        ),
      ),
    );

    results.forEach((result) => {
      if (result.status === "rejected") {
        const error = result.reason;
        logger.warn(`Telegram send failed: ${error.response?.data?.description || error.message}`);
      }
    });

    return results.some((result) => result.status === "fulfilled");
  }

  async sendRadar(signal) {
    const svg = renderRadarSvg(signal);
    if (!svg) return false;
    const png = await this.renderRadarPng(svg);
    if (!png) return false;

    const results = await Promise.allSettled(
      [...this.chatIds].map((chatId) => this.sendPhoto(chatId, png, signal)),
    );

    results.forEach((result) => {
      if (result.status === "rejected") {
        const error = result.reason;
        logger.warn(`Telegram radar send failed: ${error.response?.data?.description || error.message}`);
      }
    });

    return results.some((result) => result.status === "fulfilled" && result.value);
  }

  parseChatIds(raw) {
    return String(raw || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
  }

  loadStoredChats() {
    try {
      if (!fs.existsSync(this.storagePath)) return;
      const saved = JSON.parse(fs.readFileSync(this.storagePath, "utf8"));
      for (const chatId of Array.isArray(saved?.chatIds) ? saved.chatIds : []) {
        if (chatId) this.chatIds.add(String(chatId));
      }
    } catch (error) {
      logger.warn(`Telegram chat storage load failed: ${error.message}`);
    }
  }

  persistChats() {
    try {
      fs.mkdirSync(path.dirname(this.storagePath), { recursive: true });
      fs.writeFileSync(
        this.storagePath,
        JSON.stringify({ chatIds: [...this.chatIds] }, null, 2),
        "utf8",
      );
    } catch (error) {
      logger.warn(`Telegram chat storage save failed: ${error.message}`);
    }
  }

  startPolling() {
    if (!this.hasCredentials() || this.polling) return;
    this.polling = true;
    this.scheduleNextPoll(0);
  }

  scheduleNextPoll(delayMs = 3000) {
    clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => {
      this.pollUpdates().catch((error) => {
        logger.warn(`Telegram polling failed: ${error.response?.data?.description || error.message}`);
        this.scheduleNextPoll(5000);
      });
    }, delayMs);
  }

  async pollUpdates() {
    if (!this.hasCredentials()) {
      this.polling = false;
      return;
    }

    const response = await axios.get(`https://api.telegram.org/bot${this.token}/getUpdates`, {
      params: {
        offset: this.pollOffset,
        timeout: 25,
        allowed_updates: JSON.stringify(["message"]),
      },
      timeout: 30000,
    });

    const updates = Array.isArray(response.data?.result) ? response.data.result : [];
    for (const update of updates) {
      this.pollOffset = Math.max(this.pollOffset, Number(update.update_id || 0) + 1);
      await this.handleUpdate(update);
    }

    this.scheduleNextPoll(updates.length > 0 ? 0 : 1000);
  }

  async handleUpdate(update) {
    const message = update?.message;
    const chatId = message?.chat?.id;
    if (!chatId) return;

    const text = String(message.text || "").trim();
    const isNewChat = this.registerChat(chatId);
    if (!text) return;

    if (isNewChat) {
      await this.sendDirectMessage(
        chatId,
        "Nexus Signal conectado neste chat. Voce vai receber os proximos alertas por aqui.",
      );
      logger.info(`Telegram chat registrado: ${chatId}`);
      return;
    }

    if (["/start", "/subscribe", "/status"].includes(text.toLowerCase())) {
      await this.sendDirectMessage(
        chatId,
        `Nexus Signal ativo neste chat. Total de chats inscritos: ${this.chatIds.size}.`,
      );
    }
  }

  registerChat(chatId) {
    const normalized = String(chatId || "").trim();
    if (!normalized || this.chatIds.has(normalized)) return false;
    this.chatIds.add(normalized);
    this.persistChats();
    return true;
  }

  async sendDirectMessage(chatId, text) {
    try {
      await axios.post(
        `https://api.telegram.org/bot${this.token}/sendMessage`,
        {
          chat_id: chatId,
          text,
        },
        {
          timeout: 10000,
        },
      );
      return true;
    } catch (error) {
      logger.warn(`Telegram direct reply failed: ${error.response?.data?.description || error.message}`);
      return false;
    }
  }

  async sendDocument(chatId, svg, signal) {
    try {
      const form = new FormData();
      form.append("chat_id", String(chatId));
      form.append(
        "caption",
        `${signal.symbol || "ATIVO"} | ${signal.signal || "SETUP"} | radar de tendencia`,
      );
      form.append(
        "document",
        new Blob([svg], { type: "image/svg+xml" }),
        `${signal.symbol || "radar"}-trend-radar.svg`,
      );

      const response = await fetch(`https://api.telegram.org/bot${this.token}/sendDocument`, {
        method: "POST",
        body: form,
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data?.description || `HTTP ${response.status}`);
      }

      return true;
    } catch (error) {
      logger.warn(`Telegram document failed: ${error.message}`);
      return false;
    }
  }

  async renderRadarPng(svg) {
    try {
      return await sharp(Buffer.from(svg)).png().toBuffer();
    } catch (error) {
      logger.warn(`Telegram PNG render failed: ${error.message}`);
      return null;
    }
  }

  async sendPhoto(chatId, png, signal) {
    try {
      const form = new FormData();
      form.append("chat_id", String(chatId));
      form.append(
        "caption",
        `${signal.symbol || "ATIVO"} | ${signal.signal || "SETUP"} | radar de tendencia`,
      );
      form.append(
        "photo",
        new Blob([png], { type: "image/png" }),
        `${signal.symbol || "radar"}-trend-radar.png`,
      );

      const response = await fetch(`https://api.telegram.org/bot${this.token}/sendPhoto`, {
        method: "POST",
        body: form,
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data?.description || `HTTP ${response.status}`);
      }

      return true;
    } catch (error) {
      logger.warn(`Telegram photo failed: ${error.message}`);
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
