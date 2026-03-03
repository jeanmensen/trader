// tradeStore.js - optional PostgreSQL persistence for trade history
class TradeStore {
  constructor(db) {
    this.db = db;
    this.enabled = !!db;
  }

  async init() {
    if (!this.enabled) return;
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS trade_history (
        id TEXT PRIMARY KEY,
        symbol TEXT NOT NULL,
        side TEXT NOT NULL,
        size DOUBLE PRECISION NOT NULL,
        entry_price DOUBLE PRECISION NOT NULL,
        stop_loss DOUBLE PRECISION,
        take_profit DOUBLE PRECISION,
        score INTEGER,
        reasons JSONB,
        open_time TIMESTAMPTZ NOT NULL,
        close_time TIMESTAMPTZ,
        close_price DOUBLE PRECISION,
        pnl DOUBLE PRECISION,
        status TEXT NOT NULL DEFAULT 'OPEN',
        close_reason TEXT
      );
    `);
  }

  async loadRecent(limit = 200) {
    if (!this.enabled) return [];
    const safeLimit = Math.max(1, Math.min(limit, 1000));
    const { rows } = await this.db.query(
      `
      SELECT
        id,
        symbol,
        side,
        size,
        entry_price AS "entryPrice",
        stop_loss AS "stopLoss",
        take_profit AS "takeProfit",
        score,
        reasons,
        open_time AS "openTime",
        close_time AS "closeTime",
        close_price AS "closePrice",
        pnl,
        status,
        close_reason AS "closeReason"
      FROM trade_history
      ORDER BY open_time DESC
      LIMIT $1
      `,
      [safeLimit],
    );
    return rows.map((r) => ({
      ...r,
      reasons: Array.isArray(r.reasons) ? r.reasons : [],
    }));
  }

  async insertOpenTrade(trade) {
    if (!this.enabled) return;
    await this.db.query(
      `
      INSERT INTO trade_history (
        id, symbol, side, size, entry_price, stop_loss, take_profit,
        score, reasons, open_time, status
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7,
        $8, $9::jsonb, $10, 'OPEN'
      )
      ON CONFLICT (id) DO NOTHING
      `,
      [
        trade.id,
        trade.symbol,
        trade.side,
        trade.size,
        trade.entryPrice,
        trade.stopLoss ?? null,
        trade.takeProfit ?? null,
        trade.score ?? null,
        JSON.stringify(trade.reasons || []),
        trade.openTime,
      ],
    );
  }

  async closeTrade(trade) {
    if (!this.enabled) return;
    await this.db.query(
      `
      UPDATE trade_history
      SET
        close_time = $2,
        close_price = $3,
        pnl = $4,
        status = 'CLOSED',
        close_reason = $5
      WHERE id = $1
      `,
      [
        trade.id,
        trade.closeTime ?? new Date().toISOString(),
        trade.closePrice ?? null,
        trade.pnl ?? null,
        trade.closeReason ?? null,
      ],
    );
  }
}

module.exports = TradeStore;
