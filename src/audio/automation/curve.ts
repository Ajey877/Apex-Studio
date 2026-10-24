/** Shared Playlist curve semantics for editing, live and offline playback. */
export function interpolateCurve(points: { x: number; y: number; tension?: number }[], relX: number): number {
    if (!Array.isArray(points) || points.length === 0) return 0.5;
    if (points.length === 1) return points[0].y;

    const sorted = [...points].sort((a, b) => a.x - b.x);
    if (relX <= sorted[0].x) return sorted[0].y;
    if (relX >= sorted[sorted.length - 1].x) return sorted[sorted.length - 1].y;

    for (let i = 0; i < sorted.length - 1; i++) {
      const p1 = sorted[i];
      const p2 = sorted[i + 1];
      if (relX >= p1.x && relX <= p2.x) {
        const segT = (relX - p1.x) / (p2.x - p1.x);
        // Linear or ease
        const tension = p1.tension || 0;
        let curvedT = segT;
        if (tension > 0) {
          curvedT = Math.pow(segT, 1 + tension * 2);
        } else if (tension < 0) {
          curvedT = 1 - Math.pow(1 - segT, 1 + Math.abs(tension) * 2);
        }
        return p1.y + (p2.y - p1.y) * curvedT;
      }
    }
    return 0.5;}


/** Native curves are validated strictly increasing and copied at timeline update.
 * Lower-bound search deliberately uses the preceding segment at an exact interior
 * node, just like the legacy evaluator (including floating-point arithmetic).
 * Built-in/legacy unsorted or duplicate-point behavior above is unchanged.
 */
export function interpolateSortedCurve(
  points: readonly { x: number; y: number; tension?: number }[], relX: number,
  work?: { curveComparisons: number },
): number {
  if (!points.length) return 0.5;
  if (relX <= points[0].x) return points[0].y;
  if (relX >= points[points.length - 1].x) return points[points.length - 1].y;
  let lo = 1, hi = points.length - 1;
  while (lo < hi) {
    if (work) work.curveComparisons++;
    const mid = (lo + hi) >>> 1;
    if (points[mid].x < relX) lo = mid + 1; else hi = mid;
  }
  const p1 = points[lo - 1], p2 = points[lo];
  const segT = (relX - p1.x) / (p2.x - p1.x), tension = p1.tension || 0;
  let curvedT = segT;
  if (tension > 0) curvedT = Math.pow(segT, 1 + tension * 2);
  else if (tension < 0) curvedT = 1 - Math.pow(1 - segT, 1 + Math.abs(tension) * 2);
  return p1.y + (p2.y - p1.y) * curvedT;
}
