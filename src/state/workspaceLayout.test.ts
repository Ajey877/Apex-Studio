import assert from 'node:assert/strict';
import test from 'node:test';
import {
  WORKSPACE_LAYOUT_LIMITS,
  WORKSPACE_LAYOUT_KEYS,
  clamp,
  normalizeBrowserWidth,
  normalizeInspectorWidth,
  normalizeDensity,
  readWorkspaceLayoutPreference,
  writeWorkspaceLayoutPreference,
  loadBrowserWidth,
  loadInspectorWidth,
  loadDensity,
} from './workspaceLayout';

// Helpers to mock window.localStorage
type MockStorage = {
  getItem: (k: string) => string | null;
  setItem: (k: string, v: string) => void;
  store: Map<string, string>;
  shouldThrowOnGet?: boolean;
  shouldThrowOnSet?: boolean;
};

const createMockStorage = (initial: Record<string, string> = {}): MockStorage => {
  const store = new Map(Object.entries(initial));
  return {
    store,
    getItem: (k: string) => {
      // @ts-ignore mock throw
      if ((createMockStorage as any)._throwGet) throw new Error('getItem failed');
      return store.has(k) ? store.get(k)! : null;
    },
    setItem: (k: string, v: string) => {
      if ((createMockStorage as any)._throwSet) throw new Error('setItem failed');
      store.set(k, v);
    },
  } as MockStorage;
};

const withWindow = (win: any, fn: () => void) => {
  const prev = (globalThis as any).window;
  (globalThis as any).window = win;
  try {
    fn();
  } finally {
    if (prev === undefined) delete (globalThis as any).window;
    else (globalThis as any).window = prev;
  }
};

test('limits are as specd', () => {
  assert.deepEqual(WORKSPACE_LAYOUT_LIMITS.browser, { min: 140, max: 320, default: 156, collapsed: 40 });
  assert.deepEqual(WORKSPACE_LAYOUT_LIMITS.inspector, { min: 240, max: 360, default: 260, collapsed: 40 });
  assert.equal(WORKSPACE_LAYOUT_KEYS.browserWidth, 'apex:browserWidth');
  assert.equal(WORKSPACE_LAYOUT_KEYS.inspectorWidth, 'apex:inspectorWidth');
  assert.equal(WORKSPACE_LAYOUT_KEYS.density, 'apex:density');
});

test('clamp', () => {
  assert.equal(clamp(10, 0, 5), 5);
  assert.equal(clamp(-1, 0, 5), 0);
  assert.equal(clamp(3, 0, 5), 3);
});

test('normalizeBrowserWidth - valid numbers and strings', () => {
  assert.equal(normalizeBrowserWidth(156), 156);
  assert.equal(normalizeBrowserWidth('156'), 156);
  assert.equal(normalizeBrowserWidth(155.6), 156); // rounds
  assert.equal(normalizeBrowserWidth('155.6'), 156);
});

test('normalizeBrowserWidth - invalid values fallback to default', () => {
  const def = WORKSPACE_LAYOUT_LIMITS.browser.default;
  assert.equal(normalizeBrowserWidth(undefined), def);
  assert.equal(normalizeBrowserWidth(null), def);
  assert.equal(normalizeBrowserWidth({} as any), def);
  // '' => Number('') === 0 => clamp to min, not default (spec: malformed string falls back, but empty string is numeric 0)
  assert.equal(normalizeBrowserWidth(''), 140);
  assert.equal(normalizeBrowserWidth('not-a-number'), def);
  assert.equal(normalizeBrowserWidth(NaN), def);
  assert.equal(normalizeBrowserWidth(Infinity), def);
  assert.equal(normalizeBrowserWidth(-Infinity), def);
});

test('normalizeBrowserWidth - clamps to min/max', () => {
  assert.equal(normalizeBrowserWidth(0), 140);
  assert.equal(normalizeBrowserWidth(139), 140);
  assert.equal(normalizeBrowserWidth(140), 140);
  assert.equal(normalizeBrowserWidth(320), 320);
  assert.equal(normalizeBrowserWidth(321), 320);
  assert.equal(normalizeBrowserWidth(1000), 320);
  assert.equal(normalizeBrowserWidth('1000'), 320);
});

