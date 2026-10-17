// SCRATCH — verification rig entry (live transport capture).
// Re-exports the UNMODIFIED production transport under test.
import { AudioClockTransport } from '../../../src/audio/transport';
(window as unknown as Record<string, unknown>).AudioClockTransport = AudioClockTransport;
// NOTE: when this rig is run it is copied to <repo>/scratch-rig/, where the
// import above is '../src/...'. The deeper path here keeps the archived copy
// resolvable from docs/verification/rig/ so `tsc --noEmit` stays clean.
