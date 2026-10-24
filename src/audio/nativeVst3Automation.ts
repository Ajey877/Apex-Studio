import type { AutomationPoint, Channel, PlaylistClip } from '../types/daw';
import type { Vst3Parameter, Vst3ParameterPoint } from './nativeVst3Types';

import { interpolateCurve } from './automation/curve';
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

/** Runtime clock segments are NOT persisted. New segments at loop wraps rebase
 * the musical position without replaying queued points from the previous pass.
 * Grid is 128 samples, plus exact clip/node/clock boundaries (rounded to frames).
 * Queues carry real offsets; a plugin may consume only the last point per block.
 */
export class NativeAutomationTimeline {
  private clips: PlaylistClip[] = [];
  private secondsPerBar = 2;
  private clocks: Array<{ time: number; position: number }> = [];
  set(clips: PlaylistClip[], secondsPerBar: number) {
    const native = clips.filter(c => c.type === 'automation' && c.automationTarget?.type === 'vst3_param' && !c.mute);
    if (native.length > 128 || native.reduce((sum, c) => sum + (c.automationPoints?.length ?? 0), 0) > 4096 || !Number.isFinite(secondsPerBar) || secondsPerBar <= 0) throw new Error('Invalid VST3 automation timeline');
    native.forEach(validateNativeCurve);
    this.clips = native; this.secondsPerBar = secondsPerBar;
  }
  clock(time: number, position: number) {
    if (!Number.isFinite(time) || !Number.isFinite(position) || time < 0 || position < 0) throw new Error('Invalid VST3 automation clock');
    const last = this.clocks.at(-1);
    if (last && time < last.time - 1e-7) throw new Error('Unordered VST3 automation clock');
    if (last && Math.abs((last.time - last.position) - (time - position)) < 1e-7) return;
    this.clocks.push({ time, position });
    // Live lookahead is 100 ms; retaining 128 discontinuities is ample and bounded.
    if (this.clocks.length > 128) this.clocks.shift();
  }
  hasChannel(channel: Channel) { return this.clips.some(c => nativeTargetMatches(c.automationTarget!, channel)); }
  clear() { this.clips = []; this.clocks = []; }
  points(channel: Channel, metadata: Vst3Parameter[], base: Map<number, number>, previous: Set<number>, time: number, frames: number, rate: number): Vst3ParameterPoint[] {
    const clips = this.clips.filter(c => nativeTargetMatches(c.automationTarget!, channel));
    const ids = new Set([...previous, ...clips.map(c => c.automationTarget!.native!.parameterId)]);
    if (!ids.size) return [];
    if (!metadata.length) throw new Error('VST3 automation metadata unavailable');
    const params = new Map(metadata.map(p => [p.id, p]));
    for (const id of ids) if (!params.has(id) || !isAutomatable(params.get(id)!)) throw new Error(`VST3 automation target unavailable: parameter ${id}`);
    const offsets = new Set<number>([0]);
    for (let i = NATIVE_AUTOMATION_GRID; i < frames; i += NATIVE_AUTOMATION_GRID) offsets.add(i);
    const clocks = this.clocks.filter(c => c.time < time + frames / rate);
    for (const clock of clocks) {
      const add = (t: number) => { const i = Math.round((t - time) * rate); if (i >= 0 && i < frames) offsets.add(i); };
      add(clock.time);
      for (const c of clips) for (const x of [0, 1, ...c.automationPoints!.map(p => p.x)]) {
        add(clock.time - clock.position + (c.startBar + c.lengthBars * x) * this.secondsPerBar);
      }
    }
    const result: Vst3ParameterPoint[] = [];
    for (const id of ids) {
      const parameter = params.get(id)!;
      let last: number | undefined;
      for (const offset of [...offsets].sort((a, b) => a - b)) {
        const audioTime = time + offset / rate;
        const clock = [...clocks].reverse().find(c => c.time <= audioTime + 1e-9);
        const bar = clock ? (clock.position + audioTime - clock.time) / this.secondsPerBar : -1;
        let value = base.get(id) ?? parameter.currentValue!;
        // Existing automation latches its endpoint until a new clip/event or
        // explicit reset. Last active clip in Playlist order wins overlaps.
        let latest = -Infinity;
        for (const c of clips) {
          if (c.automationTarget!.native!.parameterId !== id || bar < c.startBar) continue;
          const eventBar = Math.min(bar, c.startBar + c.lengthBars);
          if (eventBar < latest) continue;
          latest = eventBar;
          value = interpolateCurve(c.automationPoints as AutomationPoint[], Math.min(1, (bar - c.startBar) / c.lengthBars));
        }
        if (parameter.stepCount > 0) value = Math.round(value * parameter.stepCount) / parameter.stepCount;
        if (value !== last) result.push({ id, value, offset });
        last = value;
      }
    }
    if (result.length > 4096) throw new Error('VST3 automation point limit exceeded');
    previous.clear(); clips.forEach(c => previous.add(c.automationTarget!.native!.parameterId));
    return result;
  }
}
