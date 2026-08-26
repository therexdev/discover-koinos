/* The import itself — shared by the CLI (tools/import-aurvania-logins.js) and
   the boot-time hook in tools/auth.js, so both paths have identical semantics:

     decrypt each Aurvania Google wallet under scrypt(secret,'kc-wif-enc-v1'),
     verify the key derives exactly the address on the record,
     re-encrypt under scrypt(secret,'dk-wif-enc-v1'),
     verify the new blob round-trips,
     ALL-OR-NOTHING: any failure and nothing is written,
     never overwrite a record already in the destination (but cross-check it
     holds the SAME key — divergence is a human decision, so it aborts).

   byEmail / byPi are counted and left alone: this gateway has no sign-in
   that could serve them yet. Writing is atomic (tmp + rename, mode 0600)
   with a timestamped backup of the previous store. */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Signer } = require('koilib');

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

/**
 * @returns {{ok:boolean, imported:number, alreadyHere:number, failures:number,
 *            wrote:boolean, backup:string|null, lines:string[], failLines:string[]}}
 * write:false is the rehearsal — full verification, nothing written.
 */
function importAurvania({ sourceFile, sourceSecret, destFile, destSecret, write = false }) {
  const kcKey = crypto.scryptSync(sourceSecret, 'kc-wif-enc-v1', 32);
  const dkKey = crypto.scryptSync(destSecret, 'dk-wif-enc-v1', 32);

  const lines = [], failLines = [];

  const source = JSON.parse(fs.readFileSync(sourceFile, 'utf8'));
  const srcGoogle = source.byGoogle || {};

  let dest;
  try { dest = JSON.parse(fs.readFileSync(destFile, 'utf8')); }
  catch (_) { dest = {}; }
  dest.byGoogle = dest.byGoogle || {};
  dest.byX = dest.byX || {};

  const now = Date.now();
  const toWrite = {};
  let imported = 0, alreadyHere = 0, failures = 0;

  for (const [sub, rec] of Object.entries(srcGoogle)) {
    const who = `${rec.email || 'no-email'} (${rec.addr || '?'})`;

    let wif;
    try { wif = decrypt(rec.wifEnc, kcKey); }
    catch (_) {
      failLines.push(`FAIL  ${who} — cannot decrypt under AURVANIA_LOGIN_SECRET. Wrong secret?`);
      failures++; continue;
    }

    let derived;
    try { derived = Signer.fromWif(wif).getAddress(); }
    catch (_) { derived = ''; }
    if (!derived || derived !== rec.addr) {
      failLines.push(`FAIL  ${who} — decrypted key derives ${derived || 'nothing'}, record says ${rec.addr}`);
      failures++; continue;
    }

    const existing = dest.byGoogle[sub];
    if (existing && existing.wifEnc) {
      let localWif;
      try { localWif = decrypt(existing.wifEnc, dkKey); }
      catch (_) {
        failLines.push(`FAIL  ${who} — already in this store but unopenable under LOGIN_SECRET. Wrong secret?`);
        failures++; continue;
      }
      if (localWif !== wif) {
        failLines.push(`FAIL  ${who} — this store and Aurvania hold DIFFERENT keys for the same Google account. Resolve by hand before importing.`);
        failures++; continue;
      }
      alreadyHere++; continue;
    }

    const wrapped = encrypt(wif, dkKey);
    if (decrypt(wrapped, dkKey) !== wif) {
      failLines.push(`FAIL  ${who} — re-encrypted blob did not round-trip (this should be impossible)`);
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

  const emails = Object.keys(source.byEmail || {}).length;
  const pis = Object.keys(source.byPi || {}).length;

  lines.push(`source:      ${sourceFile} — ${Object.keys(srcGoogle).length} Google account(s)`);
  lines.push(`destination: ${destFile}`);
  lines.push(`  ready to import:   ${imported}`);
  lines.push(`  already here:      ${alreadyHere} (adopted on a live login — untouched, keys verified identical)`);
  lines.push(`  failures:          ${failures}`);
  if (emails || pis) {
    lines.push(`  staying with Aurvania: ${emails} email + ${pis} Pi account(s) — this gateway has no sign-in for them yet`);
  }

  const result = { ok: failures === 0, imported, alreadyHere, failures, wrote: false, backup: null, lines, failLines };
  if (failures || !imported || !write) return result;

  fs.mkdirSync(path.dirname(destFile), { recursive: true });
  if (fs.existsSync(destFile)) {
    result.backup = `${destFile}.bak-${new Date(now).toISOString().replace(/[:.]/g, '-')}`;
    fs.copyFileSync(destFile, result.backup);
    lines.push(`backup:      ${result.backup}`);
  }

  Object.assign(dest.byGoogle, toWrite);
  const tmp = `${destFile}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(dest, null, 1), { mode: 0o600 });
  fs.renameSync(tmp, destFile);
  result.wrote = true;
  lines.push(`WRITTEN — ${imported} wallet(s) imported, ${alreadyHere} left as adopted, ${Object.keys(dest.byGoogle).length} total in the store.`);
  return result;
}

module.exports = { importAurvania };
