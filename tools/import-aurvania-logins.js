#!/usr/bin/env node
/* Import Aurvania's hosted Google wallets into THIS gateway's store, without
   losing a single one.

     AURVANIA_LOGIN_SECRET=…  LOGIN_SECRET=…  \
       node tools/import-aurvania-logins.js /path/to/aurvania-logins.json
     …same, plus --apply to actually write.

   Without --apply it is a rehearsal: every record is decrypted, verified and
   re-encrypted in memory, the full outcome is reported, and NOTHING is
   written. Run the rehearsal first, every time.

   ── Why copying the file over can never work ───────────────────────────────

   Both apps wrap keys with AES-256-GCM under scrypt(LOGIN_SECRET, salt), but
   the salts differ: Aurvania uses 'kc-wif-enc-v1', this gateway uses
   'dk-wif-enc-v1'. Same secret, different key — so a blob moved between the
   stores fails its auth tag and the wallet is unopenable. Migration means
   decrypt-under-kc, verify, re-encrypt-under-dk. That is all this tool does.

   ── What it will and will not touch ────────────────────────────────────────

   Imported:  byGoogle — every wallet, each one verified twice (the decrypted
              key must derive exactly the address on the record, and the
              re-encrypted blob must decrypt back to the same key).
   Kept:      any account already in THIS store (adopted on a live login) is
              never overwritten. It is cross-checked instead: if Aurvania's
              copy holds a DIFFERENT key for the same Google account, the run
              aborts — that must be a human decision.
   Left:      byEmail and byPi stay with Aurvania — this gateway has no
              email or Pi sign-in to serve them. They are counted in the
              report so nothing disappears silently. byAddr is a derived
              index and is not needed here.

   The run is ALL-OR-NOTHING: one record that fails to decrypt or verify
   aborts the whole import and nothing is written. A partial wallet store
   that looks complete is worse than a loud failure.

   ── STOP THIS GATEWAY FIRST. Not a formality. ──────────────────────────────

   The server loads logins.json at boot and keeps it in memory; its next
   save() writes that memory back over the file. Import while it runs and
   the first login afterwards silently reverts the file. Stop the app,
   import, start the app.

   Aurvania itself keeps running throughout — its store is only read, and
   accounts not yet imported still adopt lazily on their next login. */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Signer } = require('koilib');

/* ---- arguments ---- */

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const positional = args.filter(a => !a.startsWith('--'));
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

/* ---- the two wrapping keys (same construction, different salt) ---- */

const kcKey = crypto.scryptSync(kcSecret, 'kc-wif-enc-v1', 32);
const dkKey = crypto.scryptSync(dkSecret, 'dk-wif-enc-v1', 32);

function decrypt(blob, key) {
  const [iv, tag, data] = String(blob).split('.').map(x => Buffer.from(x, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]).toString('utf8');
}

function encrypt(wif, key) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([c.update(wif, 'utf8'), c.final()]);
  return [iv.toString('base64'), c.getAuthTag().toString('base64'), data.toString('base64')].join('.');
}

/* ---- load both stores ---- */

let source;
try { source = JSON.parse(fs.readFileSync(sourceFile, 'utf8')); }
catch (e) { die(`cannot read the Aurvania store at ${sourceFile}: ${e.message}`); }
const srcGoogle = source.byGoogle || {};

let dest;
try { dest = JSON.parse(fs.readFileSync(destFile, 'utf8')); }
catch (_) { dest = {}; }
dest.byGoogle = dest.byGoogle || {};
dest.byX = dest.byX || {};

/* ---- the pass: decrypt, verify, re-encrypt — in memory ---- */

const now = Date.now();
const toWrite = {};
let imported = 0, alreadyHere = 0, failures = 0;

