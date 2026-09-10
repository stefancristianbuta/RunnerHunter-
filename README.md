# RunnerHunter

RunnerHunter is a real-time crypto momentum radar built to identify potentially early-moving tokens on Robinhood Chain before momentum becomes obvious.

It continuously discovers liquidity pools, normalizes market data, removes duplicate token pools, scores market activity, classifies momentum stages, applies risk controls, enriches promising candidates with on-chain data, and exposes telemetry for understanding every decision.

> RunnerHunter is a research and monitoring tool, not financial advice and not a guarantee that any token will rise in price.

## What RunnerHunter Does

RunnerHunter is designed around one core question:

**Which Robinhood Chain tokens are showing meaningful early momentum right now, and which ones are risky or already too far into the move?**

The radar combines:

- GeckoTerminal market and pool discovery
- Robinhood Chain RPC providers
- Blockscout token and contract data
- Robinhood Chain / explorer fallbacks for holder data
- Multi-timeframe momentum analysis
- Buy/sell pressure analysis
- Liquidity and market-cap filters
- Risk scoring and security signals
- Stage classification
- Persistent in-process history for detecting pullbacks
- Bounded telemetry for debugging and strategy analysis
- A fast 10-second radar scan loop

## Core Pipeline

Each scan follows a lightweight pipeline:

1. Obtain the latest chain block in parallel.
2. Load newly discovered and cached market pools from GeckoTerminal.
3. Deduplicate pools so one token is scored once using the strongest available pool.
4. Normalize price, market cap, liquidity, volume, transactions and timeframe data.
5. Score discovered tokens.
6. Apply the market eligibility filters.
7. Compare candidates with recent history.
8. Apply cached security and risk information.
9. Sort the radar by score.
10. Update the live radar state.
11. Run on-chain enrichment asynchronously so it does not block the scan loop.
12. Record telemetry about decisions, stage transitions and rejections.

The scanner is intentionally optimized for freshness. The production runtime currently executes the main scan every 10 seconds.

## Data Sources

### GeckoTerminal

GeckoTerminal is the primary market-discovery source. RunnerHunter uses its Robinhood Chain pool data for:

- Token and pool discovery
- Price
- Market capitalization
- Fully diluted valuation
- Liquidity
- Volume
- Price changes
- Buy and sell transaction activity
- Multi-timeframe market statistics

A request queue spaces GeckoTerminal calls to reduce the chance of rate limiting. HTTP 429 responses trigger a cooldown instead of repeatedly hammering the API.

### Robinhood Chain RPC

RunnerHunter supports multiple RPC URLs and performs failover when an RPC provider fails.

The application also protects the scan loop from a stuck `getBlockNumber()` request with a short timeout. A failed non-critical block lookup therefore cannot freeze the radar.

### Blockscout

Blockscout is used for asynchronous enrichment and security-related information, including:

- Holder counts
- Contract verification status
- Contract existence
- Proxy / upgradeability information
- Token metadata and images where available

Results are cached to reduce unnecessary network traffic.

## Market Filters

Before a token becomes a candidate, RunnerHunter applies baseline market filters.

Current thresholds include:

| Filter | Requirement |
|---|---:|
| Market cap | >= $10,000 |
| Liquidity | >= $2,500 |
| Market cap vs liquidity | Market cap must not be below 35% of liquidity |
| Total trades | >= 2 |
| 1h volume | >= $25 |

These filters are deliberately separate from the momentum-stage logic. A token can have a high momentum score and still be rejected because its market structure does not meet the minimum requirements.

## Momentum Stages

RunnerHunter classifies eligible market conditions into five stages.

### EARLY

Designed to identify relatively fresh moves.

The current logic considers:

- Token age up to 6 hours
- Initial momentum on 1m/5m/15m-derived market data
- At least $100 of 1h volume
- Buy pressure of at least 52%
- At least 3 total trades
- Activity in short or medium timeframes

The goal is to find tokens while a move is still developing.

### GROWING

Represents stronger confirmation that momentum is developing.

Requirements combine:

- 1h, 6h or 15m momentum
- Non-negative 5m movement
- At least $100 of 1h volume
- At least 55% overall buy pressure
- At least 4 total trades
- Bullish 15m or 30m activity
- Additional timeframe confirmation

### RUNNING

Represents a substantially active move.

The current logic requires:

