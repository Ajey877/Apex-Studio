// Putting the Windows display configuration back, and proving that it is back.
//
// The P9 acceptance scripts change the real display scale (and, where Windows
// would otherwise not offer 150%, the resolution). A run that leaves the desktop
// changed has not finished cleanly, so the restoration is part of the verdict:
// the configuration is recorded before anything is changed, restored afterwards,
// read back from Windows and compared setting by setting. "The set call returned
// success" is not accepted as proof; only the read-back is.
//
// Nothing here talks to Windows directly. The caller passes `call(action, args)`,
// which runs scripts/windows-display-scale.ps1 and returns its JSON (or throws).
// That keeps every decision in this file testable on any platform.

/** The settings that are recorded, compared and reported, per display. */
export const COMPARED_SETTINGS = ['primary', 'left', 'top', 'width', 'height', 'effectiveDpi', 'scalePercent'];

/**
 * Reduce a `query` result of the display tool to what has to be put back.
 * Displays are identified by their device name (\\.\DISPLAYn), never by position
 * in a list, because the list order is not guaranteed to be stable.
 */
export function snapshotDisplayConfiguration(state) {
  if (!state || !Array.isArray(state.monitors) || state.monitors.length === 0) {
    throw new Error('the display query returned no monitors');
  }
  const sources = Array.isArray(state.sources) ? state.sources : [];
  const displays = state.monitors.map(monitor => {
    const sourceIndex = sources.findIndex(source => source.device === monitor.device);
    const source = sourceIndex >= 0 ? sources[sourceIndex] : null;
    const derived = Number.isFinite(monitor.effectiveDpi) ? Math.round(monitor.effectiveDpi * 100 / 96) : null;
    return {
      device: monitor.device,
      primary: Boolean(monitor.primary),
      left: monitor.left, top: monitor.top,
      width: monitor.width, height: monitor.height,
      effectiveDpi: monitor.effectiveDpi,
      // What Windows says the scale is; where it does not say, the DPI implies it.
      scalePercent: Number.isFinite(source?.currentPercent) && source.currentPercent > 0 ? source.currentPercent : derived,
      scaleSource: Number.isFinite(source?.currentPercent) && source.currentPercent > 0 ? 'windows-display-config' : 'derived-from-dpi',
      sourceIndex: sourceIndex >= 0 ? sourceIndex : null,
    };
  }).sort((a, b) => String(a.device).localeCompare(String(b.device)));
  return { capturedAt: new Date().toISOString(), monitorCount: displays.length, displays };
}

/**
 * Compare two snapshots. Every difference names the display and the setting, so a
 * failed restoration says exactly what is still wrong.
 */
export function compareDisplayConfiguration(original, final) {
  const differences = [];
  if (!original || !final) {
    return { matches: false, differences: [{ device: null, setting: 'snapshot', original: Boolean(original), final: Boolean(final) }] };
  }
  if (original.monitorCount !== final.monitorCount) {
    differences.push({ device: null, setting: 'monitorCount', original: original.monitorCount, final: final.monitorCount });
  }
  for (const before of original.displays) {
    const after = final.displays.find(display => display.device === before.device);
    if (!after) {
      differences.push({ device: before.device, setting: 'present', original: true, final: false });
      continue;
    }
    for (const setting of COMPARED_SETTINGS) {
      if (before[setting] !== after[setting]) {
        differences.push({ device: before.device, setting, original: before[setting], final: after[setting] });
      }
    }
  }
  for (const after of final.displays) {
    if (!original.displays.some(display => display.device === after.device)) {
      differences.push({ device: after.device, setting: 'present', original: false, final: true });
    }
  }
  return { matches: differences.length === 0, differences };
}

/**
 * Put the display configuration back to `original` and verify it.
 *
 * Never throws: it is called from `finally` blocks and from signal handlers, and
 * a failure to restore must be reported, not turn into a second exception that
 * hides the first. Every problem ends up in the returned record.
 *
 * `ok` is true only when a final query of Windows matches `original` in every
 * compared setting of every display.
 */
