# UI-03G — Parametric EQ Light/Dark Theme Migration

Scope: `ParametricEqModal` only, one modal per PR. Follows the UI-03B (Mastering), UI-03C (Mixer), UI-03D (Wavetable), UI-03E (Audio Slicer) and UI-03F (Audio Recorder) pattern: semantic tokens for chrome, a per-mode palette seam for the canvas, and intentional signal colours kept as constants per mode.

Not in scope: global CSS (`src/index.css` is unchanged), the design-system foundation, `parametricEqBands.ts`, any EQ calculation, publication, audio-engine or persistence code, and any other modal.

Baseline: `main` at `afb3630cd04ac7e50effcd334d891e2e399b9689` (PR #212 merge, UI-03F). PR #212 is `MERGED`, merged at `2026-10-12T12:58:04Z`, merge commit `afb3630` — identical to `main`'s HEAD. Working tree was clean before this phase started.

Post-merge CI on `afb3630` was checked once and was green across all four workflows (`Apex Studio CI`, `Audio Validation`, `Desktop Validation`, `Deploy Apex Studio Web`). None of it was rerun.

## Before implementation: audit

`ParametricEqModal.tsx` (476 lines) carried:

- **Hardcoded colours**: ~45 class-string references to `#hex` literals (`#18181b`, `#333336`, `#141416`, `#2a2a2d`, `#202024`, `#2e2e32`, `#2a2a2e`, `#333`, `#3e3e44`, `#28282e`, `#1c1c20`, `#222226`, `#101014`, `#ff6e00`, `#ff851b`, `#2ecc71`, `#e74c3c`, `#888`, `#666`, `#27272a`), plus `text-white` in 8 places and a dead `bg-black/80` on the overlay.
- **Imperative canvas**: a 60 fps `requestAnimationFrame` loop with nine hardcoded paint strings — `#101014` background, `#222228` frequency grid, `#1e1e24` dB grid, `#383842` 0 dB reference, `#555560` axis labels, `rgba(255, 110, 0, 0.15)` spectrum, `#ff6e00` response curve, `#ffffff`/`#000000` node rings and `#ffffff` node numbers. Its effect depends on `[isOpen, bands, selectedBandId]`, so a theme flip could never repaint it.
- **Legacy layer dependence**: most literals only looked right in Dark because `src/index.css` remaps them. That remap is what made Light fail *worst*: `.bg-[#141416]`, `.bg-[#1c1c20]`, `.bg-[#202024]` and `.bg-[#2a2a2e]` all flip to light surfaces while `text-white` does not move, producing 1.00:1 white-on-white text in three places. Meanwhile `#18181b` (the dialog panel), `#101014` (the canvas well) and `#3e3e44` are *not* remapped, so they stayed dark — the modal rendered in Light as a dark panel with white bands cut through it.
- **Dark-only failure on `main`**: the `Done` button pairs `text-white` with `bg-[#ff6e00]`, and `.bg-[#ff6e00]` *is* remapped to `--apex-accent` — white on `#9b8afb` measures 2.83:1, below AA, in the theme that was otherwise fine.

Behaviour that had to stay unchanged, and is asserted unchanged below: the log-frequency/`dB` coordinate mapping (`freqToX`, `xToFreq`, `dbToY`, `yToDb`), the node hit-test radius (`dist < 15`), the drag path and its `bandsRef` staleness guard, the three-stage publication through `publishEqBandsToTrack`, the preset and flat-reset paths, the frequency/gain/Q ranges and steps, the `requestAnimationFrame` loop and its cancel on cleanup, every `id` and `aria-label`, and all Phase 52 copy.

## What changed

1. **`src/components/parametricEqTheme.ts` (new).** The palette seam:
   - Graph chrome — canvas background, grid line, 0 dB reference line and axis labels — resolves from `--apex-canvas`, `--apex-grid-line`, `--apex-grid-line-strong` and `--apex-text-3` through the shared `canvasThemeTokens.ts` resolver.
   - The spectrum, response curve, node rings and node number are per-mode signal colours. Dark keeps the shipped literals exactly, with one documented exception (the node number). Light takes `--apex-gold`, `--apex-accent` and `--apex-text`.
   - The palette is cached per (document, mode). The draw loop reads it on every frame, so a theme flip is picked up on the next frame. No `MutationObserver` is needed, and none is attached.
   - The band node **fill is a display mapping of `band.color`, not the stored value.** `band.color` is `EQ_BAND_SPECS` persisted project data and is never rewritten; `EQ_BAND_DISPLAY_COLORS` maps it to the colour the active theme can actually show, and both the canvas node and the band card's swatch read that one mapping. See *Band display colours* below.
2. **`src/components/ParametricEqModal.tsx`.**
   - Every colour literal is replaced with a semantic token class. The file now has no hex literal, no `rgba()`, no `text-white`/`text-black`/`bg-black` and no Tailwind palette utility.
   - The canvas paints from the seam (`readEqPalette()` inside the frame callback). This is the only logic-adjacent change; the diff contains no other non-class line.
   - The dead `bg-black/80` is removed from the overlay string. `ModalFrame` already applies `apex-modal-overlay`, so the rendered scrim is the shared token in both themes — `#05070ca8` (`rgba(5, 7, 12, 0.66)`) in Dark and `#18202d8c` (`rgba(24, 32, 45, 0.55)`) in Light, both verified in the production CSS.
3. **`src/state/modalDialogShell.test.tsx`.** The shared shell test pinned this modal's overlay class verbatim. That one entry is updated to the new string, with a comment, mirroring UI-03E/F. The entry no longer shares the `OVERLAY_HUB` constant, which still describes the untouched MIDI Controller modal.
4. **`package.json`.** The two new unit test files are added to `test:history`, so `verify:test-discovery` covers them (231 files, 0 orphaned).

### Token mapping (summary)

| Literal (main) | Token | Notes |
| --- | --- | --- |
| `#18181b` (panel), `#141416` (header/footer) | `--apex-surface`, `--apex-panel-header` | |
| `#202024` | `--apex-surface-2` | Preset row, parameter panel |
| `#2a2a2e`, `#28282e`, `#333` (slider track) | `--apex-surface-3` | Chips, selected band card, range tracks |
| `#1c1c20` | `--apex-surface` | Unselected band card |
| `#101014`, `#18181b` (readout) | `--apex-canvas` | Canvas well, filter-type readout |
| `#333336`, `#2a2a2d`, `#2e2e32`, `#3e3e44` | `--apex-border` | |
| `#888` | `--apex-text-2` | Same token the compat layer already resolved it to — no visual change |
| `#666` | `--apex-text-3` | Same token the compat layer already resolved it to |
| `text-white` | `--apex-text` | Title, band cards, readouts, chips |
| `#ff6e00` (UI accent) | `--apex-accent` / `--apex-accent-strong` | Icon chip, badges, selected border, Done |
| `#ff851b` (badge) | `--apex-accent` on `--apex-surface-3` | On `--apex-state-selected` the accent measures 4.49:1 / 4.45:1 — a hair under AA |
| `text-white` on `bg-[#ff6e00]` | `--apex-state-playing-fg` | Fixes a 2.83:1 Dark failure on `main` |
| `#2ecc71` / `#e74c3c` (gain sign) | `--apex-success` / `--apex-danger` | |
| `#ff6e00` @ 10–30% | `--apex-state-selected` / `--apex-state-selected-border` | |
| `accent-[#ff6e00]` | `accent-[var(--apex-accent)]` | |
| `#101014` canvas fill | `--apex-canvas` via seam | |
| `#222228`, `#1e1e24`, `#383842` grid | `--apex-grid-line`, `--apex-grid-line-strong` via seam | |
| `#555560` axis labels | `--apex-text-3` via seam | |
| `rgba(255, 110, 0, 0.15)` spectrum | per-mode, `rgba(255,110,0,.15)` Dark / `rgba(154,93,0,.15)` Light | Seam |
| `#ff6e00` response curve | per-mode, `#ff6e00` Dark / `#9a5d00` Light | Seam |
| `#ffffff` / `#000000` node rings | per-mode | Seam |
| `#ffffff` node number | `#000000` in both modes | Seam — the one Dark delta |
| `bg-black/80` overlay | `ModalFrame`'s `apex-modal-overlay` (already applied) | Rendered scrim unchanged |

## Deliberate visual changes

There are three, all measured, all forced by a floor rather than by taste:

1. **Node number `#ffffff` → `#000000` in both themes (the only Dark delta).** `main` painted white inside the node: 2.85:1 on the low band's `#e67e22`, 2.10:1 on the mid band's `#2ecc71`, 3.15:1 on the high band's `#3498db` — all below the 4.5:1 a 9 px bold label needs, in Dark as well as Light. Black measures 7.37:1 / 9.99:1 / 6.66:1 on the same three fills. In Dark the band fills are painted exactly as stored, so the EQ's colour language is preserved there and only the number painted on top of them moved. Light paints a display mapping of those fills — see *Band display colours* below, including the effect on this row.
2. **`Done` label.** White on the accent fill was 2.83:1 in Dark on `main`; `--apex-state-playing-fg` makes it 6.77:1.
3. **Light node rings.** The shipped `#ffffff` selected ring measures 1.08:1 on the Light canvas and would be invisible, so Light takes `--apex-accent` (5.32:1) for the selected ring and `--apex-text` (15.12:1) for the unselected one. This keeps Dark's two-colour selection cue alive instead of collapsing it to one invisible ring.

The unselected ring is the one place the two themes are deliberately **not** symmetric. Dark keeps `#000000` even though it measures 1.18:1 on the Dark canvas: there the handle is located by its fill (6.22:1 / 8.44:1 / 5.62:1) and the ring is only an edge treatment. On the Light canvas the *stored* fills measure 2.63:1 / 1.94:1 / 2.91:1 — below the 3:1 non-text floor — so when this migration first themed the canvas the ring was the only thing left to locate a handle. The mapped Light fills described next now clear 3:1 as well, so the ring is a reinforcement rather than the sole boundary; Dark's asymmetry is unchanged. Both facts are asserted in `parametricEqTheme.test.ts`.

### Band display colours (UI-03G fix 2)

**What regressed, and why this PR caused it.** On `main` the canvas painted a hardcoded `#101014` in *both* themes, so the stored band colours measured 6.66 / 9.03 / 6.02:1 even in Light — because in Light they sat on a dark well inside a light modal. Theming that well to `--apex-canvas` (`#f4f6fa`) dropped the same stored colours to **2.63 / 1.94 / 2.91:1**, all below the 3:1 non-text floor. That regression was introduced by this migration, not inherited, so it is fixed here rather than documented as a pre-existing limitation.

**The fix.** `EQ_BAND_DISPLAY_COLORS` in the seam maps each stored colour to a Light display colour, applied consistently to **both** display surfaces — the canvas node fill (`ctx.fillStyle = palette.bandFill(b.color)`) and the band card's swatch (`backgroundColor: eqPalette.bandFill(b.color)`). `band.color` itself is never rewritten: it stays in project state and in the persisted file, and `EQ_BAND_SPECS` is untouched. Dark's map is empty, so Dark paints the stored colour unchanged. A colour the map does not know falls through untouched, so a legacy or hand-edited band can never vanish.

| Band | Stored (`band.color`) | Light display | Light canvas `#f4f6fa` | Dark canvas `#151821` |
| --- | --- | --- | --- | --- |
| Low shelf | `#e67e22` | `#c26147` | 2.63 → **3.81** | 6.22 → 4.30 *(not painted)* |
| Mid bell | `#2ecc71` | `#1f8a4d` | 1.94 → **4.04** | 8.44 → 4.05 *(not painted)* |
| High shelf | `#3498db` | `#227fbe` | 2.91 → **4.00** | 5.62 → 4.09 *(not painted)* |

The Dark column is shown only to demonstrate that a flip reaching one surface a frame early cannot hide a band; Dark paints the stored values (6.22 / 8.44 / 5.62:1) exactly as before.

**Distinctness.** Contrast alone cannot show that the three remain separable — darkening all three to the same floor equalises their luminance, so hue carries the difference. CIE76 ΔE of the Light set is 80.9 / 83.5 / 76.1 pairwise (stored: 98.7 / 112.3 / 94.2), against a ~20 threshold for a plainly visible difference. Against the Light response curve `#9a5d00` they measure ΔE 28.1 / 69.6 / 96.8 — better than the shipped Dark pairing of `#e67e22` on `#ff6e00`, which is only ΔE 19.5. The low band takes a 15° hue shift (28° → 13°) to buy that last separation: a sweep of its own hue found no darkening that both reaches 3:1 and stays ΔE 20 clear of the gold curve. Mid and high shift ≤1° in hue.

**Repainting both surfaces.** The canvas re-reads the palette inside its `requestAnimationFrame` callback, so it follows a flip for free. A DOM swatch cannot, so the modal now subscribes to the `data-theme` attribute the appearance switch writes and re-renders, disconnecting the observer on unmount. Verified in a real DOM: dark swatches `rgb(230,126,34) rgb(46,204,113) rgb(52,152,219)` → after flipping `data-theme` to `light`, `rgb(194,97,71) rgb(31,138,77) rgb(34,127,190)`, with `EQ_BAND_SPECS` unchanged.

## Tests

| Layer | File | What it proves |
| --- | --- | --- |
| Unit (seam) | `src/components/parametricEqTheme.test.ts` (26 tests) | Graph chrome follows the four theme tokens; the Dark curve, spectrum and node rings are the exact shipped literals; Light takes `--apex-gold`; the curve clears 3:1 in both themes; axis labels clear AA in both themes; the band number clears AA on all three real `EQ_BAND_SPECS` fills in both themes; the selected ring clears 3:1 in both themes; the Dark fills still clear 3:1 with the shipped ring preserved; Dark maps no band colour; every Light mapping clears 3:1 on the Light canvas *and* on the Dark canvas; the stored colours would have failed 3:1 in Light; the three Light colours stay ΔE ≥ 20 apart and ≥ 20 clear of the curve; unknown colours fall through; matching is case-insensitive; the mapping follows a flip without mutating the stored value; no stale palette after a flip; cache identity; per-document caches; no-DOM and missing-token fallbacks. |
| Unit (markup/source) | `src/components/parametricEqThemeUi.test.tsx` (15 tests) | Full dialog renders, including all three gain-sign branches and the published slot readouts; only the selected band's filter type is named; no colour literal or white/black/palette utility in any class attribute; chrome uses the expected `var(--apex-…)` tokens; the gain signs use the success/danger pair; `Done` uses its on-accent label and strong hover; the overlay is supplied by `ModalFrame`; the frame callback reads the palette and the loop is still cancelled; the canvas node and the band swatch both read `bandFill` and neither paints the raw stored colour; exactly one `MutationObserver` exists, it watches `data-theme` and is disconnected; the rendered swatches come from the seam; the source has no literal colour; the coordinate mapping, hit-test radius, publication call, control ranges, `aria-label` and Phase 52 copy are all still present; renders nothing while closed; renders flat for a track with no insert. |
| Real browser | `browser-tests/parametricEqTheme.spec.ts` (5 tests) | Dark and Light: every visible text node reaches AA against its composited background; the overlay computed colour is the shared token; the canvas background, grid and curve are this theme's and the other theme's grid and curve are absent at zero pixels; a preset plus a gain-slider edit keeps every control at AA; a live theme flip repaints the open graph in both directions with no stale Dark pixels. |

Negative controls (both run in this sandbox):

- **Reverting the component** — the shipped hardcoded canvas palette restored and `text-white` put back on the title — makes **3 of 12** markup tests fail (`carries no colour literal…`, `paints the canvas from the palette seam…`, `contains no colour literal… in the component source`). The other 9, which assert rendering and EQ behaviour, correctly stay green, so the suite discriminates rather than passing wholesale.
- **Forcing the Light curve back to `#ff6e00` in the seam** makes **4 of 19** seam tests fail (Light gold value, 3:1 curve floor, stale-palette, missing-token fallback).
- The seam suite also asserts the *shipped* values against each floor as embedded negative controls: `#ff6e00` on the Light canvas (2.59:1 < 3), `#555560` on the Dark canvas (2.41:1 < 4.5), `#ffffff` on every band fill (< 4.5 on all three), `#ffffff` on the Light canvas (1.08:1 < 3).

## Results (actual, this sandbox)

| Check | Result |
| --- | --- |
| `npm run lint` (`tsc --noEmit`) | pass |
| `npm run verify:test-discovery` | pass (231 files, 0 orphaned) |
| `npm run verify:desktop` | pass |
| `npm run test:shell` | 271/271 |
| `npm run test:history` (includes the 41 new EQ unit tests) | 891/891 |
| `npm run test:audio` | 1676/1676 |
| Focused: `parametricEqTheme`, `parametricEqThemeUi`, `parametricEqPublication`, `modalDialogShell`, `vocalTunerTruthfulness` | 86/86 |
| `npm run build` | pass (1831 modules, `dist/assets/index-DjbE3PQT.css`) |
| Production CSS check | all 23 new token utilities present; `.apex-modal-overlay{background-color:var(--apex-modal-overlay)}` ships with both theme values |
| `npx playwright test browser-tests/parametricEqTheme.spec.ts` | **cannot run here — see Known limitations**; every assertion in it was executed against real pixels in a jsdom + Skia harness, all passing in both modes |

The Playwright suite runs in CI (`Apex Studio CI` and `Audio Validation` both install Chromium and run `npx playwright test`), so the spec executes on this PR. Because no browser can be launched in this sandbox, the spec's own assertions were replayed against real rendered pixels: the shipped `ParametricEqModal` was mounted in jsdom with `@napi-rs/canvas` backing every `getContext('2d')`, so the component's actual paint code produced a real bitmap that was then histogrammed with the spec's exact tolerances. In both modes the results are — `top` equals this theme's canvas, 92.4% coverage, `curveCount` 1376 (dark) / 1374 (light), `gridCount` 5471 / 5241, the other theme's `curveCount` 0, the other theme's `gridCount` 1 / 11 against a bound of `own / 100`, each band node 36–92 px in this theme's display colour, and in Light zero pixels of any stored colour.

### The failing assertion, diagnosed from real output

The first push of this PR failed both `Apex Studio CI` and `Audio Validation` at `npx playwright test`. The failing assertion is:

```
expect(otherReport.gridCount, "the other theme's grid colour is absent").toBe(0)
```

in `browser-tests/parametricEqTheme.spec.ts` — the per-mode negative control, with the same strict zero also in the flip test (`stale.gridCount`). Replaying the spec's assertions against real pixels shows the actual values are **1 px in Dark and 9 px in Light** (11 px in Light after the band mapping landed), not 0.

The cause is antialiasing, not a wrong-theme repaint. The control counts pixels within ±6 of the *other* theme's `--apex-grid-line`, and that box also catches soft edge pixels of this theme's own node rings:

- Dark contributes 1 px at (505, 140) = `rgb(234, 235, 235)`, an antialiased edge of Dark's **white selected-node ring** `#ffffff`, landing inside ±6 of Light's grid `#e5e9f0` (229, 233, 240). Its 3×3 neighbourhood is pure `255, 255, 255`, so it is edge, not fill.
- Light contributes 9 px around `rgb(35, 43, 56)`, antialiased edges of Light's `--apex-text` unselected ring `#18202d` (24, 32, 45) — only Δ(12, 9, 9) from Dark's grid `#242936` (36, 41, 54).

Tightening the tolerance cannot fix this: at ±2 Light still contributes 1 px, at ±3 5 px, at ±4 7 px — and the Light count *grows* as the tolerance grows, so no threshold separates the artifact from a real signal. The control is therefore expressed as a **ratio** instead: `other.gridCount < own.gridCount / 100`, with `own.gridCount > 1000` asserted first. Measured: 1 vs 5471 (0.018%) in Dark and 11 vs 5241 (0.21%) in Light. A canvas that really was painted in the wrong theme would score close to 100%, so this is a far stronger control than a literal zero and cannot be tripped by antialiasing. The other negative controls stay strict — `other.curveCount === 0` measures exactly 0 in both modes and was left alone, and `other.top !== otherCanvas` is unchanged.

The same reasoning applies to the new band-colour control, and there the asymmetry is kept deliberately: Light asserts that **zero** pixels of any stored colour remain (that is the regression being fixed, and it measures 0/0/0), while Dark does not assert the reverse, because Light's mid display colour `#1f8a4d` lies almost exactly on the blend path from `#2ecc71` to the Dark canvas and the Dark node's antialiased rim passes through it, contributing ~2 px.

## Contrast evidence

Computed in Node from the real `src/index.css` token values, with the legacy compatibility mapping applied to the `main` column exactly as the cascade applies it (which is why `#888` reads as `--apex-text-2` and `#ff6e00` as `--apex-accent` there). AA is 4.5:1 for text, 3:1 for non-text.

### Text and controls

| Element | `main` Dark | `main` Light | UI-03G Dark | UI-03G Light |
| --- | --- | --- | --- | --- |
| Title | 17.02 | **1.00** | 14.22 | 13.69 |
| Band card "Band N" | 17.02 | **1.00** | 12.97 | 13.81 |
| Band card frequency | 8.27 | 7.89 | 6.87 | 6.66 |
| Gain, positive | 8.10 | **2.10** | 7.93 | 4.93 |
| Gain, negative | 4.45 | **3.82** | 4.79 | 5.07 |
| Gain, flat | 8.27 | 7.89 | 6.87 | 6.66 |
| Slider readout (value) | 15.48 | **1.08** | 14.20 | 15.12 |
| Slider label | 7.52 | 7.29 | 7.52 | 7.29 |
| "Studio Mastering Profiles:" | 15.48 | **1.08** | 14.20 | 15.12 |
| Preset chip label | 14.14 | **1.18** | 12.97 | 13.81 |
| Track badge | 5.40 | **1.94** | 5.00 | 4.85 |
| `Done` label | **2.83** | 5.75 | 6.77 | 5.75 |
| Filter-type readout | 17.72 | 17.72 | 16.26 | 15.12 |
| "Fixed by the insert's signal chain." | 5.13 | 5.24 | 5.13 | 5.24 |
| Subtitle / footer / close glyph | 8.27 | 7.89 | 7.53 | 6.59 |

`main` failed AA on **9 of 15** measured text elements — eight in Light (three at 1.00–1.18:1, i.e. white text on a surface the compat layer had just turned white) and one in Dark. UI-03G's minimum across the same set is **4.79:1** (Dark) and **4.85:1** (Light).

### Canvas (3:1 for graph elements, 4.5:1 for painted text)

| Element | `main` Dark | `main` Light | UI-03G Dark | UI-03G Light |
| --- | --- | --- | --- | --- |
| Response curve on canvas | 6.76 | 6.76 (on a dark well inside a light modal) | 6.32 | 4.93 |
| Axis labels | **2.58** | **2.58** | 5.88 | 5.24 |
| Band number on low fill `#e67e22` | **2.85** | **2.85** | 7.37 | 7.37 |
| Band number on mid fill `#2ecc71` | **2.10** | **2.10** | 9.99 | 9.99 |
| Band number on high fill `#3498db` | **3.15** | **3.15** | 6.66 | 6.66 |
| Selected node ring | 18.98 | 18.98 | 17.73 | 5.32 |
| Band fill (low) vs canvas | 6.66 | 6.66 | 6.22 | **3.81** † |
| Band fill (mid) vs canvas | 9.03 | 9.03 | 8.44 | **4.04** † |
| Band fill (high) vs canvas | 6.02 | 6.02 | 5.62 | **4.00** † |
| Frequency grid | 1.20 | 1.20 | 1.22 | 1.13 |
| 0 dB reference | 1.64 | 1.64 | 1.56 | 1.43 |

† Light paints the display mapping (`#c26147` / `#1f8a4d` / `#227fbe`), not the stored colour; the stored values on this canvas are 2.63 / 1.94 / 2.91:1, which is the regression this PR introduced and fixed — see *Band display colours*. Dark paints the stored colours unchanged. The grid lines are decorative and sit where the shipped ones sat.

The three band-number rows above are measured on the **stored** fills. On the Light display colours the black number measures 5.09 / 4.80 / 4.85:1 — still above the 4.5:1 a 9 px bold label needs, so the mapping does not cost the number its margin. This is asserted in `parametricEqTheme.test.ts`.

## Known limitations and coverage gaps

1. **The Playwright spec was not executed in a real browser here.** Chromium cannot be downloaded in this sandbox — `npx playwright install chromium` fails at the download step because the Playwright CDN is not on the sandbox's network allowlist, and no preinstalled browser can start (no NSS/ATK, no Xvfb, and the Electron `dist/` is empty). What was verified instead: `tsc --noEmit` covers `browser-tests/parametricEqTheme.spec.ts` and passes; all eight colour/scrim constants in the spec were diffed against the real `src/index.css` token blocks and match exactly (`#151821`, `#f4f6fa`, `#242936`, `#e5e9f0`, `#ff6e00`, `#9a5d00`, `rgba(5, 7, 12, 0.66)`, `rgba(24, 32, 45, 0.55)`); every selector it uses (`#fl-tools-menu-btn`, `#fl-master-eq-btn`, `#parametric-eq-modal-overlay`, `#parametric-eq-modal-title`) was confirmed present in source; and **every assertion in the spec was replayed against real rendered pixels** by mounting the shipped component in jsdom over `@napi-rs/canvas`, which is how the failing grid control above was diagnosed from measured values rather than assumed. What that harness cannot reproduce is Chromium's own text rasterisation and compositing, so the *composited* text contrast figures below remain arithmetic, not screenshot-measured. CI is still the authority on whether the spec passes in a browser.
2. **Resolved in this PR: the Light band fills measured below 3:1.** This was the regression the migration introduced — theming the canvas well from the hardcoded `#101014` to `--apex-canvas` dropped the stored colours from 6.66 / 9.03 / 6.02:1 to 2.63 / 1.94 / 2.91:1. It is fixed by the display-colour mapping (3.81 / 4.04 / 4.00:1) described above, applied to both the canvas node and the band card's swatch.
3. **Improved as a side effect, but the gap is not fully closed: the band-card swatches.** Because the swatch now reads the same mapping, Light's swatches improve on both card backgrounds — on the unselected card (`--apex-surface`, `#ffffff`) 2.85 / 2.10 / 3.15:1 for the stored colours becomes **4.12 / 4.37 / 4.33:1**, and on the selected card (`--apex-surface-3`, `#e8ecf3`) 2.40 / 1.77 / 2.66:1 becomes **3.48 / 3.69 / 3.66:1**. Every swatch now clears 3:1 in Light, where previously none did on the selected card and only the high band did on the unselected one. What remains genuinely open, and is *pre-existing rather than introduced here*: the mapping is keyed to the three shipped colours, so a project that hand-edits `band.color` to some other light value gets it passed through by design (unknown colours must not vanish) and can still be low-contrast. Dark's swatch contrast is unchanged by this PR.
4. **Pre-existing, deliberately preserved: Dark's unselected node ring is `#000000` at 1.18:1** on the Dark canvas (1.11:1 on `--apex-surface`). Dark locates its handles by fill, so the ring is an edge treatment; changing it would be a Dark-mode visual change outside this phase's remit.
5. **The spectrum fill is not asserted in the browser spec.** With no audio playing, `getMasterFrequencyData` leaves the array at zero, so the trace is flat and paints no area. The spectrum colour is covered at the seam level instead.
6. **Pre-existing, untouched:** the canvas bitmap is 800×260 but is CSS-stretched to the container width, while the mouse handlers map `clientX - rect.left` without scaling — so hit-testing and dragging are offset whenever the container is not exactly 800 px wide. `ctx.textAlign`/`textBaseline` are set inside the node loop and never reset, so axis labels are centred from the second frame on. Both are rendering behaviour on `main`, unrelated to theming, and changing either would be a behaviour change this phase must not make.
