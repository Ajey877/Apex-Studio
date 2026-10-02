/**
 * Phase 52 — export mixer-FX preference.
 *
 * A DAW's exported master must match what the user monitored. The offline
 * renderer takes `includeMixerFx` as an explicit argument and defaults it to
 * `false` for safety at the engine boundary, but the product default is the
 * opposite: unless the user deliberately chooses a dry bounce, an export must
 * carry the EQ, reverb, delay, compression and limiter inserts they mixed with.
 *
 * Declared here so the modal default, the App wiring and the regression tests
 * all read the same value instead of three copies drifting apart.
 */

/** Product default: exports include mixer inserts. */
export const DEFAULT_INCLUDE_MIXER_FX = true;

/** The three choices the export UI offers. `null` means "follow the default". */
export const EXPORT_FX_CHOICES = ['auto', 'on', 'off'] as const;
export type ExportFxChoice = (typeof EXPORT_FX_CHOICES)[number];

export const resolveExportFxChoice = (
  choice: ExportFxChoice | null,
  projectDefault: boolean = DEFAULT_INCLUDE_MIXER_FX
): boolean => {
  if (choice === 'on') return true;
  if (choice === 'off') return false;
  return projectDefault;
};

/** Shown next to the "Project Default" tile so the default is never implicit. */
export const describeExportFxDefault = (projectDefault: boolean): string =>
  projectDefault ? 'On — exports match what you hear' : 'Off — exports are dry (no mixer FX)';
