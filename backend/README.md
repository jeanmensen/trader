# 🚀 NEXUS TRADE — Binance Futures Bot (Node.js)

Bot de day trading conservador para futuros da Binance com painel web completo.

## ⚡ Stack
- **Backend**: Node.js + Express + WebSocket (`ws`)
- **Trading**: Binance Futures REST API + WebSocket Streams
- **Estratégia**: EMA Cross (9/21/50) + RSI(14) + Bollinger Bands + MACD + ATR
- **Frontend**: HTML5 + Chart.js (sem framework)

## 📁 Estrutura
```
trading-app/
├── backend/
│   ├── server.js          # Express + WebSocket server
│   ├── bot.js             # Engine do bot (ciclos, ordens, risk mgmt)
│   ├── strategy.js        # Estratégia conservadora (indicadores)
│   ├── binanceClient.js   # Client REST + WS da Binance
│   ├── logger.js          # Winston logger
│   ├── package.json
│   └── .env.example       # Template de variáveis de ambiente
└── frontend/
    └── index.html         # Painel web completo
```

## 🛠 Instalação

### 1. Clonar e instalar dependências
```bash
cd trading-app/backend
npm install
```

### 2. Configurar variáveis de ambiente
```bash
cp .env.example .env
# Edite .env com suas credenciais
```

### 3. Configurar API Key na Binance
1. Acesse https://testnet.binancefuture.com (para testes)
2. Crie uma conta de testnet
3. Gere API Key + Secret
4. **NUNCA** use a API da conta real para testar!

### 4. Iniciar o servidor
```bash
npm start
# ou para desenvolvimento:
npm run dev
```

### 5. Acessar o painel
```
http://localhost:3001
```

## 🌐 Endpoints da API

| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/api/health` | Status do servidor |
| POST | `/api/connect` | Conectar à Binance |
| GET | `/api/config` | Obter configuração |
| PUT | `/api/config` | Atualizar configuração |
| POST | `/api/bot/start` | Iniciar bot |
| POST | `/api/bot/stop` | Parar bot |
| GET | `/api/bot/state` | Estado atual do bot |
| GET | `/api/account` | Saldo e posições |
| GET | `/api/market/:symbol` | Dados de mercado + candles |
| GET | `/api/signal/:symbol` | Análise de sinal atual |
| GET | `/api/positions` | Posições abertas |
| POST | `/api/positions/close-all` | Fechar todas posições |
| POST | `/api/order` | Ordem manual |
| GET | `/api/orders/:symbol` | Histórico de ordens |

## 📡 WebSocket

Conecte em `ws://localhost:3001/ws` para receber eventos em tempo real:

```javascript
// Tipos de mensagem:
{ type: 'state',        data: { running, positions, trades, logs } }
{ type: 'signal',       data: { signal, price, stopLoss, takeProfit, score } }
{ type: 'positions',    data: [...] }
{ type: 'log',          data: { time, msg, level } }
{ type: 'bot_status',   data: { running: boolean } }
{ type: 'trade_opened', data: { id, symbol, side, ... } }
```

## 📊 Estratégia Conservadora

### Indicadores Utilizados
- **EMA 9/21/50**: Crossover e alinhamento de tendência
- **RSI 14**: Filtro de momentum (zona 35-65)
- **Bollinger Bands 20,2**: Filtro de posição do preço
- **MACD 12/26/9**: Confirmação de momentum
- **ATR 14**: Cálculo dinâmico de Stop Loss

### Regras de Entrada LONG
1. EMA 9 cruzou acima da EMA 21 (Golden Cross) **OU** EMA 9 > 21 > 50
2. RSI entre 45 e 65 e crescente
3. Preço acima da EMA 21
4. Preço entre BB Middle e BB Upper
5. MACD Histograma positivo e crescente
6. Volume acima da média (ratio > 1.1)
7. **Score mínimo: 7/12 pontos**

### Gestão de Risco
- **Stop Loss**: ATR × 1.5 (dinâmico)
- **Take Profit**: SL × 2.0 (R:R mínimo 1:2)
- **Risco por trade**: 1.5% do saldo
- **Máx. trades simultâneos**: 2
- **Stop diário**: 3% do saldo

## ⚠️ Avisos Importantes

1. **SEMPRE teste em testnet antes de usar capital real**
2. Este bot não garante lucros — trading envolve risco de perda
3. Ajuste os parâmetros de risco de acordo com seu perfil
4. Monitore o bot regularmente
5. Nunca invista mais do que pode perder

## 🔧 Variáveis de Ambiente

| Variável | Padrão | Descrição |
|----------|--------|-----------|
| `BINANCE_API_KEY` | — | Sua API Key |
| `BINANCE_API_SECRET` | — | Sua API Secret |
| `USE_TESTNET` | `true` | Usar testnet |
| `PORT` | `3001` | Porta do servidor |
| `DEFAULT_SYMBOL` | `BTCUSDT` | Par padrão |
| `DEFAULT_LEVERAGE` | `3` | Alavancagem padrão |
| `RISK_PER_TRADE` | `1.5` | % de risco por trade |
| `STOP_LOSS_PCT` | `1.5` | % de stop loss |
| `TAKE_PROFIT_PCT` | `3.0` | % de take profit |
| `MAX_OPEN_TRADES` | `2` | Máx trades simultâneos |
