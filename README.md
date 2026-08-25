# Discover Koinos

**The interactive gateway.** When newcomers discover Koinos, don't make them read —
let them *use* it. One page where a visitor can, in under a minute and without
paying a cent:

- 🔑 **Create a real Koinos account** — one click, generated in the browser, no signup
- 🎨 **Mint an NFT** — draw pixel art, it lands on-chain in their wallet, image stored in metadata
- 🪙 **Launch a token** — a real audited KCS-4 contract deployed to its own address, whole supply in their wallet
- 🚀 **Get funneled to build** — every action explained afterward, with the path to docs/SDKs

Everything is free for the visitor through **Koinos mana sharing**: the gateway's
sponsor wallet co-signs every transaction as `payer`, so its (regenerating) mana
pays while the visitor keeps full authority. No promo budget — a protocol feature.

## How it works

```
browser (koilib = Signer only)                server.js (zero-dep node:http)          Koinos
──────────────────────────────                ──────────────────────────────          ──────
generate key → localStorage                                                  
sign proof: "discover-koinos:<action>:<ts>" → verify sig → build/mint/launch  →  co-sign as payer → broadcast
sign server-prepared tx (transfers)         → verify byte-identical + user sig →  co-sign as payer → broadcast
```

Three transaction shapes (all mined from production Koinos dapps):

1. **Server-signed mint** — the playground NFT collection authorizes `mint` by
   *owner OR its own account*; the server holds the collection key, signs as the
   collection, pays as sponsor. The visitor signs nothing; the NFT lands in
   their address.
2. **Free token launch** — a fresh keypair becomes the token's contract account.
   The *payee is the fresh account* (its nonce, its authority), so the visitor's
   wallet is never involved: upload the audited bytecode, then `initialize`
   (name/symbol/decimals/supply → minted to the visitor) in a second transaction.
3. **Co-signed user transaction** (transfers/mint-more/burn) — the server
   prepares the *exact* transaction (`payer` = sponsor, `payee` = visitor),
   the browser signs it, the server verifies the id + recomputed header hash +
   the visitor's recovered signature, co-signs and broadcasts. The server
   prepared every byte, so a tampered transaction simply doesn't match.

## Repository layout

```
server.js                     the whole backend (static + API + sponsorship)
tools/koinos.js               chain facade — every koilib concern in one module
tools/rpc.js                  network table (harbinger/mainnet) + RPC probing
tools/keygen.js               generates the DEV + COLLECTION keypairs
scripts/deploy-playground.js  deploys + initializes the playground NFT collection
contracts/token/              the launchable KCS-4 token (AssemblyScript source)
contracts/prebuilt/           compiled WASM the server deploys per launch
server-abi/                   sanitized ABIs the server loads
public/                       the site (no build step; koilib vendored)
data/                         runtime registry (gitignored; token keys chmod 600)
```

## Run it

```bash
npm install
npm start           # http://localhost:3000 — DEMO mode until configured
```

With no `GATEWAY_DEV_WIF` (or no reachable RPC) the server boots in **demo
mode**: the full UI works, actions simulate instantly and are labeled demo.
That's deliberate — you can deploy and style the site before funding the chain
side.

## Go live on Harbinger (testnet)

```bash
# 1. keys
node tools/keygen.js                 # writes gateway.env (chmod 600), prints addresses

# 2. fund the DEV address — Koinos Discord #faucet: "!faucet <dev address>"
#    ask twice: a collection deploy needs ~80 mana (100 tKOIN per request)

# 3. deploy the playground NFT collection
node scripts/deploy-playground.js gateway.env

# 4. start the server with the env vars step 3 prints
KOINOS_NETWORK=harbinger \
GATEWAY_DEV_WIF=... GATEWAY_COLLECTION_WIF=... GATEWAY_COLLECTION_ADDR=... \
node server.js
```

### Environment variables

| var | default | meaning |
|---|---|---|
| `PORT` | `3000` | listen port |
| `KOINOS_NETWORK` | `harbinger` | `harbinger` or `mainnet` |
| `KOINOS_RPC` | *(probe list)* | pin one RPC URL (koinos.pro offers free API keys) |
| `GATEWAY_DEV_WIF` | — | **the sponsor wallet.** Its mana pays for everything |
| `GATEWAY_COLLECTION_WIF` | — | playground collection key (signs free mints) |
| `GATEWAY_COLLECTION_ADDR` | — | playground collection address |
| `TRUST_PROXY_HOPS` | `0` | proxy hops in front (Hostinger/CDN) for real client IPs |
| `MAX_LAUNCHES_PER_DAY` | `10` | global daily token-launch budget |
| `MAX_MINTS_PER_DAY` | `200` | global daily NFT-mint budget |
| `MAX_COLLECTIONS_PER_DAY` | `10` | global daily Upload-collection deploy budget |
| `MAX_UPLOAD_BYTES` | `3145728` | max uploaded NFT image size (3MB) |
| `PUBLIC_ORIGIN` | *(derived)* | canonical https origin — used for uploaded-image URLs and the X callback |
| `DEMO_MODE` | — | `1` forces demo mode |
| **Social login** | | *(all optional; Local Wallet + Import always work)* |
| `LOGIN_SECRET` | — | **required for Google/X** — the key that encrypts custodied wallets. Without it, social login stays off |
| `GOOGLE_CLIENT_ID` | — | Google OAuth **client ID** (`…apps.googleusercontent.com`) — enables the Google button |
| `X_CLIENT_ID` / `X_CLIENT_SECRET` | — | X (Twitter) OAuth 2.0 app credentials — enable the X button |
| `X_REDIRECT_URI` | `PUBLIC_ORIGIN/auth/x/callback` | must exactly match a callback URL registered in your X app |
| **Integrations** | | |
| `OURO_API_BASE` | `https://ouro.lifestyle` | OURO marketplace to auto-register collections on |
| `OURO_ADMIN_KEY` | — | optional — lifts OURO's 10-registrations/day/IP limit |
| `AUTO_LIST_OURO` | `1` | set `0` to stop auto-registering collections on OURO |
| `DEX_ORDERBOOK_ADDR` | mainnet orderbook | Trade Koinos orderbook contract (mainnet only) |

