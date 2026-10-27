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
  /** New UI loads/relinks get a fresh binding; manual parameter edits preserve it. */
  automationId?: string;
}
/** Configuration for a genuine VST3 audio-effect instance. */
export interface Vst3Effect extends Vst3Identity {
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
export interface Vst3Parameter {
  id: number; name: string; shortTitle: string; units: string;
  defaultValue: number; currentValue: number | null; flags: number; stepCount: number;
  choices?: Array<{ value: number; label: string }>;
}
export interface Vst3ParameterMetadata { parameters: Vst3Parameter[]; controllerAvailable: boolean }
export type Vst3ParameterPoint = { id: number; value: number; offset?: number };
export type Vst3ParameterChange = { id: number; value: number };
export type Vst3ParameterEditorCommit = (channel: import('../types/daw').Channel, changes: Vst3ParameterChange[], signal: AbortSignal) => Promise<void>;
/** Narrow async desktop boundary. Never exposes ipcRenderer, paths to executables or raw host commands. */
export interface Vst3Bridge {
  paths(): Promise<string[]>;
  choosePath(): Promise<string[] | null>;
  discover(): Promise<{ plugins: Vst3Identity[]; errors: Array<{ path: string; error: string }> }>;
  discoverEffects(): Promise<{ plugins: Vst3Identity[]; errors: Array<{ path: string; error: string }> }>;
  inspect(plugin: Vst3Identity, state?: Vst3State): Promise<Vst3Instrument>;
  inspectEffect(plugin: Vst3Identity, state?: Vst3State): Promise<Vst3Effect>;
  describeEffect(plugin: Vst3Effect): Promise<Vst3ParameterMetadata>;
  describe(instrument: Vst3Instrument): Promise<Vst3ParameterMetadata>;
  parameters(id: string, changes: Vst3ParameterChange[]): Promise<Vst3Parameter[]>;
  open(instrument: Vst3Instrument | Vst3Effect, sampleRate: number, mode: 'realtime' | 'offline', kind?: 'instrument' | 'effect'): Promise<{ id: string; latencySamples: number; parameters?: Vst3Parameter[] }>;
  process(id: string, frames: number, events: Vst3Event[], bpm: number, parameters?: Vst3ParameterPoint[]): Promise<Float32Array>;
  processAudio(id: string, frames: number, audio: Float32Array, bpm: number, parameters?: Vst3ParameterPoint[]): Promise<Float32Array>;
  close(id: string): Promise<void>;
}
export function getVst3Bridge(): Vst3Bridge | undefined {
  return (globalThis as unknown as { desktopApp?: { vst3?: Vst3Bridge } }).desktopApp?.vst3;
}
export function assertVst3Instrument(value: unknown): asserts value is Vst3Instrument {
  const plugin = value as Vst3Instrument | undefined;
  if (!plugin || typeof plugin.path !== 'string' || !/^[A-F0-9]{32}$/.test(plugin.classId ?? '') ||
    !plugin.state || plugin.state.schema !== 1 || plugin.state.classId !== plugin.classId ||
    (plugin.state.parameters !== undefined && !Array.isArray(plugin.state.parameters))) {
    throw new Error('VST3 identity/state is missing or invalid. Original project data is retained; relink the instrument or retry.');
  }
}

export function assertVst3Effect(value: unknown): asserts value is Vst3Effect {
  const plugin = value as Vst3Effect | undefined;
  if (!plugin || typeof plugin.path !== 'string' || !/^[A-F0-9]{32}$/.test(plugin.classId ?? '') ||
    !plugin.state || plugin.state.schema !== 1 || plugin.state.classId !== plugin.classId ||
    !Array.isArray(plugin.state.parameters) || plugin.state.parameters.length > 4096 ||
    plugin.state.parameters.some(parameter => !Number.isInteger(parameter.id) || parameter.id < 0 ||
      parameter.id > 0xffffffff || !Number.isFinite(parameter.value) || parameter.value < 0 || parameter.value > 1) ||
    [plugin.state.component, plugin.state.controller].some(state => state !== undefined &&
      (typeof state !== 'string' || state.length > 2 * 1024 * 1024 || !/^(?:[A-Fa-f0-9]{2})*$/.test(state)))) {
    throw new Error('VST3 effect identity/state is missing or invalid. Original project data is retained; relink the effect or retry.');
  }
}
