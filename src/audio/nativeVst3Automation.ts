import type { AutomationPoint, Channel, PlaylistClip } from '../types/daw';
import type { Vst3Parameter, Vst3ParameterPoint } from './nativeVst3Types';

import { interpolateSortedCurve } from './automation/curve';
export { interpolateCurve } from './automation/curve';

export const NATIVE_AUTOMATION_GRID = 128;
type Target = NonNullable<PlaylistClip['automationTarget']>;
export function nativeTarget(channel: Channel, parameter: Vst3Parameter): Target {
  if (!channel.vst3 || !isAutomatable(parameter)) throw new Error('VST3 parameter is not automatable');
  return { type: 'vst3_param', targetId: channel.id, label: `${channel.name} · ${parameter.name} · ID ${parameter.id}`,
    native: { path: channel.vst3.path, classId: channel.vst3.classId, automationId: channel.vst3.automationId ?? null, parameterId: parameter.id } };
}
export function nativeTargetMatches(target: Target, channel: Channel): boolean {
  const n = target.native, p = channel.vst3;
  return target.type === 'vst3_param' && target.targetId === channel.id && channel.instrumentType === 'vst3' && !!n && !!p &&
    n.path === p.path && n.classId === p.classId && n.automationId === (p.automationId ?? null) &&
    Number.isInteger(n.parameterId) && n.parameterId >= 0 && n.parameterId <= 0xffffffff;
}
export function isAutomatable(p: Vst3Parameter) {
  return !!(p.flags & 1) && !(p.flags & (2 | 16 | 32768)) && p.currentValue !== null && (!(p.flags & 8) || !!p.choices?.length);
}
export function validateNativeCurve(clip: PlaylistClip) {
  const points = clip.automationPoints;
  if (!Number.isFinite(clip.startBar) || clip.startBar < 0 || !Number.isFinite(clip.lengthBars) || clip.lengthBars <= 0 ||
      !points || points.length < 2 || points.length > 4096 || points.some((p, i) =>
        !Number.isFinite(p.x) || p.x < 0 || p.x > 1 || !Number.isFinite(p.y) || p.y < 0 || p.y > 1 ||
        (p.tension !== undefined && (!Number.isFinite(p.tension) || Math.abs(p.tension) > 1)) || (i > 0 && p.x <= points[i - 1].x))) {
    throw new Error('Invalid VST3 automation curve');
  }
}

type PreparedClip = { start: number; end: number; length: number; points: readonly AutomationPoint[] };
type ParameterPlan = {
  boundaries: number[];
  at: Array<PreparedClip | undefined>;
  after: Array<PreparedClip | undefined>;
  uniformValue?: number;
};
type BindingPlan = { parameters: Map<number, ParameterPlan>; boundaries: number[] };
type Clock = { time: number; position: number };
/** Optional deterministic diagnostics for tests/benchmarks, never project data. */
export interface NativeAutomationWork {
  clockRecords: number; clockSegments: number; boundaryVisits: number; boundaryComparisons: number;
  offsetSorts: number; candidateOffsets: number; evaluations: number;
  winnerComparisons: number; curveComparisons: number; outputPoints: number;
}
function bindingKey(targetId: string | number, native: NonNullable<Target['native']>): string {
  return JSON.stringify([targetId, native.path, native.classId, native.automationId]);
}
function channelKey(channel: Channel): string | undefined {
  if (channel.instrumentType !== 'vst3' || !channel.vst3) return undefined;
  return bindingKey(channel.id, { ...channel.vst3, automationId: channel.vst3.automationId ?? null, parameterId: 0 });
}
function lowerBound(values: readonly number[], value: number) {
  let lo = 0, hi = values.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (values[mid] < value) lo = mid + 1; else hi = mid; }
  return lo;
}
function uniqueSorted(values: number[]) { return [...new Set(values)].sort((a, b) => a - b); }
function prepareParameter(clips: PreparedClip[]): ParameterPlan {
  const boundaries = uniqueSorted(clips.flatMap(c => [c.start, c.end]));
  const winner = (bar: number, after: boolean) => {
    let selected: PreparedClip | undefined, latest = -Infinity;
    for (const c of clips) {
      if (bar < c.start) continue;
      const event = after && bar < c.end ? Infinity : Math.min(bar, c.end);
      if (event >= latest) { selected = c; latest = event; }
    }
    return selected;
  };
  // Compile overlap precedence and endpoint latching ONCE, including the
  // exact-endpoint tie which can differ from the immediately following span.
  const uniform = clips[0].points[0].y;
  const uniformValue = !Object.is(uniform, -0) && clips.every(c => c.points.every(p => p.y === uniform)) ? uniform : undefined;
  return { boundaries, uniformValue, at: boundaries.map(b => winner(b, false)), after: boundaries.map(b => winner(b, true)) };
}
function winningClip(plan: ParameterPlan, bar: number, work?: NativeAutomationWork) {
  let lo = 0, hi = plan.boundaries.length;
  while (lo < hi) {
    if (work) work.winnerComparisons++;
    const mid = (lo + hi) >>> 1;
    if (plan.boundaries[mid] < bar) lo = mid + 1; else hi = mid;
  }
  return lo < plan.boundaries.length && plan.boundaries[lo] === bar ? plan.at[lo] : plan.after[lo - 1];
}

