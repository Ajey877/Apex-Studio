/**
 * Real-Chromium integration regression suite for P1 (live AudioContext output binding
 * across persisted startup, 48 kHz -> 96 kHz reconfiguration, output switching, and
 * hot-unplug fallback) and P2 (startup passive device monitoring while Audio Settings
 * is closed, zero startup getUserMedia prompt, no listener duplication across repeated
 * modal open/close cycles, and clean listener teardown).
 *
 * Note: Headless CI runners do not attach physical USB DACs, so AudioContext.setSinkId
 * and navigator.mediaDevices.enumerateDevices are instrumented in-browser on top of the
 * real Chromium AudioContext and real mounted React <App /> tree.
 */
import { expect, test, type Page } from '@playwright/test';

const APP_URL = 'http://localhost:3000';

const waitForApp = async (page: Page): Promise<void> => {
  await page.waitForSelector('#root > *', { state: 'attached' });
  await page.waitForSelector('#application-menu-audio', { state: 'visible' });
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
    // Seed persisted non-default output device ('dac-usb') and 48,000 Hz sample rate before App mounts.
    window.localStorage.setItem(
      'apex:audio-preferences',
      JSON.stringify({
        version: 1,
        preferredOutputDeviceId: 'dac-usb',
        preferredInputDeviceId: '',
        requestedSampleRate: 48000,
        latencyPreference: 'interactive',
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

    const fakeMediaDevices = {
      enumerateDevices: async () => devices,
      getUserMedia: async () => {
        getUserMediaCalls += 1;
        throw new Error('Unexpected getUserMedia call');
      },
      addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
        if (type === 'devicechange') deviceChangeListeners.add(listener);
      },
      removeEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
        if (type === 'devicechange') deviceChangeListeners.delete(listener);
      },
    };

    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      get: () => fakeMediaDevices,
    });

    Object.defineProperty(navigator, 'permissions', {
      configurable: true,
      value: {
        query: async () => ({
          state: 'granted',
          addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
            if (type === 'change') permissionChangeListeners.add(listener);
          },
          removeEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
            if (type === 'change') permissionChangeListeners.delete(listener);
          },
        }),
      },
    });

    // Instrument real Chromium AudioContext so setSinkId / sinkId are tracked per live instance.
    const NativeAudioContext = window.AudioContext;
    const sinkMap = new WeakMap<AudioContext, { sinkId: string; calls: string[] }>();
    const createdContexts: AudioContext[] = [];

    class TrackedBrowserAudioContext extends NativeAudioContext {
      constructor(options?: AudioContextOptions) {
        super(options);
        sinkMap.set(this, { sinkId: '', calls: [] });
        createdContexts.push(this);
      }

      get sinkId(): string {
        return sinkMap.get(this)?.sinkId ?? '';
      }

      async setSinkId(sinkId: string): Promise<void> {
        if (this.state === 'closed') {
          throw new DOMException('Context is closed', 'InvalidStateError');
        }
        const entry = sinkMap.get(this);
        if (entry) {
          entry.calls.push(sinkId);
          entry.sinkId = sinkId;
        }
      }
    }

    (window as unknown as { AudioContext: typeof AudioContext }).AudioContext =
      TrackedBrowserAudioContext as unknown as typeof AudioContext;

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
        const h = (window as unknown as { __apexAudioTestHarness: { getStats: () => { deviceChangeListenerCount: number; getUserMediaCalls: number } } }).__apexAudioTestHarness;
        return h.getStats();
      }),
    )
    .toMatchObject({
      getUserMediaCalls: 0,
      deviceChangeListenerCount: 1,
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

  const observedWhileClosed = await page.evaluate(async () => {
    // @ts-ignore — browser-side Vite module import
    const { audioDeviceManager } = await import('/src/audio/audioDeviceManager.ts');
    return audioDeviceManager.getSnapshot().outputDevices.map((d: { deviceId: string }) => d.deviceId);
  });
  expect(observedWhileClosed).toContain('usb-apollo');

  // P2 (3): Repeatedly open and close Audio Settings 4 times without duplicating listeners.
  for (let i = 0; i < 4; i += 1) {
    const dialog = await openAudioSettings(page);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    const stats = await page.evaluate(() => {
      const h = (window as unknown as { __apexAudioTestHarness: { getStats: () => { deviceChangeListenerCount: number; permissionChangeListenerCount: number; getUserMediaCalls: number } } }).__apexAudioTestHarness;
      return h.getStats();
    });
    expect(stats.deviceChangeListenerCount).toBe(1);
    expect(stats.permissionChangeListenerCount).toBe(1);
    expect(stats.getUserMediaCalls).toBe(0);
  }

  // P1 (1–7): Open Audio Settings, initialize engine with persisted 'dac-usb' @ 48 kHz,
  // reconfigure to 96 kHz, switch output to 'monitors-spdif', then close modal and hot-unplug.
  const dialog = await openAudioSettings(page);
  const initButton = dialog.getByRole('button', { name: 'Initialize Engine', exact: true });
  const resumeButton = dialog.getByRole('button', { name: 'Resume Engine', exact: true });
  if (await initButton.isVisible()) {
    await initButton.click();
  } else if (await resumeButton.isVisible()) {
    await resumeButton.click();
  }

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
  await dialog.getByRole('button', { name: 'Apply Engine Settings' }).click();
  await expect(dialog.getByTestId('audio-actual-sample-rate')).toContainText('96,000 Hz');

  // Switch output from 'dac-usb' to 'monitors-spdif' after reconfiguration.
  await dialog.locator('#audio-output-device-select').selectOption('monitors-spdif');

  const afterSwitch = await page.evaluate(async () => {
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
    return {
      boundMatchesReplacement: Boolean(liveCtx && audioDeviceManager.getBoundAudioContext() === liveCtx),
      activeDeviceId: audioDeviceManager.getActiveOutputDeviceId(),
      contexts: h.getStats().contexts,
    };
  });

  expect(afterSwitch.boundMatchesReplacement).toBe(true);
  expect(afterSwitch.activeDeviceId).toBe('monitors-spdif');
  expect(afterSwitch.contexts).toHaveLength(2);
  expect(afterSwitch.contexts[0].state).toBe('closed');
  expect(afterSwitch.contexts[1].sampleRate).toBe(96000);
  expect(afterSwitch.contexts[1].sinkId).toBe('monitors-spdif');

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
        return {
          activeDeviceId: audioDeviceManager.getActiveOutputDeviceId(),
          replacementSinkId: h.getStats().contexts[1]?.sinkId ?? null,
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
