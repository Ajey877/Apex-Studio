# UI-03C — Mixer Light/Dark Theme Migration

**Baseline:** `main` @ `0b0ece84b03f451c77d31f737126f94155b5713f` (verified by `git fetch` at the start of the phase; equal to `origin/main` and to the branch base)
**Branch:** `arena/af2b701f-apex-studio`
**Scope:** `src/components/Mixer.tsx` only for rendering; one shared canvas-token helper (extracted, not duplicated); one new Mixer palette seam; one token addition; focused tests; screenshots; this report. No audio, routing, persistence or other modal was touched.

---

## Verification of the starting state

Re-checked against the code rather than the older audit:

- The Mixer's **interface chrome was already tokenised** (`--apex-canvas`, `--apex-panel`, `--apex-panel-header`, `--apex-surface-2/3`, `--apex-border`, `--apex-text*`, `--apex-accent`, `--apex-state-hover`, `--apex-chrome-inset`, `--apex-danger`, `--apex-success`, `--apex-cyan`). The UI-03A claim that the Mixer is "dark-only" is out of date for its structure.
- Remaining Mixer colour literals before this phase: the aux-send violet `#7e57c2` (13 uses across the aux section), the VU gradient `#00ff00 / #ff6e00 / #ff0000`, the master FFT bar gradient (same stops), and the master-fader spectrum backdrop `rgba(0,255,136,0.25)`.
- **The canvases draw no chrome.** The FFT canvas relied on CSS for its background (`clearRect` left it transparent). Its only literal colours are signal colours. The "canvas chrome" requirement is therefore met by painting the background from the palette each frame, so the palette is observable in pixels.
- **Real defect found:** track names are drawn in `track.color`. In Light these fall far below AA on the light strips (measured: `#00ff88` ≈ 1.3:1, `#00e5ff` ≈ 1.5:1, `#ffaa00` ≈ 2.1:1 on `--apex-surface-2`).
- **Real defect found:** the shipped Dark VU green `#00ff00` measures ≈ 1.2:1 against the Light meter track `--apex-chrome-inset` (#e3e8f0), far below the 3:1 non-text contrast a level meter needs.

## What changed

### Surfaces migrated to the semantic token system

| Surface | Before | After |
| --- | --- | --- |
| Aux-send identity (dot, `+ RETURN`, send amount, send value, `+ Add Post-Fader Send`, hover states) | `#7e57c2` literals and `/15 /30 /50` alpha suffixes | `var(--apex-aux)` (new token) and `color-mix(in_srgb, var(--apex-aux) N%, transparent)` |
| Master FFT canvas background | transparent (CSS only) | painted each frame from `--apex-canvas` via the palette |
| Track names | `track.color` verbatim | `track.color` in Dark; in Light, lightness-adjusted only when below AA (see Identity) |
| FX slot controls (`FxParameterControls.tsx`, used only by the Mixer) | 17 literal classes (`#777`, `#ff6e00`, `#1a1a1d`, `#2a2a2d`, `#666`, `#a44`, …) | existing tokens (`--apex-text-3`, `--apex-accent`, `--apex-surface`, `--apex-chrome-inset`, `--apex-border`, `--apex-danger`) |

`Mixer.tsx` and `fxParameterControls.tsx` now contain **zero** colour literals (asserted by source-level tests). Everything else in the Mixer was already on tokens and was left alone.

### New token

`--apex-aux` is added to both palettes in `src/index.css` (two lines):

- Dark `#7e57c2` — the exact shipped Mixer violet, so the Dark identity is unchanged.
- Light `#5b3aa8` — darker so aux labels clear 4.5:1 on the light strip, panel and canvas surfaces (asserted).

### Palette seam (`src/components/mixerTheme.ts`, new)

- `readMixerPalette()` returns the Mixer palette for the document's current `data-theme`. The mode is re-derived on every read; the cache is keyed per document and per mode, so a flip invalidates it on the next read and a reopened Mixer cannot see a stale palette.
- `useMixerPalette()` mirrors the Mastering hook: it watches `data-theme` so the DOM meter and track names update immediately on a theme flip.
- `MIXER_SIGNAL_COLORS` holds the intentional level colours per theme (see Data colours).
- `trackIdentityLabelColor()` implements the Light legibility rule.
- The FFT background and the strip surfaces resolve through tokens.

### Shared canvas-token resolver (`src/components/canvasThemeTokens.ts`, new — extracted)

The `var()`/`color-mix()` resolution logic (`readRawToken`, `readToken` → `readCanvasToken`) lived inside the UI-03B Mastering seam. It was moved here unchanged so the Mixer uses the same rules rather than a second copy. `masteringSuiteTheme.ts` imports it and re-exports the old `MasteringSuiteThemeDocument` type; its public API and all 15 of its seam tests are unchanged and pass.

### Canvas behaviour

- The FFT draw loop reads the palette once per frame (`readMixerPalette()`), fills the background with `--apex-canvas`, and sets gradient stops from the palette.
- The master-fader backdrop reads `spectrumBackdrop` per frame.
- Dimensions (180×20, 28×120), bar geometry, `barWidth` maths, the 16/64-bar counts and the `requestAnimationFrame` cadence are unchanged.
- The `clearRect` on the FFT was replaced by an opaque background fill: visually equivalent to the CSS background it replaces, and it is what makes the palette observable in pixels.

### `src/state/ui04ThemeConsistency.test.ts` (existing test, updated, not weakened)

The UI-04 test pinned the VU gradient literal in `Mixer.tsx`. The literal now lives in the seam, so the assertion now checks the seam's Dark stops are exactly `#00ff00 / #ff6e00 / #ff0000` and that the Mixer draws its meter from `palette.meterGradient`. Coverage is equal or stronger (it also checks the exact Dark gradient string through the seam).

## Intentional data colours — preserved and documented

These must not be generic-token-migrated in future phases.

| Colour | Dark | Light | Why |
| --- | --- | --- | --- |
| VU level gradient (DOM meter) | `linear-gradient(to top, #00ff00 60%, #ff6e00 85%, #ff0000 100%)` — **exact** | `#14734e` → `#9a5d00` → `#bd2638` (= Light `--apex-success` / `--apex-gold` / `--apex-danger`), same stop positions | Signal-level meaning (green/orange/red). Light change is a **measured necessity**: the bright green is ≈1.2:1 on the Light meter track; the Light values reach ≥3:1. |
| Master FFT bar gradient | same stops as the VU | same Light stops | Same signal meaning as the meter. |
| Master-fader spectrum backdrop | `rgba(0, 255, 136, 0.25)` — **exact** | `rgba(20, 115, 78, 0.3)` | Decorative spectrum data under the fader; Light uses the Light success hue for legibility. |
| Track identity (track names) | `track.color` **verbatim** | `track.color` if it clears 4.5:1 on every strip surface; otherwise the same hue with reduced lightness until it does | Identity hue is preserved (asserted to drift ≤ 6°). Precedent: UI-03B band accents. |
| Selected strip / selected accent | `--apex-accent` | `--apex-accent` | Interface selection, not data. |

## Behaviour explicitly untouched

No change to: `applyMixerRoutingSelection`, `applyAuxSendSelection`, aux-send handlers, volume/pan/mute/solo handlers, `computeMixerMeterLevel`, the meter tap (`audioEngine.getMixerTrackPeak`), FX slot handlers, sidechain handlers, `MixerRoutingGraph`, the audio engine, offline export, mastering, persistence, undo/redo. The only logic change is which colour value is painted.

## Tests

### New

- `src/components/mixerTheme.test.ts` (17 tests) — seam unit tests reading the **real** `src/index.css` token blocks: canvas background follows the theme flip with no stale cache; cached while unchanged; reopen never returns the other palette; Dark gradient byte-identical; Light level order and tokens; Light level colours ≥3:1 on the meter track; the untouched Dark green measured as near-invisible on Light (documents why the Light change exists); strip surface RGB incl. `var()` alias resolution; total fallback; track identity exact in Dark; Light ≥4.5:1 for every track colour on every strip surface; hue preserved; legible colours untouched; unparseable values untouched; aux token exact in Dark and AA in Light.
- `src/components/mixerThemeUi.test.tsx` (10 tests) — `renderToStaticMarkup` of the real `Mixer` in Dark and Light with identical props: full console present in both; **no colour literal in any `class` attribute** in either theme; exact Dark VU gradient and light stops in Light; Dark keeps stored track colours, Light uses the legible variant; **visible text, input values, control counts identical across themes**; **tracks state (levels, mute/solo, routing, sends, FX) unchanged by rendering either theme** (JSON snapshot); source guards (zero literals in `Mixer.tsx` and in `fxParameterControls.tsx`, per-frame palette reads, hook wiring).
- `src/components/themeTestDocument.ts` — test-only document double resolving the real token blocks from the live `data-theme`. Shared by the two suites above. It is not a test file, and it is not imported by app code.
- `browser-tests/mixerTheme.spec.ts` (5 tests, real Chromium):
  1. Mixer opens in Dark; FFT canvas bitmap corner pixel equals `#151821`.
  2. Mixer opens in Light; pixel equals `#f4f6fa`; **every track name clears 4.5:1** against its computed strip background (computed styles, not source).
  3. Flipping the theme while the Mixer is open repaints the canvas pixel **without a reload** (a window marker survives).
  4. Leave Mixer → flip theme → reopen: the pixel matches the current theme, in both directions.
  5. Theme switching leaves the Mixer's visible text, control values, strip state and **all persisted `localStorage` (the project) byte-identical**.

### Extended

- `src/state/ui04ThemeConsistency.test.ts` — see above.
- `package.json` `test:history` — adds the two new node suites (so CI's `test:history` runs them).

### Results (actual, this sandbox)

| Check | Result |
| --- | --- |
| `npm run lint` (`tsc --noEmit`) | ✅ pass |
| `npm run build` | ✅ pass |
| `npm run verify:test-discovery` | ✅ pass — 0 orphaned files |
| `npm run test:history` (Mixer routing, history, theme, mastering suites + new tests) | ✅ **776/776** (was 749) |
| `npm run test:audio` (audio, routing, effects, persistence, sends, export) | ✅ 1676/1676 |
| `npm run test:metering` | ✅ 78/78 |
| `npm run test:shell` (theme foundation, shell) | ✅ 271/271 |
| `npm run test:effects` | ✅ 27/27 |
| `npm run test:truth` | ✅ 85/85 |
| `npm run test:pianoroll` | ✅ pass |
| `npm run test:desktop-permissions` | ✅ 6/6 |
| `npm run verify:desktop` | ✅ pass |
| `npx playwright test` (all specs, real Chromium) | ✅ **29/29** — 24 pre-existing + 5 new Mixer tests |
| `npm run test:playlist-geometry` | ❌ **pre-existing on `main`** (identical `hookFailed` on the untouched baseline). Not in any `test:` CI script; unrelated to the Mixer. Left alone. |

Browser: a real Chromium 153 (from the npm-published `@sparticuz/chromium`, extracted outside the repo to `/tmp`), because Playwright's CDN is not reachable from the sandbox. The repo's `playwright.config.ts` runs it unchanged.

### CI

The workflows run `npm install --legacy-peer-deps`, `build`, `lint`, `test:audio`, `test:history`, `verify:desktop`, `npx playwright test`, and Windows-only `package:win`, `package:win:dir` and `smoke:win`. All cross-platform steps were run locally and pass. The Windows packaging and smoke steps need a Windows runner and were **not** run here. GitHub Actions on PR #209 (commit `64424b8`): `verify` ✅, `audio-tests` ✅, `windows-package` ✅ (this covers the Windows packaging and smoke steps that were not run locally). CodeRabbit ✅.

## Screenshots

- `assets/screenshots/ui03c-mixer-dark.png` — Dark, captured by the browser spec.
- `assets/screenshots/ui03c-mixer-light.png` — Light, captured by the browser spec.
- `assets/screenshots/ui03c-mixer-light-after-live-switch.png` — Light after a live flip from Dark, no reload.

Inspected visually: Dark is unchanged in identity (the aux violet, track colours and chrome are the same). Light reads as a light console: white and light-grey strips, readable track names (previously washed-out yellow, cyan and lavender are now darker same-hue variants), and the FX rack, sends and chrome consistent. The FFT and VU meters are idle in headless capture (no playback), so their Light colours are verified numerically (contrast tests) and by the pixel test on the canvas background, not by a live level screenshot.

## Remaining Mixer defects and limitations

1. ~~**Dark aux-send violet is ≈3:1**~~ — **resolved by the UI-03C-fix correction below.** The decorative `--apex-aux` is unchanged; aux-send text now uses `--apex-aux-text`.
2. **Live meter colours in Light are verified by contrast, not by a screenshot under playback**, because the sandbox has no audio output to drive the meters.
3. **The 7-band EQ rack overflows** its card to the right in both themes (the EQ band columns are clipped at the rack edge). This is layout, pre-existing, and outside a colour migration; it was not changed.
4. **Scope of the FX rack.** `FxParameterControls.tsx` (used only by the Mixer's FX slots) was migrated in this phase: its 17 literal classes now use the existing tokens. The Dark capture was re-inspected after the change and is visually unchanged. Other modal bodies listed in UI-03A remain out of scope.
5. `test:playlist-geometry` fails on `main` (see above).
6. Windows packaging and smoke tests were not executed in this sandbox.

## Next phase

Not started, as instructed.


---

## Correction: aux-send text contrast (UI-03C-fix)

**Defect:** the Dark aux-send violet `#7e57c2` was used for both decoration and text. Measured against the real Dark text backgrounds it was 2.83–3.26:1 idle and 2.40:1 on the `+ RETURN` hover wash, below WCAG AA 4.5:1 for the 7–9 px labels.

**Fix (text only; decoration unchanged):**

| Token | Dark | Light | Used for |
| --- | --- | --- | --- |
| `--apex-aux` (decoration, unchanged in role) | `#7e57c2` (exact shipped violet) | `#5b3aa8` | aux identity dot, send slider accent, RETURN/add-send borders and washes |
| `--apex-aux-text` (new, text foreground) | `#af96d9` (same hue, drift 0.5°; lightness 0.55 → 0.72) | `#5b3aa8` (= `--apex-aux`, unchanged Light behaviour) | `+ RETURN` label, send `%` readout, add-send hover text |

`#af96d9` was picked as the lightest-margin same-hue value that clears 4.5:1 on every Dark aux text background (min 4.87:1 at the hover wash, versus 4.51:1 for the bare threshold).

**Measured contrast — real browser (computed colour vs. alpha-composited background, `browser-tests/mixerTheme.spec.ts`):**

| Theme | Label | State | Text | Ratio |
| --- | --- | --- | --- | --- |
| Dark | `+ RETURN` | idle (15% wash over panel) | `rgb(175,150,217)` | **5.77** |
| Dark | `+ RETURN` | hover (30% wash over panel) | `rgb(175,150,217)` | **4.88** |
| Dark | send `%` readout | on send card (`--apex-surface-2`) | `rgb(175,150,217)` | **6.04** |
| Light | `+ RETURN` | idle | `rgb(91,58,168)` | **6.30** |
| Light | `+ RETURN` | hover | `rgb(91,58,168)` | **4.83** |
| Light | send `%` readout | on send card | `rgb(91,58,168)` | **7.42** |

The add-send button's idle label is `--apex-text-3` (already AA, 5.64 Dark / 5.67 Light); its violet appears only on hover, over the plain aux panel, which is covered by the token test below.

**Token-level test (`mixerTheme.test.ts`, values read from `src/index.css`):** `--apex-aux-text` ≥ 4.5:1 on each real aux text background in both themes: aux section (`--apex-panel`), send card (`--apex-surface-2`), FX rack (`--apex-chrome-inset`, resolved through its `color-mix` formula), strip canvas, and the RETURN idle and hover composites. A negative test locks the defect: the old decorative violet fails on every Dark text background.

**Negative control (proof the browser test discriminates):** with `--apex-aux-text` temporarily set back to `#7e57c2`, the Dark browser test fails with `Expected >= 4.5, Received 2.84` on the `+ RETURN` label. The value was then restored and the test passes.

**Markup test (`mixerThemeUi.test.tsx`, Dark and Light):** the identity dot renders `bg-[var(--apex-aux)]`; the slider accent uses `--apex-aux`; the RETURN label, the `%` readout and the add-send hover use `--apex-aux-text`; no text class anywhere in the markup uses `text-[var(--apex-aux)]` or `hover:text-[var(--apex-aux)]`. The decorative aux classes are identical across themes.

**Unchanged:** audio, routing, send amounts and their clamping, aux-send handlers, state, project persistence, and all other Mixer styling. The diff to `Mixer.tsx` is three class-name substitutions on text elements.

**Changed files (this correction):** `src/index.css` (one new token in each palette), `src/components/Mixer.tsx` (three text classes), `src/components/mixerTheme.test.ts` (aux-text contrast tests), `src/components/mixerThemeUi.test.tsx` (decoration vs text markup test), `browser-tests/mixerTheme.spec.ts` (real-browser aux contrast tests, Dark and Light, idle and hover), `assets/screenshots/ui03c-aux-dark.png` and `ui03c-aux-light.png` (new evidence), this report.

**Validation (actual, this sandbox, after the correction):**

| Check | Result |
| --- | --- |
| `npm run lint` | ✅ pass |
| `npm run build` | ✅ pass |
| `npm run verify:test-discovery` | ✅ pass, 0 orphaned |
| `npm run test:history` | ✅ 782/782 (was 776) |
| `npm run test:audio` | ✅ 1676/1676 |
| `npm run test:metering` / `test:shell` / `test:effects` / `test:truth` | ✅ all pass |
| `npm run test:desktop-permissions` / `verify:desktop` | ✅ pass |
| `npx playwright test` (all specs, real Chromium) | ✅ **31/31** (24 original + 5 Mixer theme + 2 aux contrast) |