- At least $500 of 1h volume
- At least 60% buy pressure
- At least 6 total trades
- Strong momentum structure across 5m, 15m, 30m, 1h or 6h data

### PULLBACK

A pullback is only recognized when there is evidence of a previous active run.

RunnerHunter looks for combinations such as:

- A prior EARLY, GROWING or RUNNING state
- A meaningful negative 1h and 5m move with weak timeframe confirmation
- A confirmed 15m/30m decline
- A fast 5m pullback with sufficient activity

This prevents ordinary stable tokens from being mislabeled as pullbacks.

### STABLE

STABLE means the current market data does not fully satisfy the active thresholds for EARLY, GROWING, RUNNING or PULLBACK.

A STABLE label does not mean a token is bad. It means the current evidence is insufficient for an active radar stage.

## Multi-Timeframe Analysis

RunnerHunter uses several timeframes to avoid relying on a single price-change number.

Tracked market windows include:

- 5 minutes
- 15 minutes
- 30 minutes
- 1 hour
- 6 hours
- 24 hours where available

For active stage decisions, 5m, 15m and 30m transaction activity, pressure and price changes are especially important.

The system uses both price movement and buy/sell pressure because a positive price change with weak activity can mean something very different from sustained buying across multiple timeframes.

## Scoring

The radar assigns a score to candidates based on the market signals already collected by the scanner.

The score is used for ranking and telemetry analysis. It is not itself a trading recommendation.

Stage classification and scoring are intentionally separate. A high score does not automatically mean RUNNING, and a token can remain STABLE while carrying a relatively high score if the specific stage conditions are not satisfied.

## Risk Engine

RunnerHunter has a separate risk layer that can downgrade or reject otherwise interesting candidates.

Risk signals currently include:

- Very thin liquidity
- Thin liquidity
- High market-cap-to-liquidity ratio
- Low holder count relative to market cap
- Extreme price movement on few trades
- Short-term acceleration with low activity
- Concentrated buy pressure
- Missing observed sells
- Contract bytecode not confirmed
- Unverified contracts
- Upgradeable/proxy contracts
- On-chain security flags from the security subsystem

Risk levels are:

| Level | Meaning |
|---|---|
| CLEAR | No major risk threshold currently triggered |
| REVIEW | Risk signals deserve additional inspection |
| FLAGGED | Strong risk signals are present |

A high momentum score does not override a strong risk signal.

## Security Layer

Security checks are designed to operate alongside the market radar rather than blocking market discovery.

Security information is cached and queued where appropriate. This keeps the high-frequency market loop responsive while still allowing promising tokens to receive deeper on-chain inspection.

## Holder Enrichment

Holder information can come from Blockscout and fallback explorer sources when the primary Blockscout response does not provide a usable holder count.

Holder enrichment is asynchronous and cached. It is not intended to add blocking latency to the main 10-second scan cycle.

## Telemetry

RunnerHunter includes a bounded in-memory telemetry system for understanding how the radar behaves in production.

Telemetry records include:

- Timestamp
- Scan cycle
- Outcome
- Token symbol and name
- Token address
- Score
- Current stage
- Previous stage
- Stage reason
- Market filter rejection reasons
- Risk score
- Risk level
- Risk flags
- Market cap
- Liquidity
- 1h volume
- Overall buy pressure
- Total trades
- Token age
- 5m, 15m, 30m, 1h and 6h momentum
- 5m/15m/30m transaction counts
- 15m/30m pressure
- Stage condition signals

The telemetry buffer is intentionally bounded to 2,000 entries.

The telemetry endpoint supports an optional token, symbol or address filter:

```text
/api/telemetry?token=SYMBOL
```

Telemetry is designed to use information already calculated by the radar. It does not introduce a second market-data polling system.

## Telemetry Outcomes

Important decision outcomes include:

- `MARKET_REJECT` - failed the baseline market filters
- Candidate decision - passed the market filters and entered the radar pipeline
- `RISK_REJECT` - interesting market candidate but rejected or downgraded by the risk layer

Telemetry also counts stage distributions and records which stage conditions fail most often. This makes it possible to tune thresholds based on observed behavior instead of guessing.

## Performance Design

RunnerHunter is deliberately built around a fast market loop.

Important design choices include:

- 10-second main scan interval
- GeckoTerminal request spacing
- GeckoTerminal cache with background refresh
- Multiple RPC providers with failover
- RPC timeout protection
- Blockscout caching
- Asynchronous enrichment
- Bounded telemetry memory
- One scored pool per token
- No duplicate market scoring for the same token

