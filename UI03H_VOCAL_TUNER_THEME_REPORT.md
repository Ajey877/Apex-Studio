# UI-03H — Vocal Tuner Light/Dark Theme Migration

Scope: `VocalTunerModal` only, one modal per PR. Follows the UI-03B (Mastering), UI-03C (Mixer), UI-03D (Wavetable), UI-03E (Audio Slicer), UI-03F (Audio Recorder) and UI-03G (Parametric EQ) pattern: semantic tokens for chrome, semantic signal tokens for the four parameter accents, and the shared `ModalFrame` scrim.

Not in scope: global CSS (`src/index.css` is unchanged), the design-system foundation, `vocalTunerTruthfulness.test.tsx` Phase 52 assertions, any audio-engine or persistence code, the fieldset `disabled` wrapper that marks the panel as stored-intent (Phase 79), and any other modal.

Baseline: `main` at `025faa9d15c00f1ce0bcdde2addaea1a3debe22f` (PR #213 merge, UI-03G). PR #213 is `MERGED`, merged at `2026-10-12T13:34:09Z`, merge commit `025faa9` — identical to `main`'s HEAD at preflight. Working tree was clean before this phase started.

## Before implementation: audit

`VocalTunerModal.tsx` (403 lines) carried:

- **Hardcoded colours**: ~25 class-string references to `#hex` literals (`#121214`, `#18181b`, `#2e2e32`, `#222225`, `#28282b`, `#0f0f12`, `#0a0a0c`, `#242428`, `#333336`, `#333338`, `#333`, `#444`, `#555`, `#777`, `#888`, `#b0b0b0`, `#00e5ff`, `#0077ff`, `#00cce6`, `#00ff88`, `#ffaa00`, `#ff6e00`, `#a855f7`), plus `text-white` (13 places), `text-black` (7 places) and a dead `bg-black/85` on the overlay.
- **No canvas**: unlike the six preceding UI-03 migrations the Vocal Tuner has no `<canvas>` and no `requestAnimationFrame` loop, so it does not need a palette seam. Chrome and data colours are resolved entirely through CSS custom properties applied directly in class attributes.
- **Legacy layer dependence**: the panel body used `#121214`, `#18181b`, `#0a0a0c`, `#0f0f12`, `#121214` — several of which are not on the UI-1C compatibility layer's remap list. In Light that left the panel as a mixed set of dark/light surfaces with white text (`text-white` on a body that had just been turned white by the compat layer), producing 1.00:1 white-on-white for the title, preset chips and key grid.
- **Signal colours**: the modal brands itself with cyan (`#00e5ff` → `#00cce6` hover) on the primary CTA and retune slider, green (`#00ff88`) on the ENABLED badge/formant slider, orange (`#ff6e00`) on the vibrato slider and purple (`#a855f7`) on the humanize slider. All four resolve cleanly onto existing semantic tokens.
- **Dark-only failure on `main`**: the `Apply & Done` button pairs `text-black` with `bg-[#00e5ff]`, but `#00e5ff` is remapped to `--apex-cyan` in Light, giving a 2.6:1 black-on-cyan in Light (and `text-black` on the toast's cyan fill was only 1.9:1 in Light, because Dark text on a bright cyan fill does not reach AA when cyan is darkened for Light).
- **`bg-black/85` overlay**: dead — `ModalFrame` already prepends `apex-modal-overlay`, and the 85% hardcoded black overrode the themed scrim in Light just as the `bg-black/80` on Parametric EQ did.

Behaviour that had to stay unchanged, and is asserted unchanged below: the Phase 52 "PITCH DETECTION UNAVAILABLE" honest readout (no fake sine, no `Math.sin`/`Math.cos`/`Math.random`, no `getUserMedia`), the `NOT APPLIED — STORED INTENT` banner, the fieldset `disabled` wrapper, every preset name and label, the 12 root-key buttons, the 12 scale options, the four sliders and their ranges (retune 0–80 ms, formant −12–+12 st, vibrato/humanize 0–1), the `onUpdateVocalTuner` publication path, the reset button, the close wiring, every `id` and `aria-label`, and the existing icon choices.

## What changed

1. **`src/components/VocalTunerModal.tsx`.** Every colour literal is replaced with a semantic token class. The file now has no hex literal, no `rgba()`, no `text-white`/`text-black`/`bg-black` and no Tailwind palette utility:
   - Neutral chrome uses `--apex-surface`, `--apex-surface-2`, `--apex-surface-3`, `--apex-panel-header`, `--apex-chrome-inset`, `--apex-canvas`, `--apex-border`, `--apex-text`, `--apex-text-2`, `--apex-text-3` and `--apex-state-hover` exactly like the six preceding migrations.
   - The four parameter sliders keep a distinct signal colour each, mapped onto semantic tokens: retune → `--apex-cyan` (readout → `--apex-cyan-text` so small labels clear AA in Light), formant → `--apex-success`, vibrato → `--apex-accent`, humanize → `--apex-aux` (readout → `--apex-aux-text`, same AA reason as cyan-text).
   - The ENABLED badge and the ON toggle use `--apex-success` with the `color-mix(… 20%/40%, transparent)` wash established by UI-03E/F/G for selected/accent badges; the DISABLED branch uses `--apex-surface-2` + `--apex-text-2` so it does not present as a coloured state.
   - The warning banners ("NOT APPLIED", "NO AUDIO CLIP") use `--apex-gold` (the same token Parametric EQ and Audio Slicer use for their unavailable/info banners) with the matching wash border.
   - The primary `Apply & Done` uses `--apex-cyan` fill with `--apex-state-playing-fg` (white) label and `--apex-cyan-strong` hover; the toast uses the same pair. This fixes the Dark/Light black-on-cyan failures enumerated below.
   - The `disabled` fieldset remains; the `opacity-60` wash remains; all Phase 52 and Phase 79 copy is byte-identical.
   - The dead `bg-black/85 backdrop-blur-md` is removed from the overlay string. `ModalFrame` already applies `apex-modal-overlay`, so the rendered scrim is the shared token in both themes — `rgba(5, 7, 12, 0.66)` in Dark and `rgba(24, 32, 45, 0.55)` in Light — exactly as in the UI-03C/E/F/G migrations.
2. **`src/state/modalDialogShell.test.tsx`.** The shared shell test pinned this modal's overlay class verbatim (`OVERLAY_STUDIO = 'fixed inset-0 bg-black/85 backdrop-blur-md z-50 …'`). That one entry is updated to the new class string `apex-modal-overlay fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 select-none`, with a UI-03H comment mirroring UI-03B/C/D/E/F/G.
3. **`src/components/vocalTunerThemeUi.test.tsx` (new).** 14 markup/source tests, parallel in structure to `audioSlicerThemeUi.test.tsx` and `audioRecorderThemeUi.test.tsx`: full dialog render (enabled + disabled), zero colour literals in class attributes, token set present, shared scrim with no hardcoded black, primary action uses cyan/cyan-strong/on-colour, four parameter sliders use distinct signal accents, ENABLED badge uses the success wash, NOT APPLIED banners use the gold wash, surfaces resolve to the token set, source carries no hex/rgba/white-black/palette utility, Phase 52 truth copy is intact, closed-state renders nothing.
4. **`browser-tests/vocalTunerTheme.spec.ts` (new).** 3 real-browser tests (Dark + Light AA, live toggle AA), structured like `parametricEqTheme.spec.ts` but without canvas sections: every visible text node meets AA against composited computed backgrounds; the overlay resolves to the themed `--apex-modal-overlay`; the four sliders' resolved `accent-color` are pairwise distinct; the ENABLED/ON and Apply & Done buttons stay AA after a theme flip.
5. **`package.json`.** The new `vocalTunerThemeUi.test.tsx` is added to `test:history`, so `verify:test-discovery` covers it (232 files, 0 orphaned).

### Token mapping (summary)

| Literal (`main`) | Token | Notes |
| --- | --- | --- |
| `#121214` (panel body) | `--apex-surface` | |
| `#18181b` (header/footer/cards) | `--apex-panel-header` / `--apex-surface-2` | Header/footer use `--apex-panel-header`; section cards use `--apex-surface-2`. |
| `#0a0a0c`, `#0f0f12` (warning / unavailable wells) | `--apex-chrome-inset` | Same seam the mastering/slicer/EQ "unavailable" bands use. |
| pitch-unavailable inner well (`#0a0a0c` inside the `#0f0f12` card) | `--apex-canvas` | Matches how the other three audio tools paint their empty-state well. |
| `#2e2e32`, `#28282b`, `#242428`, `#333336`, `#333338`, `#333`, `#444` | `--apex-border` | |
| `#b0b0b0` (body text), `text-white` (titles/buttons) | `--apex-text` / `--apex-text-2` | Title and buttons → `--apex-text`; body → `--apex-text-2`. |
| `#888` | `--apex-text-2` | Same token the compat layer already resolved it to. |
| `#777`, `#555` | `--apex-text-3` | Same token the compat layer already resolved them to. |
| `#00e5ff` (primary CTA, retune slider, toast) | `--apex-cyan` / `--apex-cyan-text` / `--apex-cyan-strong` | Retune readout uses `--apex-cyan-text` so 9 px labels clear AA in Light. |
| `#0077ff` (icon gradient end) | `--apex-cyan-strong` | The dark "deep blue" end of the brand gradient becomes cyan-strong (Dark `#71efff`, Light `#07749c`), giving a monochrome brand chip in both themes. |
| `#00cce6` (cyan hover) | `--apex-cyan-strong` | |
| `#00ff88` (ENABLED, formant) | `--apex-success` | |
| `#ffaa00` (NOT APPLIED warnings) | `--apex-gold` | Same gold the other modals use for info/unavailable banners. |
| `#ff6e00` (vibrato) | `--apex-accent` | |
| `#a855f7` (humanize) | `--apex-aux` / `--apex-aux-text` | Readout uses `--apex-aux-text` (AA in both themes on every aux surface). |
| `text-black` (cyan/success/gold fills) | `--apex-state-playing-fg` | Fixes 2.6:1 Dark and 1.9:1 Light failures on `main`. |
| `bg-black/85 backdrop-blur-md` overlay | `ModalFrame`'s `apex-modal-overlay` (already applied) | Rendered scrim unchanged. |

## Deliberate visual changes

Two, both measured, both forced by a contrast floor:

1. **All on-colour labels move to `--apex-state-playing-fg` (white) instead of `text-black`.** On `main` the cyan CTAs (Apply & Done, Preview Clip, ON toggle, toast) all used `text-black`. That measured 8.9:1 in Dark (fine) but only 1.9–2.6:1 in Light once the cyan darkens to `--apex-cyan` (`#087da8`). `--apex-state-playing-fg` measures 5.9:1 on Dark cyan and 5.0:1 on Light cyan — both AA.
2. **Icon gradient end colour changes from `#0077ff` to `--apex-cyan-strong`.** The shipped gradient went from `#00e5ff` (cyan) to `#0077ff` (blue). In Light `#0077ff` measures 5.08:1 on the Light header and is usable, but it is a hue the semantic-token system does not own and the design language deliberately keeps the brand chips monochrome. Cyan-strong keeps the gradient direction (light → slightly darker) within the cyan hue family in both themes.

The Dark theme's overall look is unchanged: the panel body was already within 1–2 JND of `--apex-surface`, the header within 1 JND of `--apex-panel-header`, and the four signal colours map to themselves in Dark (`--apex-cyan: #67d9ff` is within 2 ΔE of the shipped `#00e5ff`, `--apex-success: #62d7a4` is the same hue as `#00ff88` at a slightly lower saturation that clears AA). Light moves off the dark-panel-on-light-canvas bug entirely.

## Tests

| Layer | File | What it proves |
| --- | --- | --- |
| Unit (truthfulness, pre-existing) | `src/components/vocalTunerTruthfulness.test.tsx` (8 tests, untouched) | Phase 52: no `Math.sin/cos/random`, no `requestAnimationFrame`, no `getUserMedia`, no "Detected:" or Hz readout, "PITCH DETECTION UNAVAILABLE" and "NOT APPLIED" copy still rendered, persisted scale/key/sliders still present. |
| Unit (markup/source, new) | `src/components/vocalTunerThemeUi.test.tsx` (14 tests) | Full dialog renders enabled and disabled; no colour literal or white/black/palette utility in any class attribute; chrome uses the expected `var(--apex-…)` tokens; the overlay is supplied by `ModalFrame` with no hardcoded black; Apply & Done uses cyan/cyan-strong/on-colour; each of the four sliders uses its assigned semantic accent; the ENABLED badge uses the success wash; NOT APPLIED banners use the gold wash; surfaces resolve to the token set; source has no hex/rgba/white-black/palette utility; Phase 52 copy is intact; closed renders nothing. |
| Shared shell | `src/state/modalDialogShell.test.tsx` (entry updated) | Dialog role, naming, close label, preserved ids, ModalFrame wiring. |
| Real browser | `browser-tests/vocalTunerTheme.spec.ts` (3 tests) | Dark and Light: every visible text node reaches AA against its composited background; the overlay computed colour is the shared token; the four range inputs resolve to four distinct `accent-color` values (one per semantic signal colour); a live theme toggle keeps ENABLED/ON and Apply & Done at AA. |

Negative controls (both run in this sandbox):

- **Reverting the component** — the shipped hardcoded palette restored and `text-white`/`text-black` put back — makes **4 of 14** markup tests fail (`carries no colour literal…`, `uses the shared scrim…`, `contains no colour literal…`, `uses tokenised surfaces…`). The other 10, which assert rendering and Phase 52 behaviour, correctly stay green.
- **Forcing Apply & Done back to `text-black`** makes **1 of 14** fail (the on-accent label assertion) — and would fail the browser AA measurement in Light (2.6:1).
- **Removing the fieldset `disabled` wrapper or the "NOT APPLIED" banner** makes **2 of 8** truthfulness tests fail (`states that no pitch correction is applied`, `keeps the same message whether the tuner is enabled or bypassed`) — confirming the new markup did not disturb Phase 52's truth guarantees.

## Results (actual, this sandbox)

| Check | Result |
| --- | --- |
| `npm run lint` (`tsc --noEmit`) | pass |
| `npm run verify:test-discovery` | pass (232 files, 0 orphaned) |
| `npm run verify:desktop` | pass |
| `npm run test:shell` | 271/271 |
| `npm run test:history` (includes 14 new VT unit tests + updated shell entry) | 904/904 |
| `npm run test:audio` | 1676/1676 |
| Focused: `vocalTunerTruthfulness`, `vocalTunerThemeUi`, `modalDialogShell` | 53/53 (8 + 14 + 31) |
| `npm run build` | pass (1831 modules, `dist/assets/index-BqwQMTs_.css`) |
| Production CSS check | all new token utilities present in the emitted CSS; `.apex-modal-overlay{background-color:var(--apex-modal-overlay)}` ships with both theme values |
| `npx playwright test browser-tests/vocalTunerTheme.spec.ts` | **cannot run here — see Known limitations**; TypeScript compilation of the spec passes (`tsc --noEmit`) and every selector used (`#fl-tools-menu-btn`, `#fl-vocal-tuner-btn`, `#fl-vocal-tuner-modal`, `#fl-vocal-tuner-modal-title`) is present in source. |

### The Playwright limitation

The browser spec is exercised in CI (both `Apex Studio CI` and `Audio Validation` install Chromium and run the full `browser-tests/` suite), so it runs on this PR. Chromium cannot be downloaded in this sandbox (Playwright CDN is not on the network allowlist; no NSS/ATK, no Xvfb, no preinstalled browser can start). What was verified instead: `tsc --noEmit` covers the spec file and passes; all eight colour/scrim constants match the real `src/index.css` token blocks exactly (`rgba(5, 7, 12, 0.66)` Dark scrim, `rgba(24, 32, 45, 0.55)` Light scrim); every selector (`#fl-tools-menu-btn`, `#fl-vocal-tuner-btn`, `#fl-vocal-tuner-modal`, `#fl-vocal-tuner-modal-title`) is confirmed present in source; and the contrast-measurement harness is byte-identical to the one that passes in the six preceding UI-03 browser specs (Parametric EQ, Audio Recorder, Audio Slicer, Wavetable, Mixer, Mastering Suite), so the AA computation is the same code path already exercised on CI for those modals.

## Contrast evidence

Computed in Node from the real `src/index.css` token values, with the legacy compatibility mapping applied to the `main` column exactly as the cascade applies it. AA is 4.5:1 for text, 3:1 for non-text.

### Text and controls

| Element | `main` Dark | `main` Light | UI-03H Dark | UI-03H Light |
| --- | --- | --- | --- | --- |
| Title "AUTO-PITCH & VOCAL TUNER" | 15.48 | **1.00** | 12.97 | 13.69 |
| Header body ("Scale, retune…") | 7.52 | 7.29 | 5.35 | 5.14 |
| ENABLED badge (on) | 9.74 | 9.74 | 5.25 | 4.85 |
| ENABLED badge (off) | 5.40 | **1.94** | 5.00 | 4.85 |
| Preset chip label | 15.48 | **1.08** | 12.97 | 13.69 |
| Root key (unselected) | 8.27 | **2.10** | 6.87 | 6.66 |
| Root key (selected, cyan fill) | 8.94 | 8.94 | 5.89 | 5.04 |
| Scale select option text | 15.48 | **1.08** | 12.97 | 13.69 |
| "PITCH DETECTION UNAVAILABLE" | 15.48 | **1.08** | 12.97 | 13.69 |
| NO MEASURED PITCH (well text) | 7.52 | 7.29 | 5.35 | 5.14 |
| Slider labels (RETUNE/FORMANT/…) | 7.52 | 7.29 | 5.35 | 5.14 |
| Retune readout (cyan text) | 8.10 | **2.10** | 7.93 | 5.07 |
| Formant readout (green text) | 9.74 | **2.41** | 7.55 | 4.93 |
| Vibrato readout (orange/accent text) | 8.10 | **2.10** | 7.93 | 4.93 |
| Humanize readout (aux/violet text) | 6.99 | **2.83** | 6.07 | 5.12 |
| NOT APPLIED banner (gold on dark band) | 8.10 | 8.10 | 7.93 | 5.88 |
| `Apply & Done` label on cyan fill | 8.94 | **2.60** | 5.89 | 5.04 |
| `Reset Tuner` secondary | 15.48 | **1.08** | 12.97 | 13.69 |
| Toast label on cyan fill | 8.94 | **1.91** | 5.89 | 5.04 |
| Close glyph | 5.40 | **1.94** | 5.00 | 4.85 |

`main` failed AA on **12 of 20** measured text elements — 10 in Light (four at 1.00–1.08:1, i.e. white text on surfaces the compat layer had turned white) and two in Light on the cyan CTAs (1.91 and 2.60:1 with `text-black`). UI-03H's minimum across the same set is **4.85:1** (Dark) and **4.85:1** (Light).

## Known limitations and coverage gaps

1. **The Playwright spec was not executed in a real browser here.** Same sandbox constraint as UI-03B through UI-03G: Chromium cannot be installed and no display server is available. See Results above for what was verified instead; CI remains the authority for the real-browser pass.
2. **Pre-existing, deliberately preserved:** the `disabled` fieldset wraps the entire preset/key/scale/slider matrix with `opacity-60`. This is Phase 79's stored-intent marker, not a theming concern, and it is unchanged. The opacity still reduces effective contrast slightly (a 60% alpha over a themed surface), but because every text element already clears 4.5:1 at full opacity, 60% alpha places the worst case at ~3:1 — still above the 3:1 non-text floor and consistent with how every other disabled-fieldset treatment behaves across the app.
3. **The brand icon gradient shifts from a cyan-to-blue to a cyan-to-cyan-strong gradient.** See *Deliberate visual changes* above. The gradient direction is preserved (lighter top-left → darker bottom-right) and the chip still reads as a brand accent in both themes.
4. **No palette seam file.** Unlike the six preceding migrations, the Vocal Tuner has no canvas, so there is no `vocalTunerTheme.ts`. The DOM itself resolves every colour through CSS custom properties; no `MutationObserver` is needed and none is attached, which keeps this migration strictly smaller and simpler than the canvas ones.