test('normalizeInspectorWidth - valid and clamp', () => {
  const def = WORKSPACE_LAYOUT_LIMITS.inspector.default;
  assert.equal(normalizeInspectorWidth(260), 260);
  assert.equal(normalizeInspectorWidth('260'), 260);
  assert.equal(normalizeInspectorWidth(undefined), def);
  assert.equal(normalizeInspectorWidth(''), 240); // '' -> 0 -> clamp to min
  assert.equal(normalizeInspectorWidth(0), 240);
  assert.equal(normalizeInspectorWidth(239), 240);
  assert.equal(normalizeInspectorWidth(360), 360);
  assert.equal(normalizeInspectorWidth(500), 360);
});

test('normalizeDensity', () => {
  assert.equal(normalizeDensity('compact'), 'compact');
  assert.equal(normalizeDensity('comfy'), 'comfy');
  assert.equal(normalizeDensity('COMPACT'), 'compact');
  assert.equal(normalizeDensity(' COMFY '), 'comfy');
  assert.equal(normalizeDensity(' ComPact '), 'compact');
  assert.equal(normalizeDensity(''), 'comfy');
  assert.equal(normalizeDensity(null), 'comfy');
  assert.equal(normalizeDensity(undefined), 'comfy');
  assert.equal(normalizeDensity(123 as any), 'comfy');
  assert.equal(normalizeDensity('invalid'), 'comfy');
});

test('readWorkspaceLayoutPreference - missing window returns fallback', () => {
  const prev = (globalThis as any).window;
  try {
    delete (globalThis as any).window;
    const fallback = 42;
    const result = readWorkspaceLayoutPreference('k', () => 999, fallback);
    assert.equal(result, fallback);
  } finally {
    if (prev !== undefined) (globalThis as any).window = prev;
  }
});

test('readWorkspaceLayoutPreference - missing localStorage returns fallback', () => {
  withWindow({}, () => {
    const result = readWorkspaceLayoutPreference('k', raw => Number(raw), 7);
    assert.equal(result, 7);
  });
  withWindow({ localStorage: null }, () => {
    const result = readWorkspaceLayoutPreference('k', raw => Number(raw), 7);
    assert.equal(result, 7);
  });
});

test('readWorkspaceLayoutPreference - null raw returns fallback', () => {
  const storage = createMockStorage({});
  withWindow({ localStorage: storage }, () => {
    const result = readWorkspaceLayoutPreference('apex:browserWidth', raw => Number(raw), 99);
    assert.equal(result, 99);
  });
});

test('readWorkspaceLayoutPreference - uses parse on stored value', () => {
  const storage = createMockStorage({ 'apex:density': 'compact' });
  withWindow({ localStorage: storage }, () => {
    const result = readWorkspaceLayoutPreference('apex:density', v => normalizeDensity(v), 'comfy');
    assert.equal(result, 'compact');
  });
});

test('readWorkspaceLayoutPreference - malformed value via parse still returns parse result (which normalizes to fallback)', () => {
  const storage = createMockStorage({ 'apex:browserWidth': 'not-a-number' });
  withWindow({ localStorage: storage }, () => {
    const result = readWorkspaceLayoutPreference('apex:browserWidth', v => normalizeBrowserWidth(v), 156);
    // normalizeBrowserWidth('not-a-number') => default 156, not the read fallback 156 (same here)
    assert.equal(result, 156);
  });
  const storage2 = createMockStorage({ 'apex:density': 'weird' });
  withWindow({ localStorage: storage2 }, () => {
    const result = readWorkspaceLayoutPreference('apex:density', v => normalizeDensity(v), 'comfy');
    assert.equal(result, 'comfy');
  });
});

test('readWorkspaceLayoutPreference - storage access throws returns fallback', () => {
  const throwingStorage = {
    getItem: () => { throw new Error('blocked'); },
    setItem: () => {},
  };
  withWindow({ localStorage: throwingStorage }, () => {
    const result = readWorkspaceLayoutPreference('k', () => 123, 456);
    assert.equal(result, 456);
  });
});

