import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const workflowPath = path.join(repositoryRoot, '.github', 'workflows', 'release.yml');
const validatorPath = path.join(repositoryRoot, 'scripts', 'verify-release-tag.mjs');
const workflowText = readFileSync(workflowPath, 'utf8');

function runGit(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function makeFixture(t) {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'apex-release-tag-parity-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  runGit(cwd, ['init', '--quiet', '--initial-branch=main']);
  runGit(cwd, ['config', 'user.name', 'Release parity test']);
  runGit(cwd, ['config', 'user.email', 'release-parity@example.invalid']);

  writeFileSync(path.join(cwd, 'source.txt'), 'release source commit\n');
  runGit(cwd, ['add', 'source.txt']);
  runGit(cwd, ['commit', '--quiet', '-m', 'release source commit']);
  const taggedCommit = runGit(cwd, ['rev-parse', 'HEAD']);
  runGit(cwd, ['tag', 'v1.0.0']);
  runGit(cwd, ['tag', '--annotate', 'v1.0.1', '--message', 'annotated release tag']);

  writeFileSync(path.join(cwd, 'source.txt'), 'later branch commit\n');
  runGit(cwd, ['add', 'source.txt']);
  runGit(cwd, ['commit', '--quiet', '-m', 'later branch commit']);
  const branchCommit = runGit(cwd, ['rev-parse', 'HEAD']);
  runGit(cwd, ['tag', 'v1.0.2', taggedCommit]);

  return { cwd, taggedCommit, branchCommit };
}

function runValidator(cwd, releaseTag) {
  const env = { ...process.env, RELEASE_TAG: releaseTag };
  return spawnSync(process.execPath, [validatorPath], {
    cwd,
    env,
    encoding: 'utf8',
    windowsHide: true,
  });
}

function workflowStep(name) {
  const marker = `      - name: ${name}\n`;
  const start = workflowText.indexOf(marker);
  assert.notEqual(start, -1, `Missing workflow step: ${name}`);
  const next = workflowText.indexOf('\n      - name:', start + marker.length);
  return workflowText.slice(start, next === -1 ? undefined : next);
}

function releaseIsEnabled(eventName, githubRef, releaseTag) {
  return (
    (eventName === 'push' && githubRef.startsWith('refs/tags/')) ||
    (eventName === 'workflow_dispatch' && releaseTag !== '')
  );
}

test('workflow checks out the requested tag and gates publishing on successful parity validation', () => {
  const checkout = workflowStep('Checkout Source Code');
  const validate = workflowStep('Validate release tag commit');
  const setupNode = workflowStep('Setup Node.js Environment');
  const install = workflowStep('Install Project Dependencies');
  const packageStep = workflowStep('Package Standalone Windows Executable (.exe)');
  const publish = workflowStep('Create GitHub Release & Upload Assets');

  assert.match(
    checkout,
    /ref:\s*\$\{\{\s*inputs\.release_tag\s*&&\s*format\('refs\/tags\/\{0\}',\s*inputs\.release_tag\)\s*\|\|\s*github\.ref\s*\}\}/,
  );
  assert.match(
    validate,
    /if:\s*\(github\.event_name == 'push' && startsWith\(github\.ref, 'refs\/tags\/'\)\) \|\| \(github\.event_name == 'workflow_dispatch' && inputs\.release_tag != ''\)/,
  );
  assert.match(validate, /RELEASE_TAG:\s*\$\{\{\s*inputs\.release_tag\s*\|\|\s*github\.ref_name\s*\}\}/);
  assert.match(validate, /run:\s*node scripts\/verify-release-tag\.mjs/);
  const stepPositions = [
    'Checkout Source Code',
    'Setup Node.js Environment',
    'Validate release tag commit',
    'Install Project Dependencies',
    'Package Standalone Windows Executable (.exe)',
    'Create GitHub Release & Upload Assets',
  ].map((name) => workflowText.indexOf(`      - name: ${name}`));
  assert.ok(stepPositions.every((position) => position !== -1));
  assert.ok(stepPositions.every((position, index) => index === 0 || stepPositions[index - 1] < position));
  assert.ok([checkout, validate, setupNode, install, packageStep, publish].every(Boolean));

  assert.match(
    publish,
    /if:\s*success\(\) && \(\(github\.event_name == 'push' && startsWith\(github\.ref, 'refs\/tags\/'\)\) \|\| \(github\.event_name == 'workflow_dispatch' && inputs\.release_tag != ''\)\)/,
  );
  assert.match(publish, /tag_name:\s*\$\{\{\s*inputs\.release_tag\s*\|\|\s*github\.ref_name\s*\}\}/);
});

test('lightweight tag resolves to the checked-out commit', (t) => {
  const fixture = makeFixture(t);
  runGit(fixture.cwd, ['checkout', '--quiet', '--detach', 'refs/tags/v1.0.0']);

  const result = runValidator(fixture.cwd, 'v1.0.0');
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, new RegExp(fixture.taggedCommit));
});