for (const [sub, rec] of Object.entries(srcGoogle)) {
  const who = `${rec.email || 'no-email'} (${rec.addr || '?'})`;

  let wif;
  try { wif = decrypt(rec.wifEnc, kcKey); }
  catch (_) {
    console.error(`FAIL  ${who} — cannot decrypt under AURVANIA_LOGIN_SECRET. Wrong secret?`);
    failures++; continue;
  }

  let derived;
  try { derived = Signer.fromWif(wif).getAddress(); }
  catch (_) { derived = ''; }
  if (!derived || derived !== rec.addr) {
    console.error(`FAIL  ${who} — decrypted key derives ${derived || 'nothing'}, record says ${rec.addr}`);
    failures++; continue;
  }

  const existing = dest.byGoogle[sub];
  if (existing && existing.wifEnc) {
    /* Adopted already on a live login. Never overwrite — but do prove both
       stores hold the SAME key; a divergence here is never resolvable by a
       script. */
    let localWif;
    try { localWif = decrypt(existing.wifEnc, dkKey); }
    catch (_) {
      console.error(`FAIL  ${who} — already in this store but unopenable under LOGIN_SECRET. Wrong secret?`);
      failures++; continue;
    }
    if (localWif !== wif) {
      console.error(`FAIL  ${who} — this store and Aurvania hold DIFFERENT keys for the same Google account. Resolve by hand before importing.`);
      failures++; continue;
    }
    alreadyHere++; continue;
  }

  const wrapped = encrypt(wif, dkKey);
  if (decrypt(wrapped, dkKey) !== wif) {
    console.error(`FAIL  ${who} — re-encrypted blob did not round-trip (this should be impossible)`);
    failures++; continue;
  }

  toWrite[sub] = {
    email: String(rec.email || '').toLowerCase(),
    wifEnc: wrapped,
    addr: rec.addr,
    importedFrom: 'aurvania',
    importedAt: now,
    ...(rec.createdAt ? { createdAt: rec.createdAt } : {}),
  };
  imported++;
}

/* ---- report ---- */

const emails = Object.keys(source.byEmail || {}).length;
const pis = Object.keys(source.byPi || {}).length;

console.log('');
console.log(`source:      ${sourceFile} — ${Object.keys(srcGoogle).length} Google account(s)`);
console.log(`destination: ${destFile}`);
console.log('');
console.log(`  ready to import:   ${imported}`);
console.log(`  already here:      ${alreadyHere} (adopted on a live login — untouched, keys verified identical)`);
console.log(`  failures:          ${failures}`);
if (emails || pis) {
  console.log(`  staying with Aurvania: ${emails} email + ${pis} Pi account(s) — this gateway has no sign-in for them yet`);
}
console.log('');

if (failures) die(`${failures} record(s) failed — NOTHING was written. Fix the cause and run again.`);
if (!imported) { console.log('Nothing to import — the store is already complete. No changes made.'); process.exit(0); }

if (!apply) {
  console.log('Rehearsal only — nothing written. Every record decrypted, verified and re-wrapped cleanly.');
  console.log('Run again with --apply to write. STOP THE GATEWAY FIRST (see the header of this file).');
  process.exit(0);
}

/* ---- write: backup, then atomic replace ---- */

fs.mkdirSync(dataDir, { recursive: true });
if (fs.existsSync(destFile)) {
  const bak = `${destFile}.bak-${new Date(now).toISOString().replace(/[:.]/g, '-')}`;
  fs.copyFileSync(destFile, bak);
  console.log(`backup:      ${bak}`);
}

Object.assign(dest.byGoogle, toWrite);
const tmp = `${destFile}.tmp-${process.pid}`;
fs.writeFileSync(tmp, JSON.stringify(dest, null, 1), { mode: 0o600 });
fs.renameSync(tmp, destFile);

console.log(`WRITTEN — ${imported} wallet(s) imported, ${alreadyHere} left as adopted, ${Object.keys(dest.byGoogle).length} total in the store.`);
console.log('Start the gateway again. Imported users now sign in without touching Aurvania.');
