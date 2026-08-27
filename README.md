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
| `DATA_DIR` | `./data` | where records, keys and uploads live — **point it OUTSIDE the deploy directory** on hosts that wipe the app folder on redeploy (the server also self-heals from the chain, but images can't be rebuilt) |
| `DEMO_MODE` | — | `1` forces demo mode |
| **Koinos AI chat** (`/ai`) | | *(optional; the page hides its chat when unset)* |
| `KAI_API_URL` | — | the OpenAI-compatible API of a running [Koinos AI](https://koinosai.com) app — the operator's own computer (the app serves it on port 41100; expose it to this server via a tunnel or port-forward, and use THAT address here — `127.0.0.1` only works on the app's own machine). With or without a trailing `/v1`. The app answers through the Koinos AI network and its account is billed per AI token |
| `KAI_API_KEY` | — | an API key minted in that app (**Local API** view → Create key). Never a wallet key |
| `KAI_CHAT_MODEL` | `koinos-network` | the model the chat asks the app for; `koinos-network` routes to the network's best live class |
| `MAX_CHATS_PER_DAY` | `400` | global daily visitor-chat budget (plus 6/min and 60/day per IP built in) |
| **Social login** | | *(all optional; Local Wallet + Import always work)* |
| `GOOGLE_CLIENT_ID` | *(inherited)* | **Aurvania's** Google OAuth client ID (`…apps.googleusercontent.com`). Enables the Google button, which opens the **same wallet as Aurvania & OURO**. Leave unset to inherit it from Aurvania at boot. Works with or without `LOGIN_SECRET` — see [Google custody](#google-bridged-or-held-here) |
| `AURVANIA_API` | `https://aurvania.quest` | the shared account server Google sign-in bridges to |
| `BRIDGE_UA` | `curl/8.5.0 (…)` | User-Agent the bridge presents (aurvania.quest 403s unfamiliar ones) |
| `LOGIN_SECRET` | — | **required for X**, and switches Google to being held here rather than bridged — encrypts custodied wallets at rest. Without it the X button stays off and Google bridges every login |
| `X_CLIENT_ID` / `X_CLIENT_SECRET` | — | X (Twitter) OAuth 2.0 app credentials — enable the X button |
| `X_REDIRECT_URI` | `PUBLIC_ORIGIN/auth/x/callback` | must exactly match a callback URL registered in your X app |
| **Integrations** | | |
| `OURO_API_BASE` | `https://ouro.lifestyle` | OURO marketplace to auto-register collections on |
| `OURO_ADMIN_KEY` | — | optional — lifts OURO's 10-registrations/day/IP limit |
| `AUTO_LIST_OURO` | `1` | set `0` to stop auto-registering collections on OURO |
| `DEX_ORDERBOOK_ADDR` | mainnet orderbook | Trade Koinos orderbook contract (mainnet only) |
| `TRADE_APP_URL` | `https://app.tradekoinos.com` | the Trade Koinos web app — pair links point at `#/market/<token>_<KOIN>` there |

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
- **Google** — opens the **same wallet the same Google account has in Aurvania
  and on OURO** — one identity, one address, every Koinos site. That shared
  custody store (not any key derivation) is what makes the address match. The
  WIF is released to the browser, which then signs locally like a Local Wallet.
  Where the key is *kept* depends on `LOGIN_SECRET` — see below.
- **X (Twitter)** — *custodial at rest here*: the server generates a keypair,
  stores it **AES-256-GCM encrypted** (key derived from `LOGIN_SECRET`), and
  releases it to the browser on a verified login. The trade-off is stated in the UI.

**Enabling Google:** it must use **Aurvania's** Google client id (Aurvania
checks the ID token's `aud` against its own). Either set `GOOGLE_CLIENT_ID` to
that same id, or leave it unset and the gateway inherits it from Aurvania's
`/api/chain-info` at boot. Nothing else is required — no OAuth console changes.
(The CSP widens to Google's origins only when this is set.)

### Google: bridged, or held here

Set `LOGIN_SECRET` and this gateway becomes the account home for Google
instead of forwarding every login. It then verifies the ID token with Google
itself (`aud`, `email_verified`, `exp`) and keeps the key encrypted here, the
same way X wallets are kept. The boot log says which mode is live.

**Existing users keep their exact wallet.** The first time this gateway meets
an account it does *not* generate a key — it asks Aurvania for the wallet that
account already owns and adopts that one, verifying the key really controls the
address before storing it. After that the account is served locally and
Aurvania is never consulted for it again.

That adoption step is why the local path **fails closed**: if Aurvania cannot
be reached and there is no local record, sign-in returns an error rather than
minting a wallet. "No local record" is not evidence that no wallet exists, and
a key issued on a bad guess would hand the user a different address and strand
whatever the real one holds.

Two things to know before changing any of this:

- Aurvania keys Google accounts by the token's `sub`, so the **client id must
  stay the same** or accounts will not be found. Renaming the OAuth consent
  screen (for branding) does not change the id and is safe.
- Aurvania and this gateway derive their encryption keys with **different
  salts** (`kc-wif-enc-v1` vs `dk-wif-enc-v1`), so a stored key is not portable
  between them by copying. Anything moved in bulk has to be decrypted and
  re-encrypted, never copied.

**Bulk migration** (accounts that have not logged in yet, so lazy adoption has
not reached them) needs no terminal:

1. copy Aurvania's `logins.json` into this gateway's `DATA_DIR` as
   **`aurvania-logins.json`** (hPanel File Manager is enough),
2. set **`AURVANIA_LOGIN_SECRET`** in the gateway's environment,
3. restart, and read the `[auth:import]` lines in the boot log.

The import runs before anything is served, is all-or-nothing (a failure logs
loudly, writes nothing, and the gateway boots normally on its existing
store), never overwrites an adopted record, and renames the source file to
`aurvania-logins.imported-<ts>.json` on success so it can never run twice.
Remove the env var and delete the renamed file when done.

The same import exists as a CLI (`tools/import-aurvania-logins.js`,
rehearsal by default, `--apply` to write) — only use it with the gateway
STOPPED; the boot path has no such hazard.

**Enabling X:** create an OAuth 2.0 app at developer.x.com with a **confidential
client**, add `PUBLIC_ORIGIN/auth/x/callback` as a redirect URI, and set
`X_CLIENT_ID`, `X_CLIENT_SECRET`, `PUBLIC_ORIGIN` + `LOGIN_SECRET`. The flow is
OAuth 2.0 with PKCE; the key is handed back via a one-time claim code, never in
a URL. Without `LOGIN_SECRET` the X button stays off.

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

## The viral loop

The gateway is built to convert each "aha" into an announcement:

- After a mint, a token launch or a DEX listing, a **share modal** opens with a
  prewritten (editable) message — one-tap post to X or Telegram, or copy.
- Every NFT and token gets a **public share page** (`/n/DK00001`,
  `/t/<address>`) whose link **unfurls with the actual artwork** (painted NFTs
  are rendered to a real PNG social card by a zero-dependency encoder;
  uploads use the stored raster). The page's only job is converting the person
  who clicked: *"made free, no wallet, no fees — make yours."*
- The **Build page** shows each visitor the things *they* made next to the
  explanation of how it was free — ending on "tell someone."

Set `PUBLIC_ORIGIN` in production so share links and OG images carry your
domain.

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
