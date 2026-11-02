/**
 * Real-Chromium integration regression suite for P1 (live AudioContext output binding
 * across persisted startup, 48 kHz -> 96 kHz reconfiguration, output switching, and
 * hot-unplug fallback) and P2 (startup passive device monitoring while Audio Settings
 * is closed, zero startup getUserMedia prompt, no listener duplication across repeated
 * modal open/close cycles, and clean listener teardown).
 *
 * Note: Headless CI runners do not attach physical USB DACs, so AudioContext.prototype.setSinkId
 * and MediaDevices/Permissions are instrumented in-browser on top of genuine Chromium
 * AudioContext instances and the real mounted React <App /> tree.
 */
import { expect, test, type Page } from '@playwright/test';

const APP_URL = 'http://localhost:3000';

const waitForApp = async (page: Page): Promise<void> => {
  await page.waitForSelector('#root > *', { state: 'attached' });
  await page.waitForSelector('#application-menu-audio', { state: 'visible' });
  await page.waitForTimeout(1000);
};

const openAudioSettings = async (page: Page) => {
  await page.locator('#application-menu-audio').click();
  await expect(page.locator('#application-menu-audio-menu')).toBeVisible();
  await page.locator('#application-menu-command-audio\\.settings').click();
  const dialog = page.locator('#audio-settings-modal');
  await expect(dialog).toBeVisible();
  return dialog;
};

