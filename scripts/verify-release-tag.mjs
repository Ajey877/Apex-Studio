#!/usr/bin/env node

import { spawnSync } from 'node:child_process';

const releaseTag = process.env.RELEASE_TAG ?? '';
const versionTagPattern = /^v[0-9]+\.[0-9]+\.[0-9]+$/;

function runGit(args) {
  const result = spawnSync('git', args, {
    encoding: 'utf8',
    windowsHide: true,
  });

  if (result.error) {
    throw new Error(`Could not run git ${args[0]}: ${result.error.message}`);
  }

  if (result.status !== 0) {
    const detail = result.stderr.trim();
    throw new Error(`git ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`);
  }

  return result.stdout.trim();
}

function verifyReleaseTag() {
  if (!versionTagPattern.test(releaseTag)) {
    throw new Error(`Release tag must match vX.Y.Z; received ${JSON.stringify(releaseTag)}.`);
  }

  const tagRef = `refs/tags/${releaseTag}`;
  const existingTag = spawnSync('git', ['show-ref', '--verify', '--quiet', tagRef], {
    encoding: 'utf8',
    windowsHide: true,
  });

  if (existingTag.error) {
    throw new Error(`Could not verify release tag '${releaseTag}': ${existingTag.error.message}`);
  }

  if (existingTag.status !== 0) {
    throw new Error(`Release tag '${releaseTag}' does not exist in the checkout.`);
  }

  const checkedOutCommit = runGit(['rev-parse', '--verify', 'HEAD^{commit}']);
  const tagCommit = runGit(['rev-parse', '--verify', `${tagRef}^{commit}`]);

  if (checkedOutCommit !== tagCommit) {
    throw new Error(
      `Checked-out HEAD ${checkedOutCommit} does not match release tag '${releaseTag}' commit ${tagCommit}.`,
    );
  }

  console.log(`Verified release tag '${releaseTag}' resolves to checked-out commit ${checkedOutCommit}.`);
}

try {
  verifyReleaseTag();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Release source/tag parity check failed: ${message}`);
  process.exitCode = 1;
}
