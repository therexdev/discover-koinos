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
starts with an empty registry. Two options:

- fine for the testnet phase (the chain state itself is untouched; the site
  just forgets its gallery), or
- point `data/` at persistent storage / back it up on deploy if you want the
  gallery and token upgrade keys to survive rebuilds. `data/token-keys.json`
  is the one file that matters: it holds each launched token's upgrade
  authority.

## 5. Go-live checklist (mainnet)

- [ ] Fund the DEV wallet with real KOIN (mana ceiling = balance; each token
      launch consumes ~46 KOIN of mana that recharges over ~5 days)
- [ ] `KOINOS_NETWORK=mainnet node scripts/deploy-playground.js gateway.env`
- [ ] Flip `KOINOS_NETWORK=mainnet` in Hostinger env vars, redeploy
- [ ] Sanity-check `/api/config` shows `"network":"mainnet"`, `"demo":false`
- [ ] Lower `MAX_LAUNCHES_PER_DAY` to what the wallet can actually sponsor
- [ ] Watch the boot log: it prints the sponsor balance/mana and verifies the
      collection contract answers `get_info`

## Troubleshooting

| symptom | cause / fix |
|---|---|
| boots in demo with "chain unreachable" | no RPC candidate answered — set `KOINOS_RPC` |
| "the sponsor wallet is recharging its mana" | by design: mana below the action's floor; wait or fund more |
| launch fails with `insufficient rc` | sponsor mana below the real upload cost — fund the DEV wallet |
| launch fails with `insufficient pending account resources` | rc_limit reserved > available in mempool; wait ~15s and retry |
| balances read 0 on mainnet | wrong KOIN contract — the retired pre-migration address is a known trap; `tools/rpc.js` carries the correct one |
| every visitor rate-limited together | set `TRUST_PROXY_HOPS` to your proxy depth |
