// SCRATCH — verification rig entry (production audio engine).
import { audioEngine } from '../src/audio/audioEngine';
(window as unknown as Record<string, unknown>).audioEngine = audioEngine;
