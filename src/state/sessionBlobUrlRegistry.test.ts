import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SessionBlobUrlRegistry,
  getProjectSessionBlobUrls,
  replaceProjectSessionBlobUrls,
  sessionBlobUrlRegistry,
} from './sessionBlobUrlRegistry';

const installUrlMocks = () => {
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  let nextId = 0;
  const created: string[] = [];
  const revoked: string[] = [];

  URL.createObjectURL = () => {
    const url = `blob:phase37-${++nextId}`;
    created.push(url);
    return url;
  };
  URL.revokeObjectURL = (url: string) => {
    revoked.push(url);
  };

  return {
    created,
    revoked,
    restore: () => {
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
    },
  };
};

test('recording/session URL ownership is released exactly once', () => {
  const mocks = installUrlMocks();
  const registry = new SessionBlobUrlRegistry();
  try {
    const url = URL.createObjectURL(new Blob(['take']));
    registry.retain(url);
    assert.equal(registry.getOwnerCount(url), 1);

    registry.release(url);
    registry.release(url);

    assert.deepEqual(mocks.revoked, [url]);
    assert.equal(registry.getOwnerCount(url), 0);
  } finally {
    mocks.restore();
  }
});

test('temporary recording ownership can be transferred to the project without double-retaining', () => {
  const mocks = installUrlMocks();
  const registry = new SessionBlobUrlRegistry();
  try {
    const url = URL.createObjectURL(new Blob(['take']));
    registry.retain(url);
    registry.transfer(url);

    assert.equal(registry.getOwnerCount(url), 1);
    registry.release(url);
    assert.deepEqual(mocks.revoked, [url]);
  } finally {
    mocks.restore();
  }
});

test('Project A -> B releases A-only URLs and keeps incoming B URLs', () => {
  const mocks = installUrlMocks();
  const registry = new SessionBlobUrlRegistry();
  try {
    const a = URL.createObjectURL(new Blob(['a']));
    const b = URL.createObjectURL(new Blob(['b']));
    registry.retain(a);

    const projectA = { recordings: [{ audioUrl: a }] };
    const projectB = { recordings: [{ audioUrl: b }] };

    sessionBlobUrlRegistry.retain(a);
    replaceProjectSessionBlobUrls(projectA, projectB);

    assert.deepEqual(mocks.revoked, [a]);
    assert.equal(sessionBlobUrlRegistry.isOwned(b), true);
    sessionBlobUrlRegistry.release(b);
  } finally {
    sessionBlobUrlRegistry.releaseAllOwned();
    mocks.restore();
  }
});

test('shared incoming URL is not revoked during project replacement', () => {
  const mocks = installUrlMocks();
  const registry = new SessionBlobUrlRegistry();
  try {
    const shared = URL.createObjectURL(new Blob(['shared']));
    registry.retain(shared);

    const projectA = { recordings: [{ audioUrl: shared }] };
    const projectB = { recordings: [{ audioUrl: shared }] };

    const previous = new Set(getProjectSessionBlobUrls(projectA));
    const next = new Set(getProjectSessionBlobUrls(projectB));
    for (const url of next) if (!registry.isOwned(url)) registry.retain(url);
    for (const url of previous) if (!next.has(url)) registry.release(url);

    assert.deepEqual(mocks.revoked, []);
    assert.equal(registry.isOwned(shared), true);
  } finally {
    mocks.restore();
  }
});

test('repeated A -> B -> C -> D replacement does not retain obsolete URLs', () => {
  const mocks = installUrlMocks();
  const registry = new SessionBlobUrlRegistry();
  try {
    const urls = ['A', 'B', 'C', 'D'].map(name => `blob:project-${name}`);
    let active = { recordings: [{ audioUrl: urls[0] }] };
    registry.retain(urls[0]);

    for (const url of urls.slice(1)) {
      const next = { recordings: [{ audioUrl: url }] };
      const previousUrls = new Set(getProjectSessionBlobUrls(active));
      const nextUrls = new Set(getProjectSessionBlobUrls(next));
      for (const incoming of nextUrls) if (!registry.isOwned(incoming)) registry.retain(incoming);
      for (const outgoing of previousUrls) if (!nextUrls.has(outgoing)) registry.release(outgoing);
      active = next;
    }

    assert.equal(registry.isOwned(urls[0]), false);
    assert.equal(registry.isOwned(urls[1]), false);
    assert.equal(registry.isOwned(urls[2]), false);
    assert.equal(registry.isOwned(urls[3]), true);
    assert.deepEqual(mocks.revoked, urls.slice(0, 3));
  } finally {
    mocks.restore();
  }
});

test('a second legitimate consumer prevents premature revocation', () => {
  const mocks = installUrlMocks();
  const registry = new SessionBlobUrlRegistry();
  try {
    const url = URL.createObjectURL(new Blob(['shared']));
    registry.retain(url);
    registry.retain(url);

    registry.release(url);
    assert.deepEqual(mocks.revoked, []);
    assert.equal(registry.getOwnerCount(url), 1);

    registry.release(url);
    assert.deepEqual(mocks.revoked, [url]);
  } finally {
    mocks.restore();
  }
});
