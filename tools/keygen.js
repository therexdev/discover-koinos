#!/usr/bin/env node
/* Generate the gateway's two role keypairs and append them to an env
   file (default gateway.env, chmod 600). Prints ADDRESSES only — the
   private keys go straight to the file.

     · dev        — the sponsor wallet. Holds tKOIN/KOIN; its mana pays
                    for every visitor action. The only hot key.
     · collection — the playground NFT collection account. Needed hot on
                    the server too: free mints are signed AS the
                    collection (its contract authorizes mint by owner OR
                    itself).

   Usage: node tools/keygen.js [outfile]
*/
'use strict';
const fs = require('fs');
const crypto = require('crypto');
const { Signer } = require('koilib');

const out = process.argv[2] || 'gateway.env';
const roles = ['DEV', 'COLLECTION'];

let text = `# Discover Koinos gateway keys — generated ${new Date().toISOString()}\n` +
  `# KEEP THIS FILE SECRET. The DEV key holds the sponsor funds.\n`;
const addresses = {};
for (const role of roles) {
  const signer = new Signer({ privateKey: crypto.randomBytes(32).toString('hex') });
  addresses[role] = signer.getAddress();
  text += `GATEWAY_${role}_WIF=${signer.getPrivateKey('wif', true)}\n`;
  text += `# GATEWAY_${role}_ADDR=${signer.getAddress()}\n`;
}

fs.writeFileSync(out, text, { mode: 0o600, flag: 'wx' });
console.log(`wrote ${out} (mode 600)\n`);
for (const role of roles) console.log(`${role.padEnd(11)} ${addresses[role]}`);
console.log(`\nNext:
  1. Fund the DEV address with tKOIN — Koinos Discord #faucet: "!faucet ${addresses.DEV}"
     (100 tKOIN per request; ask twice — a collection deploy needs ~80 mana)
  2. node scripts/deploy-playground.js gateway.env
  3. Start the server with the env vars it prints.`);
