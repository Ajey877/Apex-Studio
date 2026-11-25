import type { MixerTrack } from '../types/daw';

/** Solo keeps producers feeding a solo bus and downstream buses/returns audible. */
export function mixerSoloAudibleIds(tracks: readonly MixerTrack[]): Set<number> | null {
  const seeds = tracks.filter(track => track.id !== 0 && track.solo).map(track => track.id);
  if (!seeds.length) return null;
  const forward = new Map<number, number[]>();
  const reverse = new Map<number, number[]>();
  for (const track of tracks) {
    if (track.id === 0) continue;
    const targets = [track.routingTargetId ?? 0, ...(track.auxSends ?? []).filter(send => send.amount > 0).map(send => send.targetId)];
    forward.set(track.id, targets);
    for (const target of targets) reverse.set(target, [...(reverse.get(target) ?? []), track.id]);
  }
  const visit = (edges: Map<number, number[]>) => {
    const result = new Set<number>();
    const pending = [...seeds];
    while (pending.length) {
      const id = pending.pop()!;
      if (result.has(id) || id === 0) continue; // Master must not make every sibling audible.
      result.add(id);
      pending.push(...(edges.get(id) ?? []));
    }
    return result;
  };
  return new Set([0, ...visit(forward), ...visit(reverse)]);
}