export function restoreDisplayConfiguration({ original, call, attempts = 3 }) {
  const record = {
    // Whether anything had to be changed back. False when the final state already
    // matched before any restoring call was made.
    changesWereNeeded: false,
    attempts: 0,
    ok: false,
    original,
    final: null,
    differences: [],
    steps: [],
    errors: [],
  };
  const fail = (where, error) => record.errors.push({ where, message: String(error?.message ?? error).slice(0, 500) });
  if (!original) {
    record.differences = [{ device: null, setting: 'snapshot', original: false, final: null }];
    fail('precondition', 'no original display configuration was recorded');
    return record;
  }
  const query = where => {
    try { return call('query'); }
    catch (error) { fail(where, error); return null; }
  };
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const state = query(`query before attempt ${attempt}`);
    let current = null;
    try { current = state ? snapshotDisplayConfiguration(state) : null; } catch (error) { fail(`snapshot before attempt ${attempt}`, error); }
    if (current) {
      record.final = current;
      const comparison = compareDisplayConfiguration(original, current);
      record.differences = comparison.differences;
      if (comparison.matches) { record.ok = true; break; }
    }
    record.changesWereNeeded = true;
    record.attempts = attempt;
    // Resolution first: the scales Windows offers depend on it.
    for (const wanted of original.displays) {
      const now = current?.displays.find(display => display.device === wanted.device);
      if (current && !now) continue;  // cannot set anything on a display that is gone; the comparison reports it
      if (now && now.width === wanted.width && now.height === wanted.height) continue;
      try {
        const changed = call('set-resolution', { Width: wanted.width, Height: wanted.height, Device: wanted.device });
        record.steps.push({ attempt, device: wanted.device, setting: 'resolution', requested: `${wanted.width}x${wanted.height}`, status: changed?.status ?? null });
      } catch (error) {
        record.steps.push({ attempt, device: wanted.device, setting: 'resolution', requested: `${wanted.width}x${wanted.height}`, error: String(error.message).slice(0, 300) });
        fail(`set-resolution ${wanted.device}`, error);
      }
    }
    // The index a display has in the scale list is looked up now, by device name.
    const afterResolution = query(`query for scale indices, attempt ${attempt}`);
    for (const wanted of original.displays) {
      if (!Number.isFinite(wanted.scalePercent)) continue;
      const sources = Array.isArray(afterResolution?.sources) ? afterResolution.sources : [];
      const index = sources.findIndex(source => source.device === wanted.device);
      const reported = index >= 0 ? sources[index].currentPercent : null;
      if (afterResolution && index < 0) {
        record.steps.push({ attempt, device: wanted.device, setting: 'scale', requested: wanted.scalePercent, error: 'Windows lists no scale entry for this display' });
        continue;
      }
      if (reported === wanted.scalePercent) continue;
      try {
        const changed = call('set-scale', { Scale: wanted.scalePercent, Monitor: index >= 0 ? index : (wanted.sourceIndex ?? 0) });
        record.steps.push({ attempt, device: wanted.device, setting: 'scale', requested: wanted.scalePercent, from: reported, result: changed?.set ?? null });
      } catch (error) {
        record.steps.push({ attempt, device: wanted.device, setting: 'scale', requested: wanted.scalePercent, from: reported, error: String(error.message).slice(0, 300) });
        fail(`set-scale ${wanted.device}`, error);
      }
    }
  }
  if (!record.ok) {
    // The verdict comes from one last read of what Windows reports now.
    const state = query('final query');
    try {
      if (state) {
        record.final = snapshotDisplayConfiguration(state);
        const comparison = compareDisplayConfiguration(original, record.final);
        record.differences = comparison.differences;
        record.ok = comparison.matches;
      }
    } catch (error) { fail('final snapshot', error); }
    if (!record.final) {
      record.differences = [{ device: null, setting: 'final-query', original: 'readable', final: 'could not be read' }];
      record.ok = false;
    }
  }
  return record;
}

/** One line a person can read in a log or an annotation. */
export function describeRestoration(record) {
  if (!record) return 'display restoration: not applicable (the display configuration was never recorded, so nothing was changed)';
  const show = display => `${display.device} ${display.width}x${display.height} at (${display.left},${display.top}) ${display.scalePercent}% (${display.effectiveDpi} DPI)${display.primary ? ' primary' : ''}`;
  const original = record.original ? record.original.displays.map(show).join('; ') : 'not recorded';
  if (record.ok) {
    return `display restoration: OK. Final configuration read back from Windows equals the original: ${original}.` +
      (record.changesWereNeeded ? ` Restoring calls: ${record.steps.length}, attempts: ${record.attempts}.` : ' Nothing needed restoring.');
  }
  const differences = record.differences.map(d => `${d.device ?? 'desktop'} ${d.setting}: original ${JSON.stringify(d.original)}, now ${JSON.stringify(d.final)}`).join('; ');
  const errors = record.errors.map(e => `${e.where}: ${e.message}`).join('; ');
  return `display restoration: FAILED. ${differences || 'no comparison was possible'}.` +
    ` Original: ${original}.${errors ? ` Errors: ${errors}.` : ''}`;
}

/**
 * The verdict of an acceptance run that may have changed the display.
 *
 * `statuses` are the per-case results (PASS / FAIL / NOT_VERIFIED). `restoration`
 * is the record returned by restoreDisplayConfiguration, or null/undefined when
 * the run stopped before the display was ever recorded (so nothing was changed).
 * A run is PASS only when every case passed AND the display is back; a display
 * that is not back is FAIL even when every case passed.
 *
 * Exit codes: 0 PASS, 1 FAIL, 3 NOT_VERIFIED, 2 blocked (could not run here).
 */
export function acceptanceVerdict({ statuses, restoration = null, blocked = null }) {
  const reasons = [];
  for (const [id, status] of Object.entries(statuses)) if (status === 'FAIL') reasons.push(`${id} FAIL`);
  if (restoration && restoration.ok !== true) reasons.push(`display configuration not restored: ${describeRestoration(restoration)}`);
  if (reasons.length) return { verdict: 'FAIL', reasons, exitCode: 1 };
  if (blocked) return { verdict: 'NOT_VERIFIED', reasons: [`blocked: ${blocked}`], exitCode: 2 };
  const unverified = Object.entries(statuses).filter(([, status]) => status !== 'PASS').map(([id]) => id);
  if (unverified.length || Object.keys(statuses).length === 0) {
    return { verdict: 'NOT_VERIFIED', reasons: [`not verified: ${unverified.join(', ') || 'no case was run'}`], exitCode: 3 };
  }
  return { verdict: 'PASS', reasons: [], exitCode: 0 };
}
