/** Serializable plugin configuration only. Native handles/PCM never enter a project. */
export interface Vst3Identity {
  path: string;
  classId: string;
  name: string;
  vendor: string;
  version: string;
}
export interface Vst3State {
  schema: 1;
  classId: string;
  component?: string;
  controller?: string;
  parameters: Array<{ id: number; value: number }>;
}
export interface Vst3Instrument extends Vst3Identity {
  state: Vst3State;
}
export interface Vst3Event {
  offset: number;
  type: 'on' | 'off';
  pitch: number;
  velocity?: number;
  noteId: number;
  channel?: number;
}
/** Narrow async desktop boundary. Never exposes ipcRenderer, paths to executables or raw host commands. */
export interface Vst3Bridge {
  paths(): Promise<string[]>;
  choosePath(): Promise<string[] | null>;
  discover(): Promise<{ plugins: Vst3Identity[]; errors: Array<{ path: string; error: string }> }>;
  inspect(plugin: Vst3Identity, state?: Vst3State): Promise<Vst3Instrument>;
  open(instrument: Vst3Instrument, sampleRate: number, mode: 'realtime' | 'offline'): Promise<{ id: string; latencySamples: number }>;
  process(id: string, frames: number, events: Vst3Event[], bpm: number): Promise<Float32Array>;
  close(id: string): Promise<void>;
}
export function getVst3Bridge(): Vst3Bridge | undefined {
  return (globalThis as unknown as { desktopApp?: { vst3?: Vst3Bridge } }).desktopApp?.vst3;
}
export function assertVst3Instrument(value: unknown): asserts value is Vst3Instrument {
  const plugin = value as Vst3Instrument | undefined;
  if (!plugin || typeof plugin.path !== 'string' || !/^[A-F0-9]{32}$/.test(plugin.classId ?? '') ||
    !plugin.state || plugin.state.schema !== 1 || plugin.state.classId !== plugin.classId ||
    !Array.isArray(plugin.state.parameters)) {
    throw new Error('VST3 identity/state is missing or invalid. Original project data is retained; relink the instrument or retry.');
  }
}