test('annotated tag peels to the checked-out commit', (t) => {
  const fixture = makeFixture(t);
  runGit(fixture.cwd, ['checkout', '--quiet', '--detach', 'refs/tags/v1.0.1']);

  const result = runValidator(fixture.cwd, 'v1.0.1');
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, new RegExp(fixture.taggedCommit));
});

test('a tag/HEAD commit mismatch fails closed before the release step can run', (t) => {
  const fixture = makeFixture(t);
  assert.equal(runGit(fixture.cwd, ['rev-parse', 'HEAD']), fixture.branchCommit);

  const result = runValidator(fixture.cwd, 'v1.0.2');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not match release tag 'v1\.0\.2' commit/i);

  const validate = workflowStep('Validate release tag commit');
  const publish = workflowStep('Create GitHub Release & Upload Assets');
  assert.ok(workflowText.indexOf(validate) < workflowText.indexOf(publish));
  assert.match(publish, /if:\s*success\(\) &&/);
});

test('a nonexistent tag fails safely', (t) => {
  const fixture = makeFixture(t);
  const result = runValidator(fixture.cwd, 'v9.9.9');

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not exist in the checkout/i);
});

test('an invalid version-tag format fails before resolving a ref', (t) => {
  const fixture = makeFixture(t);
  const result = runValidator(fixture.cwd, 'main');

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must match vX\.Y\.Z/i);
});

test('a tag-push event checks out and validates the triggering tag', (t) => {
  const fixture = makeFixture(t);
  const eventName = 'push';
  const githubRef = 'refs/tags/v1.0.0';
  const releaseTagInput = '';
  const checkoutRef = releaseTagInput || githubRef;
  const validationTag = releaseTagInput || githubRef.slice('refs/tags/'.length);

  assert.equal(checkoutRef, githubRef);
  runGit(fixture.cwd, ['checkout', '--quiet', '--detach', checkoutRef]);
  assert.equal(runGit(fixture.cwd, ['rev-parse', 'HEAD']), fixture.taggedCommit);
  assert.equal(runValidator(fixture.cwd, validationTag).status, 0);
  assert.equal(releaseIsEnabled(eventName, githubRef, releaseTagInput), true);
});

test('manual dispatch with a supplied tag checks out and validates that tag', (t) => {
  const fixture = makeFixture(t);
  const eventName = 'workflow_dispatch';
  const githubRef = 'refs/heads/main';
  const releaseTagInput = 'v1.0.1';
  const checkoutRef = releaseTagInput ? `refs/tags/${releaseTagInput}` : githubRef;

  assert.equal(checkoutRef, `refs/tags/${releaseTagInput}`);
  runGit(fixture.cwd, ['checkout', '--quiet', '--detach', checkoutRef]);
  assert.equal(runGit(fixture.cwd, ['rev-parse', 'HEAD']), fixture.taggedCommit);
  assert.equal(runValidator(fixture.cwd, releaseTagInput).status, 0);
  assert.equal(releaseIsEnabled(eventName, githubRef, releaseTagInput), true);
});

test('manual dispatch without a release tag keeps the selected branch and never publishes', (t) => {
  const fixture = makeFixture(t);
  const eventName = 'workflow_dispatch';
  const githubRef = 'refs/heads/main';
  const releaseTagInput = '';
  const checkoutRef = releaseTagInput || githubRef;

  assert.equal(checkoutRef, githubRef);
  runGit(fixture.cwd, ['checkout', '--quiet', checkoutRef]);
  assert.equal(runGit(fixture.cwd, ['rev-parse', 'HEAD']), fixture.branchCommit);
  assert.equal(releaseIsEnabled(eventName, githubRef, releaseTagInput), false);

  // Even dispatching manually from a tag without release_tag must remain build-only.
  assert.equal(releaseIsEnabled('workflow_dispatch', 'refs/tags/v1.0.0', ''), false);

  const install = workflowStep('Install Project Dependencies');
  const build = workflowStep('Compile Optimized Web Bundle');
  const publish = workflowStep('Create GitHub Release & Upload Assets');
  assert.ok(install.length > 0 && build.length > 0, 'branch dispatch keeps the normal build steps');
  assert.match(publish, /event_name == 'workflow_dispatch' && inputs\.release_tag != ''/);
});
