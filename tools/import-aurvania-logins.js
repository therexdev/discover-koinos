#!/usr/bin/env node
/* CLI for importing Aurvania's hosted Google wallets into this gateway's
   store. The import itself lives in tools/import-aurvania.js — the SAME code
   the gateway runs at boot when it finds data/aurvania-logins.json next to
   its store (see tools/auth.js), which is the no-terminal way to do this:

     1. copy Aurvania's logins.json into this gateway's DATA_DIR as
        `aurvania-logins.json` (hPanel File Manager is enough),
     2. set AURVANIA_LOGIN_SECRET in the gateway's environment,
     3. restart the gateway and read the [auth:import] boot log lines.

   The boot path is all-or-nothing and renames the file to
   `aurvania-logins.imported-<ts>.json` on success so it never runs twice.

   This CLI does the identical import by hand, with a rehearsal by default:

     AURVANIA_LOGIN_SECRET=…  LOGIN_SECRET=…  \
       node tools/import-aurvania-logins.js /path/to/aurvania-logins.json
     …same, plus --apply to actually write.

   Only use the CLI with the gateway STOPPED — a running gateway holds the
   store in memory and its next save() would write over the imported file.
   (The boot path has no such hazard: it runs inside the only process that
   owns the store, before anything is served.)

   Why copying the file over can never work: both apps wrap keys with
   AES-256-GCM under scrypt(LOGIN_SECRET, salt), but the salts differ —
   Aurvania uses 'kc-wif-enc-v1', this gateway 'dk-wif-enc-v1'. Same secret,
   different key, so a moved blob fails its auth tag. Migration must
   decrypt-under-kc, verify, re-encrypt-under-dk, which is what this does. */
'use strict';

const path = require('path');
const { importAurvania } = require('./import-aurvania');

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const positional = args.filter(a => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--data-dir');
const dataDirFlag = (() => {
  const i = args.indexOf('--data-dir');
  return i >= 0 ? args[i + 1] : '';
})();

const sourceFile = positional[0];
const kcSecret = process.env.AURVANIA_LOGIN_SECRET || '';
const dkSecret = process.env.LOGIN_SECRET || '';

function die(msg) {
  console.error('\n*** ' + msg + '\n');
  process.exit(1);
}

if (!sourceFile) die('usage: AURVANIA_LOGIN_SECRET=… LOGIN_SECRET=… node tools/import-aurvania-logins.js <aurvania-logins.json> [--data-dir DIR] [--apply]');
if (!kcSecret) die('AURVANIA_LOGIN_SECRET is not set — the secret Aurvania wraps its keys with');
if (!dkSecret) die('LOGIN_SECRET is not set — the secret THIS gateway wraps its keys with');

const dataDir = path.resolve(dataDirFlag || process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const destFile = path.join(dataDir, 'logins.json');

let r;
try {
  r = importAurvania({ sourceFile, sourceSecret: kcSecret, destFile, destSecret: dkSecret, write: apply });
} catch (e) {
  die(`import could not run: ${e.message}`);
}

console.log('');
for (const line of r.failLines) console.error(line);
for (const line of r.lines) console.log(line);
console.log('');

if (!r.ok) die(`${r.failures} record(s) failed — NOTHING was written. Fix the cause and run again.`);
if (!r.imported) { console.log('Nothing to import — the store is already complete. No changes made.'); process.exit(0); }
if (!apply) {
  console.log('Rehearsal only — nothing written. Every record decrypted, verified and re-wrapped cleanly.');
  console.log('Run again with --apply to write. STOP THE GATEWAY FIRST (see the header of this file).');
  process.exit(0);
}
console.log('Start the gateway again. Imported users now sign in without touching Aurvania.');
