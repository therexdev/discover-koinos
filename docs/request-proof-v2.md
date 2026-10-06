# Request proof v2 (SEC-06)

Prepared 2026-09-25. Implementation and regression coverage are on branch `security/request-proofs-v2`. Production enforcement requires the coordinated rollout below. This change does not close the separate token-branding authority, signer-session revocation, custody, or contract-upgrade requirements.

## Security contract

The legacy signature covered only an action and timestamp. A captured proof could be replayed for five minutes or attached to changed operation data. The server now rejects that format; there is no legacy fallback or switch that re-enables it.

A v2 request has its operation data and `address` at the top level, plus a `proof` object. The signature covers the UTF-8 string `discover-koinos:request-proof:v2\n` followed by the canonical JSON representation of all proof fields except `signature`:

| Field | Required value |
| --- | --- |
| `version` | Integer `2` |
| `action`, `method`, `path` | Allowlisted operation, `POST`, and its exact `/api/...` path; query strings and trailing slash aliases are rejected |
| `address` | The account in the operation body, recovered from the signature |
| `audience` | Server-configured `PUBLIC_ORIGIN`, independently checked against the client's configured API origin |
| `origin` | The actual HTTP Origin header; canonical service origin or an explicitly configured allowed Trade origin |
| `network` | Configured `mainnet` or `harbinger`; Trade independently checks its configured network |
| `issuedAt`, `expiresAt` | Integer milliseconds, lifetime at most five minutes, no expired request, at most 30 seconds of future clock skew |
| `nonce` | Decimal `issuedAt`, a period, and 32 cryptographically random bytes encoded as lowercase hex |
| `payloadHash` | Lowercase SHA-256 of canonical JSON for the complete body excluding only `proof` |
| `signature` | Base64-encoded 65-byte Koinos recoverable signature of SHA-256 of the message |

Canonical JSON sorts object keys by JavaScript string order, preserves array order, uses ordinary JSON scalar encoding, and allows at most 32 nesting levels. Clients snapshot payloads using JSON wire semantics before discovery/signing. The shared `tests/fixtures/request-proof-v2.json` fixes byte-for-byte behavior across the gateway and Trade implementations. Unknown proof fields, legacy top-level `ts`/`sig`, and mixed session/proof credentials are rejected. A JSON body must be an object.

Same-origin proofs cover all seven routes. Cross-origin proofs are permitted only for `launch-token`, `launchpad-logo`, and `launchpad-profile`, and only for exact `SIGNER_ORIGINS` entries. An Origin header is mandatory for proof requests, including CLI clients. Origin is an additional context check; possession of the signing key remains the authentication boundary. Google session authentication is separate and retains its existing behavior.

## Atomic replay protection and operational requirements

Only a fully validated signature can consume a nonce. The server atomically creates a private file under `DATA_DIR/request-proof-nonces` using exclusive creation, flushes the record and directory before handling the action, and returns HTTP 409 for a second use. Replay detection works across processes sharing that directory and survives process restarts. Storage errors return HTTP 503 without authorizing the operation or exposing paths.

All workers serving the same audience/network must use the same persistent filesystem with correct exclusive-create and fsync semantics. Separate disks on independent replicas are unsupported; do not enable that topology with this implementation. The actual Hostinger process topology and filesystem must be verified before production enforcement is marked complete. Keep this directory outside release directories and preserve it on redeploy. Monitor space/inodes. Treat replay records as runtime state, not deployable source.

Cleanup examines at most 64 directory entries per valid request. It deletes a record only after the nonce's embedded issuance time plus the maximum lifetime has passed. A nonce's timestamp must match `issuedAt`, so an expired nonce cannot be revived by signing it with a new timestamp or extending its expiry. Cleanup cannot remove a record that could still authorize a valid proof. Expired records may remain when the service is idle.

A consumed proof stays spent even if subsequent validation, rate limiting, or chain work fails. Clients do not automatically re-sign/retry a mutation. A lost response may represent a completed action: check the account/chain before deliberately initiating a new request. This prevents reuse of the same authorization; it is not a general operation-idempotency service.

If replay state must be restored from an older backup, stop proof-authenticated writes on every worker and wait longer than five minutes plus the 30-second clock-skew allowance before reopening them. Restoring stale replay state while still-valid proofs exist would weaken replay protection.

## Known client inventory

| Client | Actions migrated |
| --- | --- |
| Gateway `Wallet.sponsoredAction` | `prepare`, including full action and params |
| Gateway home and NFT studio | `mint-nft`, including name, palette, and cells |
| Gateway home and token page | `launch-token`, including logo and mintability |
| Gateway token page and DEX widget | `list-dex`, including token, amount, and price |
| Gateway upload widget | `upload-nft`, including image order and collection selection |
| Trade Kondor launchpad client | `launch-token`, `launchpad-logo`, `launchpad-profile` |

The gateway loads the proof client before `wallet.js` on all six pages that use it. KOIN Vault-backed gateway free actions remain unsupported by the existing wallet implementation. This inventory covers these repositories; external integrations must be checked before the strict cutover.

## Coordinated production rollout

1. Review both `security/request-proofs-v2` branches and passing CI. Verify `PUBLIC_ORIGIN=https://usekoinos.com`, `KOINOS_NETWORK=mainnet`, and that `SIGNER_ORIGINS` contains the exact `https://app.tradekoinos.com` origin. Check the persistent shared `DATA_DIR` and actual worker topology. Do not substitute an arbitrary Host header for the audience. Local development explicitly sets `PUBLIC_ORIGIN=http://localhost:3000` (or the exact loopback origin being used).
2. Schedule a brief wallet-proof write cutover. Deploy the gateway server and its static clients together, then promptly deploy the matching Trade frontend. The gateway rejects old proofs immediately; older Trade builds/open tabs cannot perform these wallet-proof actions until refreshed onto the new client. Google sessions remain independent. Keep the old proof format disabled throughout.
3. Read `/api/config` and `/api/signer-config`: `requestProof` must advertise version 2, the expected audience, `mainnet`, and `ttlMs: 300000`. A missing/invalid `PUBLIC_ORIGIN` advertises `null` and blocks proof actions. Check signer-config CORS from the Trade origin and verify the new static assets are served.
4. On a staging account, verify one intended action, an unchanged replay returning 409, changed fields failing, process-restart replay rejection, and each configured worker sharing the same records. Test Google and Kondor flows; tests in this repository do not replace a live wallet-extension or real-chain rehearsal.
5. Roll forward if a release fails. Do not restore legacy proof acceptance. Keep signing operations unavailable where configuration/storage cannot meet these requirements. Mark SEC-06 deployed only after the actual environment and all known clients are verified.

No mainnet transaction, contract upgrade, or production configuration change is performed by the test suite. HTTP integration tests use an isolated demo server and public fixture keys; real signatures, production routing, and session verification are exercised without spending funds.
