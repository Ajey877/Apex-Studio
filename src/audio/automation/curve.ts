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
