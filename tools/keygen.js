#!/usr/bin/env node
/* Generate the gateway's role keypairs into an env file (default
   gateway.env, chmod 600). Prints ADDRESSES only — private keys go
   straight to the file.

     · dev        — the sponsor wallet. Holds KOIN; its mana pays for every
                    visitor action. The only key that needs funding.
     · collection — the Paint NFT collection account. Held hot on the server
                    too (free mints are signed AS the collection). Holds no
                    funds; the dev wallet pays its mana.

   BRING YOUR OWN sponsor key: set GATEWAY_DEV_WIF in the environment and
   this keeps it as the dev key, generating only the collection —
     GATEWAY_DEV_WIF=<your WIF> node tools/keygen.js
   Otherwise a fresh dev key is generated too.

   Usage: [GATEWAY_DEV_WIF=<wif>] node tools/keygen.js [outfile]
*/
'use strict';
const fs = require('fs');
const crypto = require('crypto');
const { Signer } = require('koilib');

const out = process.argv[2] || 'gateway.env';

function fromWifOrDie(wif) {
  try { return Signer.fromWif(String(wif).trim()); }
  catch (_) {
    console.error('GATEWAY_DEV_WIF is not a valid Koinos private key (WIF).');
    console.error('It should be the WIF form (starts with 5, K or L). If you have a');
    console.error('64-char hex key instead, convert it first:');
    console.error(`  node -e "const {Signer}=require('koilib');console.log(new Signer({privateKey:'<hex>'}).getPrivateKey('wif',true))"`);
    process.exit(1);
  }
}
const fresh = () => new Signer({ privateKey: crypto.randomBytes(32).toString('hex') });

// DEV: use the provided key if given, else generate one.
const bringYourOwnDev = !!process.env.GATEWAY_DEV_WIF;
const dev = bringYourOwnDev ? fromWifOrDie(process.env.GATEWAY_DEV_WIF) : fresh();
const collection = fresh();

const keys = {
  DEV: dev.getPrivateKey('wif', true),
  COLLECTION: collection.getPrivateKey('wif', true),
};
const addr = { DEV: dev.getAddress(), COLLECTION: collection.getAddress() };

let text = `# Discover Koinos gateway keys — generated ${new Date().toISOString()}\n` +
  `# KEEP THIS FILE SECRET. The DEV key holds the sponsor funds.\n`;
text += `GATEWAY_DEV_WIF=${keys.DEV}\n`;
text += `# GATEWAY_DEV_ADDR=${addr.DEV}\n`;
text += `GATEWAY_COLLECTION_WIF=${keys.COLLECTION}\n`;
text += `GATEWAY_COLLECTION_ADDR=${addr.COLLECTION}\n`;

try {
  fs.writeFileSync(out, text, { mode: 0o600, flag: 'wx' });
} catch (e) {
  if (e.code === 'EEXIST') {
    console.error(`${out} already exists — refusing to overwrite it (it may hold live keys).`);
    console.error(`Delete it first if you really mean to regenerate, or pass a different filename.`);
    process.exit(1);
  }
  throw e;
}

console.log(`wrote ${out} (mode 600)\n`);
console.log(`DEV         ${addr.DEV}${bringYourOwnDev ? '  (your sponsor wallet)' : '  (generated — fund this one)'}`);
console.log(`COLLECTION  ${addr.COLLECTION}  (the Paint collection; no funds needed)`);
console.log(`\nNext:
  1. Make sure the DEV address holds KOIN (mainnet) — ~100-150 KOIN recommended.
  2. KOINOS_NETWORK=mainnet node scripts/deploy-playground.js ${out}
  3. Set the server env vars (see docs/DEPLOY.md §5) and start / redeploy.`);