test('readWorkspaceLayoutPreference - parse throws returns fallback', () => {
  const storage = createMockStorage({ k: 'value' });
  withWindow({ localStorage: storage }, () => {
    const result = readWorkspaceLayoutPreference('k', () => { throw new Error('parse boom'); }, 999);
    assert.equal(result, 999);
  });
});

test('writeWorkspaceLayoutPreference - missing window does not throw', () => {
  const prev = (globalThis as any).window;
  try {
    delete (globalThis as any).window;
    assert.doesNotThrow(() => writeWorkspaceLayoutPreference('k', 'v'));
  } finally {
    if (prev !== undefined) (globalThis as any).window = prev;
  }
});

test('writeWorkspaceLayoutPreference - missing localStorage does not throw', () => {
  withWindow({}, () => {
    assert.doesNotThrow(() => writeWorkspaceLayoutPreference('k', 'v'));
  });
  withWindow({ localStorage: null }, () => {
    assert.doesNotThrow(() => writeWorkspaceLayoutPreference('k', 'v'));
  });
});

test('writeWorkspaceLayoutPreference - setItem throws does not propagate', () => {
  const throwing = {
    getItem: () => null,
    setItem: () => { throw new Error('blocked'); },
  };
  withWindow({ localStorage: throwing }, () => {
    assert.doesNotThrow(() => writeWorkspaceLayoutPreference('k', 'v'));
  });
});

test('writeWorkspaceLayoutPreference - writes correctly', () => {
  const storage = createMockStorage({});
  withWindow({ localStorage: storage }, () => {
    writeWorkspaceLayoutPreference('apex:density', 'compact');
    assert.equal(storage.store.get('apex:density'), 'compact');
  });
});

test('loadBrowserWidth / loadInspectorWidth / loadDensity - fallbacks when missing', () => {
  const storage = createMockStorage({});
  withWindow({ localStorage: storage }, () => {
    assert.equal(loadBrowserWidth(), WORKSPACE_LAYOUT_LIMITS.browser.default);
    assert.equal(loadInspectorWidth(), WORKSPACE_LAYOUT_LIMITS.inspector.default);
    assert.equal(loadDensity(), 'comfy');
  });
});

test('loadBrowserWidth - clamps and normalizes stored string', () => {
  const storage = createMockStorage({ 'apex:browserWidth': '500' });
  withWindow({ localStorage: storage }, () => {
    assert.equal(loadBrowserWidth(), 320);
  });
  const storage2 = createMockStorage({ 'apex:browserWidth': '100' });
  withWindow({ localStorage: storage2 }, () => {
    assert.equal(loadBrowserWidth(), 140);
  });
  const storage3 = createMockStorage({ 'apex:browserWidth': 'not-a-number' });
  withWindow({ localStorage: storage3 }, () => {
    assert.equal(loadBrowserWidth(), 156);
  });
});

test('loadInspectorWidth - handles malformed and missing', () => {
  const storage = createMockStorage({ 'apex:inspectorWidth': 'not-a-number' });
  withWindow({ localStorage: storage }, () => {
    assert.equal(loadInspectorWidth(), 260);
  });
});

test('loadDensity - case insensitive and malformed', () => {
  const storage = createMockStorage({ 'apex:density': 'COMPACT' });
  withWindow({ localStorage: storage }, () => {
    assert.equal(loadDensity(), 'compact');
  });
  const storage2 = createMockStorage({ 'apex:density': 'weird' });
  withWindow({ localStorage: storage2 }, () => {
    assert.equal(loadDensity(), 'comfy');
  });
  const storage3 = createMockStorage({});
  withWindow({ localStorage: storage3 }, () => {
    assert.equal(loadDensity(), 'comfy');
  });
});

test('load* - storage throws returns defaults without crashing', () => {
  const throwing = {
    getItem: () => { throw new Error('blocked'); },
    setItem: () => { throw new Error('blocked'); },
  };
  withWindow({ localStorage: throwing }, () => {
    assert.doesNotThrow(() => {
      assert.equal(loadBrowserWidth(), WORKSPACE_LAYOUT_LIMITS.browser.default);
      assert.equal(loadInspectorWidth(), WORKSPACE_LAYOUT_LIMITS.inspector.default);
      assert.equal(loadDensity(), 'comfy');
    });
  });
});
