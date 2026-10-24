import { copyFile, cp, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
if (process.platform !== 'win32') throw new Error('Windows packaging requires a Windows x64 native build');
const source = path.resolve('build/native-vst3/bin/Release/apex-vst3-host.exe');
await stat(source); // Packaging must fail rather than ship a missing helper.
const target = path.resolve('build/vst3-package');
await mkdir(target, { recursive: true });
await copyFile(source, path.join(target, 'apex-vst3-host.exe'));
await cp('native/vst3/licenses', path.join(target, 'licenses'), { recursive: true });
console.log('Staged x64 VST3 helper (static MSVC CRT) and required notices outside ASAR.');
