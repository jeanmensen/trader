# NEXUS TRADE - Binance Futures Bot (Node.js)

Bot de day trading conservador para futuros da Binance com painel web.

## Stack
- Backend: Node.js + Express + WebSocket (`ws`)
- Trading: Binance Futures REST API + WebSocket Streams
- Estrategia: EMA 9/21/50 + EMA200 (filtro HTF) + RSI + Bollinger Bands + ATR
- Frontend: HTML5 + Chart.js

## Estrutura
```text
trader/
|-- backend/
|   |-- server.js
|   |-- bot.js
|   |-- strategy.js
|   |-- binanceClient.js
|   |-- logger.js
|   `-- package.json
`-- frontend/
    `-- index.html
```

## Instalacao
```bash
cd backend
npm install
npm start
```

Painel: `http://localhost:3001`

## Endpoints
| Metodo | Rota | Descricao |
|---|---|---|
| GET | `/api/health` | Status do servidor |
| POST | `/api/reconnect` | Reconectar usando credenciais do `.env` |
| GET | `/api/config` | Obter configuracao |
| PUT | `/api/config` | Atualizar configuracao |
| POST | `/api/bot/start` | Iniciar bot |
| POST | `/api/bot/stop` | Parar bot |
| GET | `/api/bot/state` | Estado do bot |
| GET | `/api/account` | Saldo e posicoes |
| GET | `/api/market/:symbol` | Dados de mercado + candles |
| GET | `/api/signal/:symbol` | Analise de sinal |
| GET | `/api/positions` | Posicoes abertas |
| POST | `/api/positions/close` | Fechar uma posicao especifica |
| POST | `/api/positions/close-all` | Fechar todas as posicoes |
| POST | `/api/order` | Ordem manual |
| GET | `/api/orders/:symbol` | Historico de ordens |

## Estrategia Conservadora
- Score maximo: 10
- Score minimo de entrada: 6
- Filtro HTF: bloqueia trade contra EMA200
- Stop/Take:
- Se `STOP_LOSS_PCT` e `TAKE_PROFIT_PCT` estiverem definidos, usa percentuais fixos
- Caso contrario, usa ATR (`atrMult`) com R:R padrao de 1:2

## Gestao de risco
- Risco por trade: `RISK_PER_TRADE` (%)
- Tamanho de posicao calculado pela distancia real ate o stop
- Limite diario: 3% do saldo (com PnL realizado do dia)
- Maximo de trades abertos: `MAX_OPEN_TRADES`

## Variaveis de ambiente
| Variavel | Padrao | Descricao |
|---|---|---|
| `BINANCE_API_KEY` | - | API Key |
| `BINANCE_API_SECRET` | - | API Secret |
| `USE_TESTNET` | `true` | Usar testnet |
| `PORT` | `3001` | Porta do servidor |
| `DEFAULT_SYMBOL` | `BTCUSDT` | Par padrao |
| `DEFAULT_TIMEFRAME` | `15m` | Timeframe padrao |
| `DEFAULT_LEVERAGE` | `2` | Alavancagem padrao |
| `RISK_PER_TRADE` | `0.5` | Risco por trade (%) |
| `STOP_LOSS_PCT` | `1.0` | Distancia do stop (%) |
| `TAKE_PROFIT_PCT` | `2.0` | Distancia do alvo (%) |
| `MAX_OPEN_TRADES` | `1` | Max trades simultaneos |
