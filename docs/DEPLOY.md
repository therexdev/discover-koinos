# Deploying Discover Koinos

Runbook: local → Harbinger testnet → Hostinger (auto-deploy from GitHub) → mainnet.

## 0. Local sanity check

```bash
npm install
npm start
# http://localhost:3000 — boots in DEMO mode, every flow clickable
```

## 1. Keys

```bash
node tools/keygen.js            # writes gateway.env (chmod 600, refuses to overwrite)
```

Prints two addresses:

- **DEV** — the sponsor wallet. The only hot key with funds. Its mana pays for
  every visitor action.
- **COLLECTION** — the playground NFT collection account. Also hot on the
  server (free mints are signed *as* the collection), but holds no funds.

Back `gateway.env` up somewhere safe. Losing the DEV key loses the sponsor
funds; losing the COLLECTION key loses the ability to mint/upgrade the
playground collection.

## 2. Fund the sponsor (Harbinger)

Two faucets, both free:

- **Discord** — join [discord.koinos.io](https://discord.koinos.io), type
  `!faucet <DEV address>` in `#faucet` (100 tKOIN per request)
- **Telegram** — message [@KoinosTestnetFaucetBot](https://t.me/KoinosTestnetFaucetBot)
  `/faucet <DEV address>` (100 tKOIN, 24h cooldown)

Ask twice if you can: the collection deploy needs ~80 mana, and mana ceiling =
balance.

## 3. Deploy the playground collection

```bash
node scripts/deploy-playground.js gateway.env
```

Idempotent — re-run safely; it skips steps already done. It preflights the mana
cost from live chain prices and prints the three env vars the server needs.

If every public Harbinger RPC is down (it happens), either set
`KOINOS_RPC=<url>` (koinos.pro has free API keys) or run your own node —
[`free-koinos-node`](https://github.com/therexdev/free-koinos-node)'s
`node-template/` has a docker-compose Harbinger node serving JSON-RPC on :8081.

## 4. Hostinger — auto-deploy from GitHub

The gateway is a plain Node.js app: `npm install`, `npm start`, honors `PORT`.
In hPanel:

1. **Create the app**: *Websites → Add website → Node.js app* (any plan with
   Node 18+). Choose **Deploy from Git** and connect this GitHub repository +
   branch. Every push then redeploys automatically.
2. **Build/run commands**: install `npm install`, start `npm start`
   (or entry file `server.js`). No build step exists — that's by design.
3. **Environment variables** (App settings → Environment):
   ```
   KOINOS_NETWORK=harbinger
   GATEWAY_DEV_WIF=<from gateway.env>
   GATEWAY_COLLECTION_WIF=<from gateway.env>
   GATEWAY_COLLECTION_ADDR=<printed by deploy-playground>
   TRUST_PROXY_HOPS=1
   ```
   Never commit `gateway.env` — it's gitignored; env vars are how secrets reach
   the app.
4. **`TRUST_PROXY_HOPS=1`** because Hostinger terminates TLS in front of the
   app — without it every visitor shares one rate-limit bucket.

### ⚠ `data/` persistence

The server keeps its registry (launched tokens, minted NFTs, **launched-token
keys**) in `data/*.json` — which is gitignored, so a from-scratch redeploy
starts with an empty registry.

**Fix: set `DATA_DIR` to a path OUTSIDE the deploy directory** (e.g.
`DATA_DIR=/home/<user>/dk-data`) so redeploys can't touch it.
`data/token-keys.json` is the one file that truly matters: it holds each
launched token's upgrade authority.

Safety net: at every boot the server **reconciles the registry against the
chain** — launched tokens and collections whose keys survive, and every Paint
NFT (name + image travel in on-chain metadata), are re-discovered and put back
in the gallery, and the mint-id counter is bumped past every id already used
on-chain (so a wiped counter can never cause "token already minted"). Uploaded
NFT *images* live in `data/uploads/` and cannot be rebuilt from chain — one
more reason to set `DATA_DIR`.

## 5. Go live on MAINNET — the full runbook

Everything below is one afternoon. The chain usage itself is free (mana, not
fees) — but mana ceiling = the KOIN the sponsor wallet *holds*, so going live
means parking real KOIN in the DEV wallet. It is never spent as fees; it is
collateral that recharges ~20%/day.

**How much KOIN:** the one-time Paint-collection deploy eats ~46 KOIN of mana.
Each user token launch or new Upload collection also eats ~46. Comfortable
start: **~150 KOIN** in the DEV wallet (≈ 2 launches/day sustainable, more as
it recharges). With 100 KOIN you can still run; set `MAX_LAUNCHES_PER_DAY=1`
and `MAX_COLLECTIONS_PER_DAY=1` for the first days.

### Step by step

```bash
# 1. keys (skip if you already made gateway.env — SAME keys work on mainnet)
node tools/keygen.js

# 2. send real KOIN to the DEV address it printed (~150 KOIN recommended)

# 3. deploy the "Discover Koinos Paint" collection on mainnet
KOINOS_NETWORK=mainnet node scripts/deploy-playground.js gateway.env
#    → prints GATEWAY_COLLECTION_ADDR when done (idempotent; re-run if it fails)
```

**4. Hostinger env vars** (App settings → Environment), then redeploy:

```
KOINOS_NETWORK=mainnet
GATEWAY_DEV_WIF=<from gateway.env>
GATEWAY_COLLECTION_WIF=<from gateway.env>
GATEWAY_COLLECTION_ADDR=<printed by step 3>
PUBLIC_ORIGIN=https://your-domain.com     ← required for share links + OG images
TRUST_PROXY_HOPS=1
MAX_LAUNCHES_PER_DAY=2
MAX_COLLECTIONS_PER_DAY=2
```

**5. Verify** — `https://your-domain.com/api/config` must show
`"network":"mainnet"`, `"demo":false`. The boot log prints the sponsor
balance/mana, the Paint collection's `get_info`, and
`dex: Trade Koinos 1Bke72aGbpq4brDY3m1UQxRCGBB9GPTJQz`.

### What switches on automatically on mainnet

- **OURO auto-listing** — the Paint collection registers itself on OURO at
  boot, and every user Upload collection registers as it's created
  (`POST https://ouro.lifestyle/api/collections`, free, no key needed). OURO
  rate-limits registrations to 10/day/IP; if the gateway gets busy, ask the
  OURO operator for the admin key and set `OURO_ADMIN_KEY`.
- **Trade Koinos DEX listing** — the "List on Trade Koinos DEX" action goes
  live (the orderbook only exists on mainnet). Listing = create the
  TOKEN/KOIN market (gateway pays mana) + the user's SELL order (escrows only
  their tokens). Verify a listing at https://app.tradekoinos.com/.

### First-hour smoke test (with a throwaway browser profile)

- [ ] Create a Local Wallet, paint + mint an NFT → txid opens on koinosblocks
- [ ] Open its `/n/<code>` share link → page renders, paste the link into X/
      Telegram → the card unfurls with the artwork
- [ ] Upload 2–3 images as a new collection → collection appears on OURO
      (`https://ouro.lifestyle/#/c/<collection address>`)
- [ ] Launch a token → `/t/<address>` share page renders; contract on explorer
- [ ] List it on Trade Koinos at a small price → order visible on
      app.tradekoinos.com
- [ ] Watch sponsor mana in the boot log / `/api/stats` — each action should
      cost ~0.5–1.5 KOIN of mana except deploys (~46)

### Ongoing

- Mana is the throttle: if `/api/stats` shows sponsorMana sagging, raise the
  wallet balance or lower the daily caps.
- `data/` (registry + launched-token/collection keys + uploaded images) must
  survive redeploys — see the persistence note in §4.

## Troubleshooting

| symptom | cause / fix |
|---|---|
| boots in demo with "chain unreachable" | no RPC candidate answered — set `KOINOS_RPC` |
| "the sponsor wallet is recharging its mana" | by design: mana below the action's floor; wait or fund more |
| launch fails with `insufficient rc` | sponsor mana below the real upload cost — fund the DEV wallet |
| launch fails with `insufficient pending account resources` | rc_limit reserved > available in mempool; wait ~15s and retry |
| balances read 0 on mainnet | wrong KOIN contract — the retired pre-migration address is a known trap; `tools/rpc.js` carries the correct one |
| every visitor rate-limited together | set `TRUST_PROXY_HOPS` to your proxy depth |
