#!/usr/bin/env node
/* Build a Koinos contract: precompile (index.ts + ABI) then compile to WASM.
   Usage: node build.js <token> */
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const name = process.argv[2];
if (!['token'].includes(name)) {
  console.error('usage: node build.js <token>');
  process.exit(1);
}
const dir = path.join(__dirname, name);
const bin = (b) => path.join(__dirname, 'node_modules', '.bin', b);

execFileSync(bin('koinos-precompiler-as'), [name], { cwd: __dirname, stdio: 'inherit' });

const asconfig = {
  targets: {
    testnet: { outFile: './build/testnet/contract.wasm', optimizeLevel: 3, shrinkLevel: 0, use: ['BUILD_FOR_TESTING=1'] },
    release: { outFile: './build/release/contract.wasm', optimizeLevel: 3, shrinkLevel: 0, use: ['BUILD_FOR_TESTING=0'] },
  },
  options: { exportStart: '_start', disable: ['sign-extension', 'bulk-memory'] },
};
fs.writeFileSync(path.join(dir, 'asconfig.json'), JSON.stringify(asconfig, null, 2));

for (const target of ['testnet', 'release']) {
  execFileSync(bin('asc'), [
    'build/index.ts', '--config', 'asconfig.json', '--use', 'abort=', '--target', target,
  ], { cwd: dir, stdio: 'inherit' });
  const out = path.join(dir, 'build', target, 'contract.wasm');
  console.log(`${name} ${target}: ${fs.statSync(out).size} bytes -> ${out}`);
}

/* Publish the build where the server and deploy tooling read it. */
const prebuilt = path.join(__dirname, 'prebuilt', name);
fs.mkdirSync(prebuilt, { recursive: true });
fs.copyFileSync(path.join(dir, 'build', 'release', 'contract.wasm'), path.join(prebuilt, 'contract.wasm'));
const abiSrc = path.join(dir, 'build', `${name === 'token' ? 'launchpadtoken' : name}-abi.json`);
const abiCandidates = fs.readdirSync(path.join(dir, 'build')).filter(f => f.endsWith('-abi.json'));
const abi = fs.existsSync(abiSrc) ? abiSrc : path.join(dir, 'build', abiCandidates[0]);
fs.copyFileSync(abi, path.join(prebuilt, 'abi.json'));
fs.copyFileSync(abi, path.join(__dirname, '..', 'server-abi', 'token-abi.json'));
console.log(`published: ${prebuilt}/contract.wasm + abi.json, server-abi/token-abi.json`);
