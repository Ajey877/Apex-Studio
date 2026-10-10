#!/usr/bin/env node
// Stages a minimal, separate Electron app (results/electron-app) containing only
// the spike runner + harness, so electron-builder can package it exactly like
// the production app is packaged (asar archive, file:// loading, app.isPackaged).
// It uses the Electron version pinned in the repo-root package.json.
//
//   node electron/stage-electron-app.mjs
//   node ../../node_modules/electron-builder/cli.js --win --x64 --dir --publish never --projectDir results/electron-app
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const spikeRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(spikeRoot, '..', '..');
const app = join(spikeRoot, 'results', 'electron-app');
const electronVersion = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).devDependencies.electron.replace(/^[^\d]*/, '');

rmSync(app, { recursive: true, force: true });
mkdirSync(app, { recursive: true });
cpSync(join(spikeRoot, 'electron', 'main.cjs'), join(app, 'main.cjs'));
cpSync(join(spikeRoot, 'electron', 'investigation-steps.cjs'), join(app, 'investigation-steps.cjs'));
cpSync(join(spikeRoot, 'web'), join(app, 'web'), { recursive: true });
cpSync(join(spikeRoot, 'dsp'), join(app, 'dsp'), { recursive: true });
writeFileSync(join(app, 'package.json'), JSON.stringify({
  name: 'apex-audioworklet-wasm-spike-app',
  productName: 'ApexSpike',
  version: '0.0.0',
  private: true,
  description: 'EXPERIMENTAL AudioWorklet + WASM spike runner (not the Apex Studio app)',
  author: 'Apex Studio Team',
  license: 'MIT',
  main: 'main.cjs',
  build: {
    appId: 'com.apexstudio.spike.audioworkletwasm',
    productName: 'ApexSpike',
    electronVersion,
    asar: true,
    npmRebuild: false,
    directories: { output: '../electron-dist' },
    files: ['main.cjs', 'investigation-steps.cjs', 'web/**/*', 'dsp/**/*', 'package.json'],
    win: { target: 'dir' },
    linux: { target: 'dir' },
  },
}, null, 2));
console.log(`[spike] staged Electron app at ${app} (electron ${electronVersion})`);
