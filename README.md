## Kelly Weather Trading Bot

High‑accuracy, Kelly‑driven **weather trading bot for Polymarket**.  
It scans NWS forecasts, finds mispriced temperature markets, and simulates trades into `simulation.json` to help you track performance and refine your strategy.

## Prove of Work

https://github.com/user-attachments/assets/b63a204b-350d-42b3-a676-d193c2f04bc5

### Install

```bash
cd weatherbot-ts
npm install
```

Create a `.env` file in the project root (next to `package.json`):

```env
POLYMARKET_PRIVATE_KEY=0x...64 hex...
POLYMARKET_PROXY_WALLET_ADDRESS=0x...40 hex...
ENTRY_THRESHOLD=0.15
EXIT_THRESHOLD=0.45
MAX_TRADES_PER_RUN=5
MIN_HOURS_TO_RESOLUTION=2
LOCATIONS="nyc,chicago,miami,dallas,seattle,atlanta"
```

All runtime configuration is read from `.env` (not `config.json`).  
On startup the bot validates that `POLYMARKET_PRIVATE_KEY` and `POLYMARKET_PROXY_WALLET_ADDRESS` are present and look like valid EVM strings; if not, it prints an error and exits.

### Build

```bash
npm run build
```

### Usage

```bash
# paper mode — shows signals, no trades
node dist/index.js

# simulate trades with $1,000 balance
node dist/index.js --live

# run every 30 minutes
node dist/index.js --live --interval 30

# reset balance back to $1,000
node dist/index.js --reset

# show open positions and PnL
node dist/index.js --positions
```

You can also run the live bot and dashboard server together:

```bash
npm run dev-live-dashboard
```

This starts `ts-node src/index.ts --live --interval 1` and `http-server . -p 8000` in parallel, and the dashboard at `sim_dashboard_repost.html` reads from `simulation.json` in this folder.

### Paid version

There is a **paid edition** of this bot that adds more advanced, production‑grade features for serious weather trading on Polymarket, including:

- Enhanced Kelly sizing and risk controls  
- Extended market coverage and smarter filtering  
- Deeper analytics and monitoring for live trading  

If you are interested in the paid version, please reach out via the contact links provided with the project.
