// native/vst3/host.cpp cannot be compiled in this sandbox: it needs the VST3 SDK
// headers that only the Windows CI job fetches. A file-scope declaration placed
// inside the class body therefore reached CI before it was caught, and MSVC
// rejected it with C2864. These tests give that file the one structural check that
// does not need the SDK: is the declaration actually at file scope?
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { braceDepthBeforeLine, findLine } from '../scripts/lib/cppScopeDepth.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const host = readFileSync(path.join(root, 'native', 'vst3', 'host.cpp'), 'utf8');

test('the depth reader ignores braces in comments and literals', () => {
  const src = [
    'int a = 0;            // { not a brace',
    'const char* s = "}";  // nor this',
    'void f() {',
    '  int b = 1;',
    '}',
    'int c = 2;',
  ].join('\n');
  assert.equal(braceDepthBeforeLine(src, 1), 0);
  assert.equal(braceDepthBeforeLine(src, 3), 0, 'comment and literal braces do not count');
  assert.equal(braceDepthBeforeLine(src, 4), 1, 'inside f()');
  assert.equal(braceDepthBeforeLine(src, 6), 0, 'back at file scope');
  assert.throws(() => braceDepthBeforeLine(src, 99), RangeError);
  assert.equal(findLine(src, (line) => line.startsWith('int c')), 6);
  assert.equal(findLine(src, () => false), null);
});

test('the CPU clock calibration variable is declared at file scope', () => {
  // Declared inside `class Instance` it becomes a static data member with an
  // in-class initializer, which MSVC rejects (C2864) and which main() cannot see
  // (C2065). Both errors are Windows-only, so this is the local guard.
  const line = findLine(host, (text) => text.startsWith('static double g_apexObservedCpuStepMs'));
  assert.ok(line, 'the declaration must exist');
  assert.equal(
    braceDepthBeforeLine(host, line),
    0,
    `g_apexObservedCpuStepMs at line ${line} must be at file scope, not inside a class`,
  );
});

test('the declaration precedes both the class that reads it and main()', () => {
  const decl = findLine(host, (text) => text.startsWith('static double g_apexObservedCpuStepMs'));
  const klass = findLine(host, (text) => text.startsWith('class Instance {'));
  const main = findLine(host, (text) => text.startsWith('int main('));
  assert.ok(klass && main, 'the class and main() must be present');
  assert.ok(decl < klass, `the declaration (line ${decl}) must precede class Instance (line ${klass})`);
  assert.ok(decl < main, `the declaration (line ${decl}) must precede main() (line ${main})`);
  assert.equal(braceDepthBeforeLine(host, klass), 0, 'class Instance opens at file scope');
  assert.equal(braceDepthBeforeLine(host, main), 0, 'main() opens at file scope');
});

test('every use of the calibration variable sits after its declaration', () => {
  const decl = findLine(host, (text) => text.startsWith('static double g_apexObservedCpuStepMs'));
  const uses = [];
  host.split('\n').forEach((text, i) => {
    if (text.includes('g_apexObservedCpuStepMs') && i + 1 !== decl) uses.push(i + 1);
  });
  assert.ok(uses.length >= 3, 'the recorder, the calibration call and the log line all use it');
  for (const line of uses) {
    assert.ok(line > decl, `the use at line ${line} must follow the declaration at line ${decl}`);
  }
});