The goal is to keep the radar fresh without creating unnecessary API traffic.

## Rate Limiting

RunnerHunter explicitly handles GeckoTerminal HTTP 429 responses.

When a 429 is received:

1. The response is detected immediately.
2. `Retry-After` is read when available.
3. A minimum cooldown is applied.
4. Further GeckoTerminal requests wait until the cooldown expires.
5. The scan process itself remains alive.

This prevents a temporary API rate limit from turning into a request storm.

## Caching

The application uses several in-memory caches:

- Token metadata cache
- Blockscout token cache
- Contract information cache
- GeckoTerminal market cache
- Security information managed by the security subsystem
- Radar history
- Telemetry buffer

Caching is used to reduce redundant external requests while keeping the high-frequency market scan responsive.

## Architecture

The project is a Node.js / Express backend with a Vite-based frontend.

Main components include:

```text
RunnerHunter
├── server/
│   ├── index.js              # Main API, market discovery and scan loop
│   ├── risk.js               # Stage classification and risk engine
│   ├── telemetry.js          # Decision telemetry and summaries
│   ├── runtime-patch.js      # Runtime safeguards and 10s scan override
│   ├── security.js           # Security queue and on-chain security state
│   └── secure-entry.js       # Production entry point
├── package.json
└── README.md
```

The exact frontend file structure can evolve independently from the radar engine.

## Production Runtime

The production start command is:

```bash
node --import ./server/runtime-patch.js ./server/secure-entry.js
```

The runtime patch currently provides:

- RPC `getBlockNumber()` timeout protection
- 30s-to-10s radar interval override
- Holder-data fallback behavior
- Robinhood token logo fallback

The 10-second override is intentional and should not be changed casually because fast discovery is one of RunnerHunter's core requirements.

## API / Health

The service exposes a health endpoint:

```text
GET /health
```

Telemetry is available through:

```text
GET /api/telemetry
```

or filtered by token, symbol or address:

```text
GET /api/telemetry?token=SYMBOL
```

The application also maintains live state containing information such as scan cycle, discovered pools, analyzed tokens, active candidates, errors, flagged candidates, latest block and timeframe coverage.

## Environment Configuration

RunnerHunter supports environment variables for external services, including:

```text
PORT
RH_RPC_URL
RH_RPC_URLS
BLOCKSCOUT_URL
```

If custom RPC configuration is not provided, the application includes public Robinhood Chain RPC fallbacks.

Blockscout and GeckoTerminal endpoints also have production defaults in the application.

## Deployment

RunnerHunter is designed to run as a Node service on Render or another Node-compatible platform.

Typical deployment commands are:

```bash
npm install && npm run build
npm start
```

The production service should expose the platform-provided `PORT` and use `/health` as its health check.

## Operational Philosophy

RunnerHunter is intentionally built as a radar, not an automated trading bot.

The system prioritizes:

1. Fresh market data
2. Early momentum detection
3. Multi-timeframe confirmation
4. Liquidity-aware filtering
5. Risk awareness
6. Explainable decisions
7. Production stability
8. Low unnecessary network traffic

The telemetry system is particularly important because strategy changes should be based on observed market behavior. If a stage produces too few candidates, rejects too many tokens, or behaves inconsistently with its score, telemetry provides the evidence needed before changing thresholds.

## Current Safety Boundaries

RunnerHunter does not guarantee:

- Token legitimacy
- Profitability
- Liquidity availability at execution time
- Protection against scams or malicious contracts
- Future price performance

A token passing the radar does not mean it is safe to buy.

## Development Principles

When changing RunnerHunter, preserve these principles unless there is a deliberate reason to change them:

- Keep the scan loop fast.
- Do not add unnecessary RPC or HTTP calls to the high-frequency path.
- Prefer cached or asynchronous enrichment.
- Keep market filtering separate from risk filtering.
- Keep stage classification explainable.
- Preserve telemetry when changing decision logic.
- Test for rate limits and RPC stalls.
- Avoid changing thresholds without telemetry evidence.
- Treat security signals as an independent risk layer.

## Project Status

RunnerHunter is an actively developed production radar for Robinhood Chain market monitoring.

The production scanner currently operates on a 10-second cycle with RPC timeout protection, GeckoTerminal rate-limit handling, asynchronous Blockscout enrichment, risk classification, stage detection and bounded telemetry.
