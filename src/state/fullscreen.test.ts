import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createFullscreenController,
  type FullscreenHost,
  type OrientationLockHost,
} from './fullscreen';

const createHost = (initial: unknown = null) => {
  const calls: string[] = [];
  let element: unknown = initial;
  const host: FullscreenHost = {
    get fullscreenElement() {
      return element;
    },
    requestFullscreen: async () => {
      calls.push('requestFullscreen');
      element = { tag: 'documentElement' };
    },
    exitFullscreen: async () => {
      calls.push('exitFullscreen');
      element = null;
    },
  };
  return { host, calls, setElement: (next: unknown) => { element = next; } };
};

const createOrientationHost = (result: 'resolve' | 'reject' | 'throw') => {
  const calls: string[] = [];
  const host: OrientationLockHost = {
    orientation: {
      lock: async () => {
        calls.push('lock');
        if (result === 'reject') throw new Error('orientation lock rejected');
      },
    },
  };
  if (result === 'throw') {
    host.orientation = {
      lock: () => {
        calls.push('lock');
        throw new Error('orientation lock threw synchronously');
      },
    };
  }
  return { host, calls };
};

test('reports the current fullscreen state from the host', () => {
  const { host, setElement } = createHost();
  const controller = createFullscreenController(() => host);
  assert.equal(controller.isFullscreen(), false);
  setElement({ tag: 'documentElement' });
  assert.equal(controller.isFullscreen(), true);
});

test('entering fullscreen requests it and locks landscape orientation', async () => {
  const { host, calls } = createHost();
  const orientation = createOrientationHost('resolve');
  const controller = createFullscreenController(() => host, () => orientation.host);

  const result = await controller.toggle();

  assert.equal(result, true);
  assert.deepEqual(calls, ['requestFullscreen']);
  assert.deepEqual(orientation.calls, ['lock']);
  assert.equal(controller.isFullscreen(), true);
});

test('leaving fullscreen exits and does not touch orientation lock', async () => {
  const { host, calls } = createHost({ tag: 'documentElement' });
  const orientation = createOrientationHost('resolve');
  const controller = createFullscreenController(() => host, () => orientation.host);

  const result = await controller.toggle();

  assert.equal(result, false);
  assert.deepEqual(calls, ['exitFullscreen']);
  assert.deepEqual(orientation.calls, []);
});

test('a rejected or throwing orientation lock never breaks the fullscreen toggle', async () => {
  for (const mode of ['reject', 'throw'] as const) {
    const { host } = createHost();
    const orientation = createOrientationHost(mode);
    const controller = createFullscreenController(() => host, () => orientation.host);

    const result = await controller.toggle();

    assert.equal(result, true, `orientation lock mode ${mode} must still enter fullscreen`);
    assert.deepEqual(orientation.calls, ['lock']);
  }
});

test('a host without the fullscreen API degrades to a no-op instead of throwing', async () => {
  const controller = createFullscreenController(() => ({ fullscreenElement: null }), () => ({}));

  await assert.doesNotReject(async () => controller.toggle());
  assert.equal(controller.isFullscreen(), false);
});

test('a failing fullscreen request is swallowed and reported as not fullscreen', async () => {
  const controller = createFullscreenController(
    () => ({
      fullscreenElement: null,
      requestFullscreen: async () => {
        throw new Error('denied by user agent');
      },
    }),
    () => ({})
  );

  await assert.doesNotReject(async () => controller.toggle());
  assert.equal(controller.isFullscreen(), false);
});

test('default host tolerates an absent document (server-side rendering safety)', () => {
  const controller = createFullscreenController(() => ({ fullscreenElement: null }), () => ({}));
  assert.equal(controller.isFullscreen(), false);
});
