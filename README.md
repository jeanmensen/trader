# NexusSignal

**NexusSignal** é um gerador de sinais de trading para **Binance Futures** que monitora múltiplos ativos simultaneamente e identifica oportunidades de trade com base em análise técnica.

> Modo sinal: o sistema analisa o mercado e gera recomendações — **não executa ordens automaticamente**.

---

## Visão Geral

O NexusSignal (internamente chamado de "Mosaic") exibe um grid com até 27+ criptomoedas em tempo real, destacando as melhores oportunidades de LONG e SHORT conforme os sinais são gerados.

![Dashboard](https://i.imgur.com/placeholder.png)

---

## Funcionalidades

- **Monitoramento multi-símbolo** — acompanha BTC, ETH, SOL, XRP, ADA e outros 20+ pares simultaneamente
- **Estratégia conservadora com 5 pilares:**
  1. Tendência (EMAs rápida/lenta/longa/filtro)
  2. Momentum (RSI com zonas de alta e baixa)
  3. Posição de Preço (Bollinger Bands)
  4. Regime de Mercado (expansão das BBs)
  5. Confirmação de Volume (1.2× média)
- **Sistema de pontuação** — sinais exigem score mínimo de 6/10 para serem gerados
- **Sinais LONG e SHORT** com níveis de stop-loss e take-profit calculados
- **Dashboard em tempo real** via WebSocket com grid colorido (verde = LONG, vermelho = SHORT)
- **Configuração via UI** — alavancagem, risco, SL%, TP%, timeframe e mais
- **Persistência opcional** com PostgreSQL para histórico de sinais

---

## Tech Stack

| Camada | Tecnologias |
|--------|-------------|
| Backend | Node.js, Express, WebSocket (ws), Axios |
| Indicadores | EMA, RSI, Bollinger Bands, ATR (`technicalindicators`) |
| Frontend | Vue.js 3 (CDN), CSS customizado (tema dark) |
| Dados | Binance Futures API (REST + WebSocket) |
| Banco (opcional) | PostgreSQL |
| Outros | Winston (logs), dotenv, node-cron |

---

## Instalação

### Pré-requisitos

- Node.js 18+
- Conta na Binance com API habilitada para Futures
- (Opcional) PostgreSQL

### Passos

```bash
# 1. Clone o repositório
git clone https://github.com/seu-usuario/NexusSignal.git
cd NexusSignal/backend

# 2. Instale as dependências
npm install

# 3. Configure as variáveis de ambiente
cp .env.example .env
# Edite o .env com suas credenciais
```

### Configuração do `.env`

```env
# Binance
BINANCE_API_KEY=sua_chave_aqui
BINANCE_API_SECRET=seu_secret_aqui
USE_TESTNET=true          # true para testnet, false para conta real

# Parâmetros padrão
DEFAULT_TIMEFRAME=15m
DEFAULT_LEVERAGE=3
RISK_PER_TRADE=1.5
STOP_LOSS_PCT=1.5
TAKE_PROFIT_PCT=3.0

# PostgreSQL (opcional)
PGHOST=localhost
PGPORT=5432
PGUSER=postgres
PGPASSWORD=sua_senha
PGDATABASE=trades
```

---

## Uso

```bash
# Desenvolvimento (com hot-reload via nodemon)
npm run dev

# Produção
npm start
```

Acesse o dashboard em: **http://localhost:3001**

1. Clique em **INICIAR ADVISOR** para começar o monitoramento
2. O bot carrega 250 candles históricos por símbolo
3. Assina os streams de kline e ticker em tempo real
4. Gera sinais conforme os candles fecham

---

## API

| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/api/health` | Status do servidor |
| POST | `/api/bot/start` | Inicia o advisor |
| POST | `/api/bot/stop` | Para o advisor |
| GET | `/api/bot/state` | Estado atual e sinais |
| GET | `/api/account` | Saldo na Binance |
| GET | `/api/signal/:symbol` | Sinal para um símbolo |
| PUT | `/api/config` | Atualiza configuração |
| POST | `/api/reconnect` | Reconecta à Binance |

---

## Estrutura do Projeto

```
NexusSignal/
├── backend/
│   ├── server.js          # Servidor Express + WebSocket
│   ├── bot.js             # SignalAdvisor (core do monitoramento)
│   ├── strategy.js        # ConservativeStrategy (análise técnica)
│   ├── binanceClient.js   # Wrapper da API Binance
│   ├── db.js              # Conexão PostgreSQL
│   ├── tradeStore.js      # ORM para histórico de trades
│   ├── logger.js          # Winston logger
│   └── package.json
└── frontend/
    └── index.html         # SPA Vue.js 3
```

---

## Aviso

Este projeto é para fins educacionais e de análise. **Não é conselho financeiro.** Trading de criptomoedas envolve risco significativo de perda. Use testnet antes de conectar a uma conta real.