/** Prepared per binding/parameter, bounded per block. No point copies/sorts or
 * lane scans in interpolation. Clock history is bounded and queried once per
 * block; only its latest applicable mapping and in-block discontinuities are
 * expanded. Runtime queues, plans and diagnostics are never persisted.
 */
export class NativeAutomationTimeline {
  private sources: PlaylistClip[] = [];
  private bindings = new Map<string, BindingPlan>();
  private secondsPerBar = 2;
  private clocks: Clock[] = [];
  set(clips: PlaylistClip[], secondsPerBar: number) {
    const native = clips.filter(c => c.type === 'automation' && c.automationTarget?.type === 'vst3_param' && !c.mute);
    if (native.length > 128 || native.reduce((sum, c) => sum + (c.automationPoints?.length ?? 0), 0) > 4096 || !Number.isFinite(secondsPerBar) || secondsPerBar <= 0) throw new Error('Invalid VST3 automation timeline');
    // Engine project snapshots are immutable. Its step callback supplies fresh
    // filtered arrays of the same clips; do not recompile an unchanged take.
    if (secondsPerBar === this.secondsPerBar && native.length === this.sources.length && native.every((c, i) => c === this.sources[i])) return;
    const grouped = new Map<string, { parameters: Map<number, PreparedClip[]>; boundaries: number[] }>();
    for (const clip of native) {
      validateNativeCurve(clip);
      const n = clip.automationTarget!.native;
      // Malformed/stale identities must never alias a genuine binding.
      if (!n || typeof n.path !== 'string' || typeof n.classId !== 'string' ||
          (n.automationId !== null && typeof n.automationId !== 'string') ||
          !Number.isInteger(n.parameterId) || n.parameterId < 0 || n.parameterId > 0xffffffff) continue;
      const end = clip.startBar + clip.lengthBars;
      if (!Number.isFinite(end * secondsPerBar)) throw new Error('Invalid VST3 automation timeline');
      const points = clip.automationPoints!.map(p => ({ x: p.x, y: p.y, tension: p.tension }));
      const key = bindingKey(clip.automationTarget!.targetId, n);
      let group = grouped.get(key);
      if (!group) { group = { parameters: new Map(), boundaries: [] }; grouped.set(key, group); }
      let list = group.parameters.get(n.parameterId);
      if (!list) { list = []; group.parameters.set(n.parameterId, list); }
      list.push({ start: clip.startBar, end, length: clip.lengthBars, points });
      for (const x of [0, 1, ...points.map(p => p.x)]) group.boundaries.push((clip.startBar + clip.lengthBars * x) * secondsPerBar);
    }
    const prepared = new Map<string, BindingPlan>();
    for (const [key, group] of grouped) prepared.set(key, {
      parameters: new Map([...group.parameters].map(([id, list]) => [id, prepareParameter(list)])),
      boundaries: uniqueSorted(group.boundaries),
    });
    // Atomic replacement: a failed update leaves the preceding valid plan intact.
    this.bindings = prepared; this.sources = native; this.secondsPerBar = secondsPerBar;
  }
  clock(time: number, position: number) {
    if (!Number.isFinite(time) || !Number.isFinite(position) || time < 0 || position < 0) throw new Error('Invalid VST3 automation clock');
    const last = this.clocks.at(-1);
    if (last && time < last.time - 1e-7) throw new Error('Unordered VST3 automation clock');
    if (last && Math.abs((last.time - last.position) - (time - position)) < 1e-7) return;
    this.clocks.push({ time, position });
    if (this.clocks.length > 128) this.clocks.shift();
  }
  private binding(channel: Channel) { const key = channelKey(channel); return key === undefined ? undefined : this.bindings.get(key); }
  hasChannel(channel: Channel) { return !!this.binding(channel); }
  clear() { this.sources = []; this.bindings.clear(); this.clocks = []; }
  private blockClocks(time: number, end: number, work?: NativeAutomationWork) {
    let applicable = -1;
    for (let i = 0; i < this.clocks.length; i++) {
      if (work) work.clockRecords++;
      if (this.clocks[i].time <= time + 1e-9) applicable = i;
    }
    const segments: Array<{ start: number; clock: Clock | undefined }> = [{ start: time, clock: this.clocks[applicable] }];
    // Sorting <=128 clock events also preserves the old "last recorded mapping
    // wins" behavior for the tiny backwards-time tolerance accepted by clock().
    const future = this.clocks.map((clock, index) => ({ clock, index })).filter(c => c.index > applicable && c.clock.time < end && c.clock.time > time + 1e-9)
      .sort((a, b) => a.clock.time - b.clock.time || a.index - b.index);
    for (const { clock, index } of future) if (index > applicable) { segments.push({ start: clock.time, clock }); applicable = index; }
    if (work) work.clockSegments = segments.filter(s => s.clock).length;
    return segments;
  }
  points(channel: Channel, metadata: Vst3Parameter[], base: Map<number, number>, previous: Set<number>, time: number, frames: number, rate: number, work?: NativeAutomationWork): Vst3ParameterPoint[] {
    if (work) Object.assign(work, { clockRecords: 0, clockSegments: 0, boundaryVisits: 0, boundaryComparisons: 0, offsetSorts: 0, candidateOffsets: 0, evaluations: 0, winnerComparisons: 0, curveComparisons: 0, outputPoints: 0 });
    if (!Number.isFinite(time) || time < 0 || !Number.isInteger(frames) || frames < 1 || frames > 16384 || !Number.isFinite(rate) || rate <= 0) throw new Error('Invalid VST3 automation block');
    const binding = this.binding(channel), plans = binding?.parameters;
    const ids = new Set([...previous, ...(plans?.keys() ?? [])]);
    if (!ids.size) return [];
    if (!metadata.length) throw new Error('VST3 automation metadata unavailable');
    const params = new Map(metadata.map(p => [p.id, p]));
    for (const id of ids) if (!params.has(id) || !isAutomatable(params.get(id)!)) throw new Error(`VST3 automation target unavailable: parameter ${id}`);
    const end = time + frames / rate, segments = this.blockClocks(time, end, work);
    // Candidate storage is capped by the validated block size, NOT the Cartesian
    // product of lanes, nodes and clocks. Each sorted offset is computed once.
    const marked = new Uint8Array(frames), offsets: number[] = [];
    const add = (t: number) => {
      const i = Math.round((t - time) * rate);
      if (i >= 0 && i < frames && !marked[i]) { marked[i] = 1; offsets.push(i); }
    };
    marked[0] = 1; offsets.push(0);
    for (let i = NATIVE_AUTOMATION_GRID; i < frames; i += NATIVE_AUTOMATION_GRID) { marked[i] = 1; offsets.push(i); }
    const boundaries = binding?.boundaries ?? [];
    for (let j = 0; j < segments.length; j++) {
      const { start, clock } = segments[j];
      if (!clock) continue;
      add(clock.time);
      const lo = Math.max(time - .5 / rate, clock.time, start - (j === 0 ? .5 / rate : 0));
      const hi = Math.min(end - .5 / rate, segments[j + 1]?.start ?? Infinity);
      const origin = clock.time - clock.position;
      const limit = lowerBound(boundaries, hi - origin);
      for (let i = lowerBound(boundaries, lo - origin); i < limit;) {
        if (work) work.boundaryVisits++;
        const t = origin + boundaries[i], offset = Math.round((t - time) * rate);
        add(t);
        // All boundaries rounding to this frame have the same evaluation time.
        // Jump over their bucket instead of visiting thousands of sub-sample
        // nodes on every wrap. This is exactly the candidate Set's deduplication,
        // not dropped parameter changes: the curve is evaluated at that frame.
        let left = i + 1, right = limit;
        while (left < right) {
          if (work) work.boundaryComparisons++;
          const mid = (left + right) >>> 1;
          if (Math.round((origin + boundaries[mid] - time) * rate) <= offset) left = mid + 1; else right = mid;
        }
        i = left;
      }
    }
    offsets.sort((a, b) => a - b);
    if (work) { work.offsetSorts = 1; work.candidateOffsets = offsets.length; }
    // Resolve the clock/position once, not once for every parameter.
    const bars = new Float64Array(offsets.length);
    let segment = 0;
    for (let i = 0; i < offsets.length; i++) {
      const audioTime = time + offsets[i] / rate;
      while (segment + 1 < segments.length && segments[segment + 1].start <= audioTime + 1e-9) segment++;
      const clock = segments[segment].clock;
      bars[i] = clock ? (clock.position + audioTime - clock.time) / this.secondsPerBar : -1;
    }
    const result: Vst3ParameterPoint[] = [];
    for (const id of ids) {
      const parameter = params.get(id)!, plan = plans?.get(id);
      const baseValue = base.get(id) ?? parameter.currentValue!;
      let last: number | undefined;
      for (let i = 0; i < offsets.length; i++) {
        if (work) work.evaluations++;
        const bar = bars[i];
        let value = baseValue;
        if (plan?.uniformValue !== undefined) {
          if (bar >= plan.boundaries[0]) value = plan.uniformValue;
        } else {
          const clip = plan && winningClip(plan, bar, work);
          if (clip) value = interpolateSortedCurve(clip.points, Math.min(1, (bar - clip.start) / clip.length), work);
        }
        if (parameter.stepCount > 0) value = Math.round(value * parameter.stepCount) / parameter.stepCount;
        if (value !== last) {
          // Check BEFORE allocation; no partial schedule or previous-ID update is
          // published on failure. Coalescible valid schedules are not rejected
          // merely because candidates * parameters exceeds the request bound.
          if (result.length === 4096) throw new Error('VST3 automation point limit exceeded');
          result.push({ id, value, offset: offsets[i] });
          if (work) work.outputPoints++;
        }
        last = value;
        if (!plan) break; // a removed target has exactly one base reset
      }
    }
    previous.clear(); plans?.forEach((_, id) => previous.add(id));
    return result;
  }
}
