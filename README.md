# Tradio

Nate's AI-powered crypto trading bot. Uses Claude AI to analyze market data and execute leveraged trades on [Lighter](https://lighter.xyz) (zkLighter DEX).

## How it works

1. Fetches candlestick data (5m + 4h) for SOL, ZEC, and HYPE markets
2. Calculates technical indicators (EMA20, MACD)
3. Sends market data + portfolio state to Claude Sonnet 4.6 (via DigitalOcean inference)
4. The AI decides whether to open/close positions using tool calls
5. Executes trades on Lighter via the Python SDK
6. Repeats every 5 minutes

## Stack

- **Runtime**: [Bun](https://bun.sh)
- **AI**: Claude Sonnet 4.6 via [DigitalOcean Gradient](https://docs.digitalocean.com/products/gradient-ai-platform/)
- **Exchange**: [Lighter](https://lighter.xyz) (zkLighter DEX)
- **Database**: MongoDB (via Prisma)
- **Trading SDK**: [lighter-sdk](https://pypi.org/project/lighter-sdk/) (Python)

## Prerequisites

- [Bun](https://bun.sh) v1.3+
- [Python 3.13+](https://python.org) with `lighter-sdk` installed
- [MongoDB](https://www.mongodb.com/) running as a replica set
- A [Lighter](https://lighter.xyz) account with an API key
- A [DigitalOcean](https://www.digitalocean.com/) model access key

## Setup

### 1. Install dependencies

```bash
bun install
pip install lighter-sdk
```

### 2. Configure environment

Create a `.env` file:

```env
DATABASE_URL="mongodb://localhost:27017/trading_agent?replicaSet=rs0"
DO_MODEL_ACCESS_KEY="sk-do-..."
LIGHTER_API_KEY="your-lighter-private-key"
ACCOUNT_INDEX="your-lighter-account-index"
API_KEY_INDEX="your-lighter-api-key-index"
```

### 3. Start MongoDB as replica set

```bash
mongod --dbpath /tmp/mongodb-data --port 27017 --replSet rs0 --fork --logpath /tmp/mongod.log
```

Initialize the replica set (first time only):

```bash
python3 -c "
from pymongo import MongoClient
c = MongoClient('mongodb://localhost:27017/?directConnection=true')
c.admin.command({'replSetInitiate': {'_id': 'rs0', 'members': [{'_id': 0, 'host': 'localhost:27017'}]}})
"
```

### 4. Generate Prisma client

```bash
source .env && export DATABASE_URL && bunx prisma generate
```

### 5. Seed the database

```bash
source .env && export DATABASE_URL LIGHTER_API_KEY ACCOUNT_INDEX && bun run seed.ts
```

### 6. Run

```bash
source .env && export DATABASE_URL DO_MODEL_ACCESS_KEY LIGHTER_API_KEY ACCOUNT_INDEX API_KEY_INDEX && bun run index.ts
```

The bot runs an initial cycle immediately, then repeats every 5 minutes.

## Lighter API key setup

If you need to create a new Lighter API key programmatically:

```bash
export ETH_PRIVATE_KEY="your-ethereum-wallet-private-key"
source .env && export LIGHTER_API_KEY ACCOUNT_INDEX API_KEY_INDEX

python3 -c "
import lighter, asyncio, os

async def main():
    # Generate keypair
    priv, pub, err = lighter.signer_client.create_api_key()
    print(f'Private: {priv}')
    print(f'Public: {pub}')

    # Register on your account (requires ETH private key)
    client = lighter.SignerClient(
        url='https://mainnet.zklighter.elliot.ai',
        api_private_keys={4: priv.replace('0x', '')},
        account_index=int(os.environ['ACCOUNT_INDEX'])
    )
    resp, err = await client.change_api_key(
        eth_private_key='0x' + os.environ['ETH_PRIVATE_KEY'],
        new_pubkey=pub,
        api_key_index=4
    )
    print(f'Result: {resp}')

asyncio.run(main())
"
```

## Markets

| Market | ID | Leverage | Price decimals | Qty decimals |
|--------|-----|----------|---------------|-------------|
| SOL    | 2   | 10x      | 1000          | 1000        |
| ZEC    | 90  | 5x       | 1000          | 1000        |
| HYPE   | 24  | 10x      | 10000         | 100         |

## Architecture

```
index.ts          -- Main loop (5min interval), AI orchestration
stockData.ts      -- Fetches candlesticks via Lighter REST API (HTTP/2)
indicators.ts     -- EMA, MACD calculations
getPortfolio.ts   -- Account balance from Lighter API
openPositions.ts  -- Current positions from Lighter API
createPosition.ts -- Opens trades via Python lighter-sdk
cancelOrder.ts    -- Closes trades via Python lighter-sdk
auth.ts           -- Auth token generation + HTTP/2 fetch helper
generate-token.py -- Python script for Lighter auth tokens
trade.py          -- Python script for executing trades
seed.ts           -- Database seeding
prisma/           -- Prisma schema (MongoDB)
```

## Notes

- Lighter's CloudFront CDN requires **HTTP/2** for authenticated API requests. All REST calls use `curl --http2`.
- Auth tokens are generated via the Python lighter-sdk and cached for up to 8 hours.
- Trade execution uses the Python SDK because the native Go signer binary doesn't support Linux ARM64 on Bun's FFI.
- The AI's trade direction is **inverted** (`side = side === "LONG" ? "SHORT" : "LONG"`) as a contrarian strategy.
