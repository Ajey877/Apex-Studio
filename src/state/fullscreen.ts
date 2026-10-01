/**
 * Fullscreen toggle shared by the transport button and the application menu.
 *
 * Behaviour is preserved from the original transport-only implementation:
 * enter fullscreen, best-effort landscape orientation lock, exit fullscreen when
 * already active. Every failure path (unsupported API, rejected orientation lock,
 * user-agent denial) is swallowed so the shell never throws.
 */

export interface FullscreenHost {
  readonly fullscreenElement?: unknown;
  requestFullscreen?: () => Promise<void> | void;
  exitFullscreen?: () => Promise<void> | void;
}

export interface OrientationLockHost {
  orientation?: {
    lock?: (orientation: string) => Promise<void> | void;
  } | null;
}

export interface FullscreenController {
  isFullscreen(): boolean;
  /** Toggles fullscreen and resolves with the state that should now be shown. */
  toggle(): Promise<boolean>;
}

const readDocumentHost = (): FullscreenHost => {
  if (typeof document === 'undefined') return { fullscreenElement: null };
  return document as unknown as FullscreenHost;
};

const readScreenHost = (): OrientationLockHost => {
  if (typeof screen === 'undefined') return {};
  return screen as unknown as OrientationLockHost;
};

const requestLandscapeLock = async (host: OrientationLockHost): Promise<void> => {
  const lock = host.orientation?.lock;
  if (typeof lock !== 'function') return;
  try {
    await lock.call(host.orientation, 'landscape');
  } catch {
    // Orientation lock is optional and platform-dependent; fullscreen already succeeded.
  }
};

export const createFullscreenController = (
  resolveHost: () => FullscreenHost = readDocumentHost,
  resolveOrientationHost: () => OrientationLockHost = readScreenHost
): FullscreenController => {
  const isFullscreen = (): boolean => {
    try {
      return Boolean(resolveHost().fullscreenElement);
    } catch {
      return false;
    }
  };

  return {
    isFullscreen,
    async toggle(): Promise<boolean> {
      const host = resolveHost();
      try {
        if (!host.fullscreenElement) {
          await host.requestFullscreen?.();
          await requestLandscapeLock(resolveOrientationHost());
        } else {
          await host.exitFullscreen?.();
        }
      } catch (error) {
        console.log('Fullscreen error', error);
      }
      return isFullscreen();
    }
  };
};

export const fullscreenController = createFullscreenController();
