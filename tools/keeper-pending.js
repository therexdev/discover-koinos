'use strict';
const fs = require('fs');
const path = require('path');

function keeperPendingFile(configured) {
  return configured || path.join(
    process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, '..', 'data'),
    'keeper-pending.json'
  );
}

/* One keeper process owns this file. Persist BEFORE broadcast: after a
   crash, an unknown outcome must pause the launch, never create a new tx.
   No private keys, signatures or transaction payloads are stored here. */
function createPendingStore(file, binding) {
  let state = { version: 1, binding, launches: {} };
  let contents;
  try { contents = fs.readFileSync(file, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (contents !== undefined) {
    state = JSON.parse(contents);
    if (state.version !== 1 || JSON.stringify(state.binding) !== JSON.stringify(binding) ||
        !state.launches || typeof state.launches !== 'object' || Array.isArray(state.launches)) {
      throw new Error('keeper pending journal has an invalid format or chain/account binding');
    }
    for (const [id, entry] of Object.entries(state.launches)) {
      if (!/^\d+$/.test(id) || !entry || typeof entry.txId !== 'string' || !entry.txId ||
          typeof entry.action !== 'string' || typeof entry.createdAt !== 'string') {
        throw new Error('keeper pending journal contains an invalid transaction record');
      }
    }
  }
  function save(next) {
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    let fd;
    try {
      fd = fs.openSync(temp, 'w', 0o600);
      fs.writeFileSync(fd, JSON.stringify(next, null, 2) + '\n');
      fs.fsyncSync(fd);
      fs.closeSync(fd); fd = undefined;
      fs.renameSync(temp, file);
      state = next; // even a later directory-fsync failure must retain the guard
      const directory = fs.openSync(dir, 'r');
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      if (fs.existsSync(temp)) fs.unlinkSync(temp);
    }
  }
  return {
    get: id => state.launches[String(id)],
    entries: () => Object.entries(state.launches),
    set(id, entry) {
      if (state.launches[String(id)]) throw new Error(`keeper launch #${id} already has a pending transaction`);
      save({ ...state, launches: { ...state.launches, [String(id)]: entry } });
    },
    clear(id, txId) {
      if (state.launches[String(id)]?.txId !== txId) throw new Error('keeper pending transaction changed unexpectedly');
      const launches = { ...state.launches };
      delete launches[String(id)];
      save({ ...state, launches });
    },
  };
}

module.exports = { createPendingStore, keeperPendingFile };
