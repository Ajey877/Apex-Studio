// SCRATCH — verification rig entry (live transport capture).
// Re-exports the UNMODIFIED production transport under test.
import { AudioClockTransport } from '../src/audio/transport';
(window as unknown as Record<string, unknown>).AudioClockTransport = AudioClockTransport;
