// db.js - optional PostgreSQL pool
const logger = require("./logger");

let pool = null;
let pgLoaded = false;

function isPlaceholderHost(host) {
  if (!host) return true;
  const normalized = String(host).trim().toLowerCase();
  return normalized === "host" || normalized === "<host>" || normalized === "your_host";
}

function getDatabaseHostFromUrl(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function getPgPool() {
  if (pool) return pool;

  const dbUrl = process.env.DATABASE_URL || "";
  const pgHost = process.env.PGHOST || "";
  const dbHost = dbUrl ? getDatabaseHostFromUrl(dbUrl) : pgHost;

  if (isPlaceholderHost(dbHost)) {
    logger.warn("Postgres desabilitado: host do banco nao configurado (ex.: localhost)");
    return null;
  }

  const hasDbConfig =
    !!dbUrl ||
    (!!process.env.PGHOST &&
      !!process.env.PGUSER &&
      !!process.env.PGDATABASE);

  if (!hasDbConfig) {
    logger.warn("Postgres desabilitado: variáveis DATABASE_URL/PG* não definidas");
    return null;
  }

  let Pool;
  try {
    ({ Pool } = require("pg"));
    pgLoaded = true;
  } catch (e) {
    logger.warn("Postgres desabilitado: pacote 'pg' não instalado");
    return null;
  }

  pool = new Pool(
    dbUrl
      ? { connectionString: dbUrl }
      : {
          host: process.env.PGHOST,
          port: parseInt(process.env.PGPORT || "5432", 10),
          user: process.env.PGUSER,
          password: process.env.PGPASSWORD || "",
          database: process.env.PGDATABASE,
        },
  );

  pool.on("error", (err) => {
    logger.error(`Postgres pool error: ${err.message}`);
  });

  logger.info("Postgres habilitado para persistência de histórico");
  return pool;
}

module.exports = {
  getPgPool,
  isPgLoaded: () => pgLoaded,
};
