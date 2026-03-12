# Nexus Signal

`Nexus Signal` e um painel de sinais para `swing trade` em criptomoedas na Binance Futures.

O projeto monitora um conjunto configuravel de moedas, identifica setups de `LONG`, `SHORT` ou `BOTH`, calcula `stop loss`, `alvo fixo` e exibe as melhores oportunidades em tempo real.

> O sistema gera sinais. Ele nao executa ordens automaticamente.

## O que o projeto faz hoje

- Monitora apenas as moedas selecionadas no painel
- Permite operar em modo `LONG`, `SHORT` ou `BOTH`
- Usa alvo padrao de `3%`
- Calcula `stop`, `risk/reward`, `score` e `confianca`
- Mostra um bloco `Top 5 Swing Agora`
- Exibe os precos em `USD` e `BRL`
- Atualiza dados via WebSocket
- Envia alerta no Telegram quando surge uma nova entrada valida

## Estrategia atual

A logica principal esta em [backend/strategy.js](/abs/path/c:/Users/jeanm/Desktop/NexusSignal/backend/strategy.js).

O motor trabalha com leitura de tendencia e pullback:

- `LONG`: procura tendencia de alta, recuo em zona de valor e retomada
- `SHORT`: procura tendencia de baixa, repique em zona de valor e rejeicao
- `BOTH`: habilita os dois lados e ranqueia os melhores setups

Quando um sinal e aprovado, o sistema retorna:

- `signal`
- `setup`
- `price`
- `stopLoss`
- `takeProfit`
- `targetPct`
- `riskReward`
- `score`
- `confidence`

## Interface atual

O frontend fica em [frontend/index.html](/abs/path/c:/Users/jeanm/Desktop/NexusSignal/frontend/index.html).

O painel tem tres areas principais:

1. `Moedas Monitoradas`
2. `Top 5 Swing Agora`
3. `Mosaico de Ativos`

Recursos atuais da UI:

- selecao de moedas por checkbox
- seletor de direcao: `LONG`, `SHORT` ou `LONG + SHORT`
- salvar configuracao sem reiniciar a aplicacao
- iniciar e parar o monitoramento
- destaque da melhor oportunidade atual
- exibicao de preco em dolar e em real
- cards com `score`, `stop`, `alvo`, `R/R` e viés `HTF`

## Alertas no Telegram

O backend envia notificacoes para o Telegram quando aparece uma nova entrada valida.

Arquivo principal:
- [backend/telegramNotifier.js](/abs/path/c:/Users/jeanm/Desktop/NexusSignal/backend/telegramNotifier.js)

Os alertas funcionam para:

- `LONG`
- `SHORT`

Variaveis esperadas no `backend/.env`:

```env
TELEGRAM_ENABLED=true
TELEGRAM_BOT_TOKEN=seu_token_aqui
TELEGRAM_CHAT_ID=seu_chat_id_aqui
```

Existe tambem um endpoint de teste:

- `POST /api/telegram/test`

## Stack

| Camada | Tecnologias |
|---|---|
| Backend | Node.js, Express, WebSocket (`ws`), Axios |
| Indicadores | `technicalindicators` |
| Frontend | HTML, CSS e JavaScript vanilla |
| Dados | Binance Futures REST + WebSocket |
| Persistencia opcional | PostgreSQL |
| Logs | Winston |

## Estrutura do projeto

```text
NexusSignal/
|-- backend/
|   |-- server.js
|   |-- bot.js
|   |-- strategy.js
|   |-- telegramNotifier.js
|   |-- binanceClient.js
|   |-- tradeStore.js
|   |-- db.js
|   |-- logger.js
|   `-- package.json
|-- frontend/
|   `-- index.html
`-- README.md
```

## Requisitos

- `Node.js 18+`
- conta Binance com API configurada para Futures
- opcionalmente PostgreSQL, se quiser persistencia

## Instalacao

```bash
git clone <seu-repo>
cd NexusSignal/backend
npm install
```

Crie e ajuste o arquivo `.env` em `backend/.env`.

Exemplo:

```env
BINANCE_API_KEY=sua_chave
BINANCE_API_SECRET=seu_segredo
USE_TESTNET=true

DEFAULT_SYMBOL=BTCUSDT
DEFAULT_TIMEFRAME=4h
TRADE_DIRECTION=LONG
DEFAULT_LEVERAGE=2
RISK_PER_TRADE=0.5
STOP_LOSS_PCT=1.2
TAKE_PROFIT_PCT=3.0
MAX_OPEN_TRADES=1

SCAN_SYMBOLS=BTCUSDT,ETHUSDT,SOLUSDT,ARBUSDT

TELEGRAM_ENABLED=true
TELEGRAM_BOT_TOKEN=seu_token_aqui
TELEGRAM_CHAT_ID=seu_chat_id_aqui
```

Valores aceitos para `TRADE_DIRECTION`:

- `LONG`
- `SHORT`
- `BOTH`

## Como executar

No diretorio `backend`:

```bash
npm run dev
```

ou:

```bash
npm start
```

Depois abra:

```text
http://localhost:3001
```

## Fluxo de uso

1. Abra o painel
2. Selecione as moedas que deseja monitorar
3. Escolha a direcao de operacao: `LONG`, `SHORT` ou `LONG + SHORT`
4. Clique em `SALVAR MOEDAS`
5. Clique em `INICIAR`
6. Acompanhe o `Top 5` e o mosaico
7. Receba alertas no Telegram quando houver nova entrada

## API principal

| Metodo | Rota | Uso |
|---|---|---|
| `GET` | `/api/health` | status do servidor |
| `GET` | `/api/config` | configuracao atual |
| `PUT` | `/api/config` | atualiza `scanSymbols`, `tradeDirection` e outros parametros |
| `POST` | `/api/bot/start` | inicia o monitoramento |
| `POST` | `/api/bot/stop` | para o monitoramento |
| `GET` | `/api/bot/state` | estado atual do painel |
| `POST` | `/api/reconnect` | reconecta a Binance |
| `GET` | `/api/account` | consulta saldo |
| `POST` | `/api/telegram/test` | envia mensagem de teste no Telegram |

## Observacoes importantes

- O projeto esta focado em `sinais`, nao em execucao automatica
- A selecao de moedas do frontend usa `scanSymbols`, que o backend reaplica em runtime
- A direcao de operacao usa `tradeDirection` e pode ser alterada sem reiniciar o servidor
- Os niveis de `stop` e `take profit` usam precisao dinamica para moedas baratas
- O valor em `BRL` no frontend depende da cotacao `USD/BRL` consultada no navegador

## Aviso

Este projeto e para fins educacionais e de analise. Nao e conselho financeiro.

Criptomoedas e derivativos envolvem risco alto. Use testnet antes de conectar a conta real.
