#!/usr/bin/env node
// Verify that every intended test file is discovered by a documented npm test script.
// Fails if any src test file is not covered. Guards against future orphaned files.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

function walk(dir, pattern) {
  const results = [];
  try {
    const st = statSync(dir);
    if (!st.isDirectory()) return results;
  } catch { return results; }
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) results.push(...walk(full, pattern));
    else if (pattern.test(e.name)) results.push(full);
  }
  return results;
}

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const scripts = pkg.scripts || {};
const patterns = [];
for (const [k, v] of Object.entries(scripts)) {
  if (!k.startsWith('test:')) continue;
  const tokens = v.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
  for (let tok of tokens) {
    tok = tok.replace(/^["']|["']$/g, '');
    if (tok.startsWith('src/') || tok.startsWith('tests/')) {
      patterns.push(tok);
    }
  }
}

function matches(file, pat) {
  let regexStr = '^' + pat.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '<<DOUBLE>>')
    .replace(/\*/g, '[^/]*')
    .replace(/<<DOUBLE>>/g, '.*')
    .replace(/\?/g, '.') + '$';
  const re = new RegExp(regexStr);
  return re.test(file);
}

const allSrcTests = walk('src', /\.test\.(ts|tsx|js|jsx|mjs|cjs)$/);
const allTestsDir = walk('tests', /\.test\.(mjs|cjs|ts|js)$/);
const allTests = [...allSrcTests, ...allTestsDir].map(p => p.replace(/\\/g, '/'));

const covered = new Set();
for (const file of allTests) {
  for (const pat of patterns) {
    if (matches(file, pat)) {
      covered.add(file);
      break;
    }
  }
}

const orphaned = allTests.filter(f => !covered.has(f));

console.log(`Total test files: ${allTests.length} (src: ${allSrcTests.length}, tests: ${allTestsDir.length})`);
console.log(`Covered via package.json test:* patterns: ${covered.size}`);
console.log(`Orphaned: ${orphaned.length}`);
if (orphaned.length) {
  console.log('\nOrphaned files (NOT discovered):');
  for (const o of orphaned) console.log('  - ' + o);
  console.log('\nPatterns considered:');
  for (const p of patterns) console.log('  ' + p);
  process.exit(1);
} else {
  console.log('All test files are discovered. No orphaned files.');
  const byDir = {};
  for (const f of allTests) {
    const dir = f.split('/').slice(0, 3).join('/');
    byDir[dir] = (byDir[dir] || 0) + 1;
  }
  console.log('\nBy directory:');
  for (const [k,v] of Object.entries(byDir).sort()) console.log(`  ${k}: ${v}`);
}