test('P1 & P2 in Chromium: startup passive monitoring runs while modal is closed without getUserMedia, repeated modal cycles do not duplicate listeners, and output switching/hot-unplug target the replacement 96 kHz AudioContext', async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on('pageerror', err => pageErrors.push(err.message));

  await page.addInitScript(() => {
    window.localStorage.setItem(
      'apex:audio-preferences',
      JSON.stringify({
        version: 1,
        outputDeviceId: 'dac-usb',
        inputDeviceId: '',
        sampleRate: 48000,
        latencyHint: 'interactive',
      }),
    );

    const makeDevice = (kind: MediaDeviceKind, deviceId: string, label: string) => ({
      deviceId,
      groupId: `grp-${deviceId}`,
      kind,
      label,
      toJSON: () => ({ deviceId, kind, label }),
    });

    const deviceChangeListeners = new Set<EventListenerOrEventListenerObject>();
    const permissionChangeListeners = new Set<EventListenerOrEventListenerObject>();
    let getUserMediaCalls = 0;

    let devices = [
      makeDevice('audiooutput', 'default', 'Default - Built-in Output'),
      makeDevice('audiooutput', 'dac-usb', 'Studio USB DAC'),
      makeDevice('audiooutput', 'monitors-spdif', 'S/PDIF Reference Monitors'),
      makeDevice('audioinput', 'default', 'Default - Built-in Mic'),
    ];

    if (typeof MediaDevices !== 'undefined' && MediaDevices.prototype) {
      MediaDevices.prototype.enumerateDevices = async () =>
        devices as unknown as MediaDeviceInfo[];
      MediaDevices.prototype.getUserMedia = async () => {
        getUserMediaCalls += 1;
        throw new Error('Unexpected getUserMedia call');
      };
      const origAdd = MediaDevices.prototype.addEventListener;
      const origRemove = MediaDevices.prototype.removeEventListener;
      MediaDevices.prototype.addEventListener = function (
        type: string,
        listener: EventListenerOrEventListenerObject | null,
        options?: boolean | AddEventListenerOptions,
      ) {
        if (type === 'devicechange' && listener) {
          deviceChangeListeners.add(listener);
        }
        return origAdd.call(this, type, listener, options);
      };
      MediaDevices.prototype.removeEventListener = function (
        type: string,
        listener: EventListenerOrEventListenerObject | null,
        options?: boolean | EventListenerOptions,
      ) {
        if (type === 'devicechange' && listener) {
          deviceChangeListeners.delete(listener);
        }
        return origRemove.call(this, type, listener, options);
      };
    }

    if (typeof Permissions !== 'undefined' && Permissions.prototype) {
      const origQuery = Permissions.prototype.query;
      Permissions.prototype.query = async function (desc: PermissionDescriptor) {
        if (desc && desc.name === 'microphone') {
          return {
            name: 'microphone',
            state: 'granted',
            onchange: null,
            addEventListener: (type: string, listener: EventListenerOrEventListenerObject | null) => {
              if (type === 'change' && listener) permissionChangeListeners.add(listener);
            },
            removeEventListener: (
              type: string,
              listener: EventListenerOrEventListenerObject | null,
            ) => {
              if (type === 'change' && listener) permissionChangeListeners.delete(listener);
            },
            dispatchEvent: () => true,
          } as unknown as PermissionStatus;
        }
        return origQuery.call(this, desc);
      };
    }

    // Instrument genuine Chromium AudioContext instances without subclassing Blink WebIDL wrappers.
    const NativeAudioContext = window.AudioContext;
    const sinkMap = new WeakMap<AudioContext, { sinkId: string; calls: string[] }>();
    const createdContexts: AudioContext[] = [];

    Object.defineProperty(NativeAudioContext.prototype, 'sinkId', {
      configurable: true,
      get(this: AudioContext) {
        return sinkMap.get(this)?.sinkId ?? '';
      },
    });

    Object.defineProperty(NativeAudioContext.prototype, 'setSinkId', {
      configurable: true,
      writable: true,
      value: async function setSinkId(this: AudioContext, sinkId: string): Promise<void> {
        if (this.state === 'closed') {
          throw new DOMException('Context is closed', 'InvalidStateError');
        }
        let entry = sinkMap.get(this);
        if (!entry) {
          entry = { sinkId: '', calls: [] };
          sinkMap.set(this, entry);
        }
        entry.calls.push(sinkId);
        entry.sinkId = sinkId;
      },
    });

    const WrappedAudioContext = new Proxy(NativeAudioContext, {
      construct(target, argArray) {
        const ctx = Reflect.construct(target, argArray, target) as AudioContext;
        if (!sinkMap.has(ctx)) {
          sinkMap.set(ctx, { sinkId: '', calls: [] });
        }
        createdContexts.push(ctx);
        return ctx;
      },
    });

    (window as unknown as { AudioContext: typeof AudioContext }).AudioContext = WrappedAudioContext;

    (window as unknown as Record<string, unknown>).__apexAudioTestHarness = {
      getStats: () => ({
        getUserMediaCalls,
        deviceChangeListenerCount: deviceChangeListeners.size,
        permissionChangeListenerCount: permissionChangeListeners.size,
        contextCount: createdContexts.length,
        contexts: createdContexts.map(ctx => ({
          sampleRate: ctx.sampleRate,
          state: ctx.state,
          sinkId: (ctx as unknown as { sinkId: string }).sinkId,
          sinkCalls: [...(sinkMap.get(ctx)?.calls ?? [])],
        })),
      }),
      setDevicesAndNotify: (
        next: Array<{ kind: MediaDeviceKind; deviceId: string; label: string }>,
      ) => {
        devices = next.map(d => makeDevice(d.kind, d.deviceId, d.label));
        const evt = new Event('devicechange');
        for (const listener of [...deviceChangeListeners]) {
          if (typeof listener === 'function') listener(evt);
          else listener.handleEvent(evt);
        }
      },
    };
  });

  await page.goto(APP_URL);
  await waitForApp(page);

  // P2 (1 & 2): Startup passive monitoring attached while Audio Settings is closed, with 0 getUserMedia calls.
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const h = (window as unknown as {
          __apexAudioTestHarness: {
            getStats: () => {
              deviceChangeListenerCount: number;
              permissionChangeListenerCount: number;
              getUserMediaCalls: number;
            };
          };
        }).__apexAudioTestHarness;
        return h.getStats();
      }),
    )
    .toMatchObject({
      getUserMediaCalls: 0,
      deviceChangeListenerCount: 1,
      permissionChangeListenerCount: 1,
    });

  // Plug in a new USB interface while Audio Settings modal is still closed.
  await page.evaluate(() => {
    const h = (window as unknown as {
      __apexAudioTestHarness: {
        setDevicesAndNotify: (d: Array<{ kind: MediaDeviceKind; deviceId: string; label: string }>) => void;
      };
    }).__apexAudioTestHarness;
    h.setDevicesAndNotify([
      { kind: 'audiooutput', deviceId: 'default', label: 'Default - Built-in Output' },
      { kind: 'audiooutput', deviceId: 'dac-usb', label: 'Studio USB DAC' },
      { kind: 'audiooutput', deviceId: 'monitors-spdif', label: 'S/PDIF Reference Monitors' },
      { kind: 'audiooutput', deviceId: 'usb-apollo', label: 'Apollo Twin USB Out' },
      { kind: 'audioinput', deviceId: 'default', label: 'Default - Built-in Mic' },
    ]);
  });

  await expect
    .poll(async () =>
      page.evaluate(async () => {
        // @ts-ignore — browser-side Vite module import
        const { audioDeviceManager } = await import('/src/audio/audioDeviceManager.ts');
        return audioDeviceManager.getSnapshot().outputDevices.map((d: { deviceId: string }) => d.deviceId);
      }),
    )
    .toContain('usb-apollo');

  // P2 (3): Repeatedly open and close Audio Settings 4 times without duplicating listeners.
  for (let i = 0; i < 4; i += 1) {
    const dialog = await openAudioSettings(page);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    const stats = await page.evaluate(() => {
      const h = (window as unknown as {
        __apexAudioTestHarness: {
          getStats: () => {
            deviceChangeListenerCount: number;
            permissionChangeListenerCount: number;
            getUserMediaCalls: number;
          };
        };
      }).__apexAudioTestHarness;
      return h.getStats();
    });
    expect(stats.deviceChangeListenerCount).toBe(1);
    expect(stats.permissionChangeListenerCount).toBe(1);
    expect(stats.getUserMediaCalls).toBe(0);
  }

  // P1 (1–7): Open Audio Settings, verify persisted 'dac-usb' @ 48 kHz bound to initial live context,
  // reconfigure to 96 kHz, switch output to 'monitors-spdif', then close modal and hot-unplug.
  const dialog = await openAudioSettings(page);

  await expect
    .poll(async () =>
      page.evaluate(async () => {
        // @ts-ignore — browser-side Vite module import
        const { audioDeviceManager } = await import('/src/audio/audioDeviceManager.ts');
        // @ts-ignore — browser-side Vite module import
        const { audioEngine } = await import('/src/audio/audioEngine.ts');
        const ctx = audioEngine.getContext();
        return {
          boundMatchesLive: Boolean(ctx && audioDeviceManager.getBoundAudioContext() === ctx),
          sampleRate: ctx?.sampleRate ?? null,
          sinkId: (ctx as unknown as { sinkId?: string } | null)?.sinkId ?? null,
        };
      }),
    )
    .toEqual({
      boundMatchesLive: true,
      sampleRate: 48000,
      sinkId: 'dac-usb',
    });

  // Reconfigure from 48,000 Hz to 96,000 Hz via the modal controls.
  await dialog.locator('#audio-sample-rate-select').selectOption('96000');
  const applyButton = dialog.getByRole('button', { name: 'Apply Engine Settings', exact: true });
  await expect(applyButton).toBeEnabled();
  await applyButton.click();
  await expect(dialog.getByTestId('audio-actual-sample-rate')).toContainText('96,000 Hz');

  // Switch output from 'dac-usb' to 'monitors-spdif' after reconfiguration.
  await dialog.locator('#audio-output-device-select').selectOption('monitors-spdif');

  await expect
    .poll(async () =>
      page.evaluate(async () => {
        // @ts-ignore — browser-side Vite module import
        const { audioDeviceManager } = await import('/src/audio/audioDeviceManager.ts');
        // @ts-ignore — browser-side Vite module import
        const { audioEngine } = await import('/src/audio/audioEngine.ts');
        const h = (window as unknown as {
          __apexAudioTestHarness: {
            getStats: () => {
              contexts: Array<{ sampleRate: number; state: string; sinkId: string; sinkCalls: string[] }>;
            };
          };
        }).__apexAudioTestHarness;
        const liveCtx = audioEngine.getContext();
        const contexts = h.getStats().contexts;
        const latest = contexts[contexts.length - 1] ?? null;
        return {
          boundMatchesReplacement: Boolean(liveCtx && audioDeviceManager.getBoundAudioContext() === liveCtx),
          activeDeviceId: audioDeviceManager.getActiveOutputDeviceId(),
          contextCountGreaterThanOne: contexts.length >= 2,
          allPriorClosed: contexts.slice(0, -1).every(c => c.state === 'closed'),
          latestSampleRate: latest?.sampleRate ?? null,
          latestSinkId: latest?.sinkId ?? null,
        };
      }),
    )
    .toEqual({
      boundMatchesReplacement: true,
      activeDeviceId: 'monitors-spdif',
      contextCountGreaterThanOne: true,
      allPriorClosed: true,
      latestSampleRate: 96000,
      latestSinkId: 'monitors-spdif',
    });

  // Close Audio Settings, then simulate unplugging 'monitors-spdif' and verify fallback hits replacement 96 kHz context.
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  await page.evaluate(() => {
    const h = (window as unknown as {
      __apexAudioTestHarness: {
        setDevicesAndNotify: (d: Array<{ kind: MediaDeviceKind; deviceId: string; label: string }>) => void;
      };
    }).__apexAudioTestHarness;
    h.setDevicesAndNotify([
      { kind: 'audiooutput', deviceId: 'default', label: 'Default - Built-in Output' },
      { kind: 'audiooutput', deviceId: 'dac-usb', label: 'Studio USB DAC' },
      { kind: 'audioinput', deviceId: 'default', label: 'Default - Built-in Mic' },
    ]);
  });

  await expect
    .poll(async () =>
      page.evaluate(async () => {
        // @ts-ignore — browser-side Vite module import
        const { audioDeviceManager } = await import('/src/audio/audioDeviceManager.ts');
        const h = (window as unknown as {
          __apexAudioTestHarness: {
            getStats: () => {
              contexts: Array<{ sampleRate: number; state: string; sinkId: string; sinkCalls: string[] }>;
            };
          };
        }).__apexAudioTestHarness;
        const contexts = h.getStats().contexts;
        const latest = contexts[contexts.length - 1] ?? null;
        return {
          activeDeviceId: audioDeviceManager.getActiveOutputDeviceId(),
          replacementSinkId: latest?.sinkId ?? null,
        };
      }),
    )
    .toEqual({
      activeDeviceId: '',
      replacementSinkId: '',
    });

  // P2 (4): Stopping monitoring on teardown removes listeners cleanly.
  const afterTeardown = await page.evaluate(async () => {
    // @ts-ignore — browser-side Vite module import
    const { audioEngine } = await import('/src/audio/audioEngine.ts');
    audioEngine.stopDeviceMonitoring();
    const h = (window as unknown as {
      __apexAudioTestHarness: {
        getStats: () => {
          deviceChangeListenerCount: number;
          permissionChangeListenerCount: number;
          getUserMediaCalls: number;
        };
      };
    }).__apexAudioTestHarness;
    return h.getStats();
  });

  expect(afterTeardown.deviceChangeListenerCount).toBe(0);
  expect(afterTeardown.permissionChangeListenerCount).toBe(0);
  expect(afterTeardown.getUserMediaCalls).toBe(0);
  expect(pageErrors).toEqual([]);
});