### The mana budget, honestly

- rc_limit is a **ceiling**, not a charge — a normal action burns ~0.4–1.3 KOIN
  of mana; a **token launch stores ~60KB of bytecode ≈ 46 KOIN of mana**.
- Mana recharges ~20%/day. The sponsor's KOIN balance is the ceiling.
- The server refuses expensive actions when the sponsor is low
  (`MIN_MANA_LAUNCH`, default 85) rather than failing halfway, and enforces
  per-address/per-IP/per-day limits.
- For a busy launch day, hold more tKOIN/KOIN in the sponsor wallet. On
  Harbinger, that's more faucet requests; on mainnet, that's the real cost of
  onboarding — KOIN you *hold*, not fees you burn.

## Deploy on Hostinger (auto-deploy from GitHub)

The gateway is a plain Node app (`npm install && npm start`, honors `PORT`) —
see **docs/DEPLOY.md** for the step-by-step Hostinger setup, including where to
put the env vars and the `data/` persistence caveat.

## Go live on mainnet

1. `KOINOS_NETWORK=mainnet node scripts/deploy-playground.js gateway.env`
   (the dev wallet needs real KOIN — mana ceiling = balance)
2. Start the server with `KOINOS_NETWORK=mainnet` and the same keys.
3. That's the whole switch — the network table in `tools/rpc.js` carries both
   configs (RPCs, KOIN/VHP contracts, explorers).

## Rebuild the token contract (optional)

The launchable token WASM ships prebuilt in `contracts/prebuilt/token/`. To
rebuild from source:

```bash
cd contracts && npm ci && npm run build
```

`contracts/token/assembly/LaunchpadToken.ts` is the audited
`@koinosbox/contracts` Token with one change: name/symbol/decimals move from
compile time into state, written once by a one-shot `initialize` that only the
token's own account can call. One reviewed binary serves every token ever
launched.

## Sign-in options

Four ways in, all converging on the same thing — the browser ends up holding
a Koinos key and signs locally:

- **Local Wallet** (recommended, non-custodial) — generated in the browser, never leaves it.
- **Import** — paste a WIF backup.
- **Google** and **X (Twitter)** — *custodial at rest*: the server generates a
  keypair, stores it **AES-256-GCM encrypted** (key derived from `LOGIN_SECRET`),
  and releases the plaintext key to your browser on a verified login. From then
  on it signs locally like a Local Wallet, and the Wallet page can export it any
  time. The trade-off is stated in the UI.

**Enabling Google:** create an OAuth **Web** client at
console.cloud.google.com → Credentials, add your origin to *Authorized
JavaScript origins*, and set `GOOGLE_CLIENT_ID` + `LOGIN_SECRET`. (The CSP only
widens to Google's origins when this is set.)

**Enabling X:** create an OAuth 2.0 app at developer.x.com with a **confidential
client**, add `PUBLIC_ORIGIN/auth/x/callback` as a redirect URI, and set
`X_CLIENT_ID`, `X_CLIENT_SECRET`, `PUBLIC_ORIGIN` + `LOGIN_SECRET`. The flow is
OAuth 2.0 with PKCE; the key is handed back via a one-time claim code, never in
a URL.

Without `LOGIN_SECRET` the social buttons simply don't appear.

## Create an NFT — two ways

- **Paint** → mints into the one shared **Discover Koinos Paint** collection
  (`GATEWAY_COLLECTION_*`). The pixel art is stored on-chain as an SVG in the
  token metadata.
- **Upload** → deploys **your own** KCS-2 collection (asks a collection name;
  remembers it so you can mint into it again), stores the image on the gateway
  (referenced by URL from on-chain metadata), and mints your NFT into it.

Uploaded images live under `data/uploads/` and are served at `/uploads/…`. For
production, back that directory up or move it to persistent/object storage —
and IPFS is the natural upgrade so images aren't gateway-hosted.

## Auto-list on OURO

When you're live on **mainnet**, every collection the gateway creates (the Paint
collection and each Upload collection) is auto-registered on the **OURO**
marketplace (`POST {OURO_API_BASE}/api/collections`) so it's browsable there.
This is discoverability only — putting an individual NFT *up for sale* on OURO
needs a KOIN price and the owner's signature, which is a separate step. OURO is
mainnet, so registration is skipped on testnet.

## List a token on Trade Koinos (DEX)

On **mainnet**, the Token Lab's *List on Trade Koinos DEX* action creates the
`TOKEN/KOIN` market (permissionless, mana only) and places a **SELL** order that
escrows only the tokens you list — no KOIN required; a buyer brings the KOIN.
It's free (mana only). Trade Koinos is only deployed on mainnet, so the action
is disabled on testnet.

## Security model

- The browser key never leaves the device (backup/export is user-initiated).
- Free actions require a **signature proof** from the receiving address —
  nobody can spend the sponsor's mana minting things to strangers.
- The sponsor only ever co-signs transactions the server itself built.
- Launched-token keys are stored server-side (`data/token-keys.json`, mode 600)
  as upgrade authority — never sent to a browser, never logged.
- Rate limits: per-address, per-IP and global daily budgets; failures counted,
  map bounded, proxy-aware client IPs (`TRUST_PROXY_HOPS`).

## License

MIT
