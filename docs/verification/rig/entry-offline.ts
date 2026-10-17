// SCRATCH — verification rig entry (production audio engine).
import { audioEngine } from '../../../src/audio/audioEngine';
(window as unknown as Record<string, unknown>).audioEngine = audioEngine;
// NOTE: when this rig is run it is copied to <repo>/scratch-rig/, where the
// import above is '../src/...'. The deeper path here keeps the archived copy
// resolvable from docs/verification/rig/ so `tsc --noEmit` stays clean.
