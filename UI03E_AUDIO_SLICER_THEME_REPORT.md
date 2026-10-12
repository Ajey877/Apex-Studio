# UI-03E — Audio Slicer Light/Dark Theme Migration

Scope: `AudioSlicerModal` only (one modal per PR, as established for Phase B).
Follows the UI-03B (Mastering), UI-03C (Mixer) and UI-03D (Wavetable) pattern: semantic tokens for chrome, a per-mode palette seam for the canvas, and intentional signal colours kept as constants per mode.

Not in scope: `AudioRecorderModal`, `ParametricEqModal`. Each still needs its own pass.

## Starting state (audited, before this change)

The slicer carried **72 hex literals** across 22 distinct values, plus 9 `text-white`, 6 `text-black` and a `bg-black/85` scrim. The canvas painted six hardcoded colours imperatively, with no theme dependency in its effect, so a theme flip never repainted it.

Light mode was broken in a **different way from Wavetable**, and in both directions at once. Only *some* slicer literals are in the `index.css` legacy compatibility layer:

- Backgrounds **in** the layer flipped to light: `bg-[#121214]`→`--apex-canvas`, `bg-[#222225]`→`--apex-surface-2`.
- Backgrounds **not** in it stayed near-black: `#18181b` (header, cards, footer, pads), `#0f0f12`, `#0a0a0c`, `#1e1e24`, `#333338`.
- Muted text **was** in the layer and flipped to light greys: `#777`/`#555`/`#666`→`--apex-text-3` (`#5b6879`), `#888`→`--apex-text-2` (`#465267`).

So muted text went **light** while its surface stayed **dark**, while white text sat on the surfaces that *did* flip. Computed WCAG ratios in Light, measured analytically before any code was touched:

| Element | Ratio |
| --- | --- |
| Select value, "Map to 16 Steps", "Done" (white on a remapped light surface) | **1.08:1** |
| Card labels "TARGET CHANNEL" / "DETECTION MODE" / "THRESHOLD SENSITIVITY" | **2.25:1** |
| Empty-state reason line | **2.51:1** |
| Subtitle, "Fewer Chops"/"Micro Slices", pad duration | **3.12:1** |
| "Click pads below to audition chops" | **3.37:1** |
| AUTO-CHOP badge, sensitivity % (`--apex-cyan` on dark) | **3.80:1** |
| Disc/Grid icons | **4.11:1** |

Roughly 15+ text nodes below AA, several effectively invisible. Dark was largely fine; nearly all failures were Light-only.

## What changed

1. **`src/components/audioSlicerTheme.ts` (new).** The palette seam:
   - The waveform background is read from `--apex-canvas` through the shared `canvasThemeTokens.ts` resolver — no duplicate resolver.
   - The waveform, slice markers and slice badges are per-mode signal constants.
   - **Dark keeps the shipped literals exactly** (`#ff6e00` waveform, `#00e5ff` active marker and badge, `#ffffff` inactive marker, `#222225` inactive badge, black/white badge numbers), pinned byte-for-byte by unit test.
   - Light uses Light semantic values of the same hue families.
   - The palette is cached per (document, mode) and re-read on every repaint.
2. **`src/components/AudioSlicerModal.tsx`.** Every colour literal is replaced with a semantic token class. The file now has zero hex literals, zero `text-white`/`text-black`/`bg-black`, and no `rgba()`. The canvas paints from the seam, and a `MutationObserver` on `<html data-theme>` re-runs the draw function when the theme flips. Layout, state, handlers, audio, and the Phase-52/55 truth copy are unchanged.
3. **`src/state/modalDialogShell.test.tsx`.** The shared modal shell test pinned this modal's overlay class verbatim. That one case is updated to the new overlay string, with a comment, mirroring UI-03D. `OVERLAY_STUDIO` is left intact for the 11 other modals that still use it. The assertion is not weakened: it still requires the overlay classes verbatim and the shared scrim primitive.
4. **`package.json`.** The two new unit test files are added to `test:history`, next to the Wavetable theme tests, so `verify:test-discovery` covers them.

No changes to `src/index.css`: the `--apex-cyan-text` token added in UI-03D already covers the cyan-text cases at 6.68–7.39:1 on every Light surface the slicer uses.

## Tests

| Layer | File | What it proves |
| --- | --- | --- |
| Unit (seam) | `src/components/audioSlicerTheme.test.ts` (14 tests) | Background follows the theme token; every Dark signal colour is the exact shipped literal; every Light signal colour is the Light semantic value; waveform and both markers clear 3:1 on the canvas in both themes; both badge numbers clear 4.5:1 on their fill; Light cyan text clears AA on every surface; the button label clears AA on rest and hover fills in both themes; hover differs from rest; no stale palette after a flip; cache identity; no-DOM and missing-token fallbacks. |
| Unit (markup) | `src/components/audioSlicerThemeUi.test.tsx` (10 tests) | Full dialog renders; no colour literal or white/black utility in any class attribute; chrome uses the expected `var(--apex-…)` tokens; the primary action uses the solid `hover:bg-[var(--apex-cyan-strong)]` fill and no `hover:brightness-` filter; toast text and the active pad duration carry no alpha; overlay uses the shared scrim; the draw loop paints every colour from the seam; the theme-flip observer is wired and cleaned up; component source has no hex literal; Phase 52 truth copy unchanged. |
| Real browser | `browser-tests/audioSlicerTheme.spec.ts` (9 tests) | For Dark and Light, in the **loaded** state (36 text nodes) and the **empty** state (20 text nodes): every visible text node reaches AA against its composited background. Canvas: the dominant bitmap colour is this theme's `--apex-canvas`, the other theme's background is absent, and this theme's waveform RGB is present while the other's is absent. Toast message and ✕ reach AA in both themes, with neutral compositing, and the ✕ still closes the toast. A live theme flip repaints the open canvas in both directions with zero stale pixels. Reopening after a Settings switch shows the current palette. Visible text and control count are identical across themes. |

### Reaching the canvas in a browser

Phase 52 removed the synthesized breakbeat, so with no loaded sample the modal renders its honest empty state and never paints a waveform. To exercise the real canvas path the suite generates a 1-second, 16-bit mono PCM WAV **in memory** (8 decaying hits per second, so the transient detector finds real onsets) and imports it through the product's own Sample Manager file input (`#fl-sampler-modal-btn` → hidden `input[type=file]` → "Assign to Channel"). No audio fixture is added to the repository and no production import path is changed for the test.

The Wavetable suite's corner-pixel probe is **not** safe here: `detectTransients` always emits a slice at time 0, so a marker line is painted at x=0. The background fill still covers the large majority of the bitmap, so the suite reads a full histogram and asserts the most frequent colour, which is deterministic and immune to marker placement.

## Results (actual, this sandbox)

Browser text contrast after the change:

| Theme | State | Text nodes | Minimum | Lowest element |
| --- | --- | --- | --- | --- |
| Dark | loaded | 36 | **5.13:1** | "Fewer Chops" |
| Light | loaded | 36 | **4.66:1** | "Trans" (active mode chip) |
| Dark | empty | 20 | **5.13:1** | "Fewer Chops" |
| Light | empty | 20 | **4.66:1** | "Trans" (active mode chip) |

Status toast, measured against the composited toast fill:

| Theme | Message | ✕ |
| --- | --- | --- |
| Dark | 11.80:1 (`#0d0f16` on `#67d9ff`) | 11.80:1 |
| Light | 4.66:1 (`#ffffff` on `#087da8`) | 4.66:1 |

Canvas, measured from the bitmap:

| Theme | Dominant colour | Waveform |
| --- | --- | --- |
| Dark | `rgb(21, 24, 33)` = `#151821` | `#ff6e00` present |
| Light | `rgb(244, 246, 250)` = `#f4f6fa` | `#9a5d00` present |

Theme flip with the dialog open: dark → light → dark all repaint, with **zero** stale pixels from the previous palette.

### Negative controls

Both new assertions were verified to fail when the fix is reverted:

1. Setting the Light waveform back to the shipped `#ff6e00` made the Light canvas test fail (`countFor(report, expectedWave)` = 0).
2. Restoring `text-white` on the "Done" button reproduced the exact **1.08:1** failure predicted by the audit, in both the loaded and empty states.

## Validation

| Check | Result |
| --- | --- |
| `npm run lint` (`tsc --noEmit`) | ✅ pass |
| `npm run verify:test-discovery` | ✅ pass (227 files, 0 orphaned) |
| `npm run verify:desktop` | ✅ pass |
| `npm run test:history` (includes the two new Slicer unit files, 14 + 10) | ✅ 830/830 |
| `npm run test:audio` | ✅ 1676/1676 |
| `npm run test:truth` | ✅ 85/85 |
| `npm run test:shell` | ✅ 271/271 |
| `npm run test:metering` | ✅ 78/78 |
| `npm run test:effects` | ✅ 27/27 |
| `npm run test:lifecycle` | ✅ 2/2 |
| `npm run build` | ✅ pass |
| `npx playwright test` | ✅ **49/49** (40 existing + 9 Slicer) |

Visual check: `assets/screenshots/ui03e-audio-slicer-{dark,light}.png` and `ui03e-audio-slicer-{dark,light}-empty.png` were captured from the real browser during the suite run.

## Dark-theme deltas (deliberate, approved)

Dark is not pixel-identical. Where a literal was **already** remapped by the legacy compatibility layer, there is **no rendered change**; the token simply makes that mapping explicit. The deltas below are the cases where the literal was *not* in the layer and therefore did render as written.

**Unchanged in Dark — canvas signal colours (exact literals, unit-pinned):**
waveform `#ff6e00`; active marker `#00e5ff`; inactive marker `#ffffff`; active badge `#00e5ff`; inactive badge `#222225`; badge numbers `#000000` / `#ffffff`.

**Unchanged in Dark — already remapped by the legacy layer (now explicit):**
muted text `#b0b0b0`/`#888`→`--apex-text-2` (`#aeb5c4`); `#777`/`#666`/`#555`→`--apex-text-3` (`#8b95a8`); `#00bcd4` text→`--apex-cyan` (`#67d9ff`), including the AUTO-CHOP badge and the sensitivity readout, which now use `--apex-cyan-text` — identical to `--apex-cyan` in Dark; the Zap icon `#ff6e00`→`--apex-accent` (`#9b8afb`); secondary button, "Done" and close-hover fills `bg-[#222225]`→`--apex-surface-2` (`#202430`); `border-[#333336]`→`--apex-border`; the modal scrim (`bg-black/85`→`apex-modal-overlay` — UI-03D verified the unlayered token rule already overrode it, so the rendered scrim is unchanged in both themes).

**Deliberate Dark deltas:**

| Element | On `main` | Now |
| --- | --- | --- |
| Dialog panel (`bg-[#121214]` → canvas) | `#151821` | `--apex-surface` `#191c25` |
| Header and footer (`#18181b`) | `#18181b` | `--apex-panel-header` `#1f2431` |
| Control cards, pad rest (`#18181b`) | `#18181b` | `--apex-surface-2` `#202430` |
| Waveform well (`#0f0f12`) | `#0f0f12` | `--apex-bg` `#11131a` |
| Canvas background (painted) | `#0f0f12` | `--apex-canvas` `#151821` |
| Canvas CSS fill, empty-state well (`#0a0a0c`) | `#0a0a0c` | `--apex-canvas` `#151821` |
| Borders (`#28282b`, `#2e2e32`) | `#28282b`, `#2e2e32` | `--apex-border` `#2b3040` |
| Hover fills (`#1e1e24`, `#333338`) | `#1e1e24`, `#333338` | `--apex-surface-3` `#262b38` |
| Title and body text (`text-white`) | `#ffffff` | `--apex-text` `#f4f5f8` |
| On-cyan labels (`text-black`) | `#000000` | `--apex-state-playing-fg` `#0d0f16` |
| Primary fill, chip active, pad active, toast | `#00bcd4` | `--apex-cyan` `#67d9ff` |
| Primary hover | `#00acc1` | `--apex-cyan-strong` `#71efff` |
| Pad active border | `#00e5ff` | `--apex-cyan-strong` `#71efff` |
| Header icon gradient | `#00bcd4` → `#00e5ff` | `--apex-cyan` → `--apex-cyan-strong` (`#67d9ff` → `#71efff`) |
| AUTO-CHOP badge wash | `#00bcd4` @ 20% | `--apex-cyan` @ 20% |
| Range accent | `#00bcd4` | `--apex-cyan` `#67d9ff` |
| Range track, select, inactive chip (`bg-[#121214]` → canvas) | `#151821` | `--apex-surface` `#191c25` |
| Empty-state warning (`#ffaa00`) | `#ffaa00` | `--apex-gold` `#ffb86b` |
| Toast ✕ | `text-black` @ 80% | `--apex-state-playing-fg`, full strength |

## Light-theme deltas (deliberate, approved)

Light was unusable before this change, so these are repairs rather than cosmetic moves. The two failure modes:

- **White text on surfaces that flipped light.** The select value, "Map to 16 Steps" and "Done" were `text-white` on fills the legacy layer had already turned light, measuring **1.08:1**. All now use `--apex-text` (`#18202d`).
- **Muted text that flipped light on surfaces that stayed dark.** Card labels measured **2.25:1** and the empty-state reason line **2.51:1**. All surfaces now use the token scale, so text and background move together.

Specific Light decisions:

- **Primary button and chip labels change from black to white.** On `main` they were `text-black` (`#000`) on the `#00bcd4` fill. They now use `--apex-state-playing-fg`, which is `#ffffff` in Light. White on `#087da8` is 4.66:1 at rest and 5.27:1 on the Light hover fill.
- **Primary fill changes from `#00bcd4` to `--apex-cyan` (`#087da8`)**, hover to `--apex-cyan-strong` (`#07749c`). On `main` the hover was `#00acc1`.
- **The canvas stops being a dark hole.** It was painted a literal `#0f0f12` in every theme; it now follows `--apex-canvas` (`#f4f6fa`), and a theme flip repaints it.
- **The Light waveform colour changes.** The shipped `#ff6e00` measures **2.59:1** on the Light canvas, below the 3:1 non-text floor. Light now uses `--apex-gold` (`#9a5d00`, **4.93:1**). Dark keeps `#ff6e00` exactly.
- **The Light inactive slice marker changes.** The shipped `#ffffff` measures **1.08:1** on the Light canvas — invisible. Light now uses `--apex-text-2` (`#465267`, **7.29:1**). Dark keeps `#ffffff`.
- **The Light active marker and badge use `--apex-cyan` (`#087da8`, 4.30:1)**, above the 3:1 non-text floor.
- **The empty-state warning changes from `#ffaa00` to `--apex-gold` (`#9a5d00`)** — the old amber measures 1.76:1 on the Light canvas.
- **Toast fill becomes `--apex-cyan` (`#087da8`)**, label and ✕ white, and the ✕ is now full strength rather than 80% alpha (the same class of defect UI-03D found at 3.56:1).

## Behaviour explicitly untouched

Slice detection and the `AudioSlicer` algorithms; slice audition (`playSlice`, gain 0.9, `source.start(now, startSec, dur)`); the Phase 55 chop publisher and both publication paths; channel updates; the sensitivity and detection-mode controls and their disabled states; `ModalFrame` focus and Escape handling; the modal id, title and close label. No project data is read or written by this change.

## Known limitations

1. **The faint Dark inactive badge is decorative and below 3:1.** The Dark inactive badge fill `#222225` on the `#151821` canvas is a very low-contrast chip, as it was on `main`. It is preserved deliberately as a shipped signal colour. **No test asserts it.** The badge *number* drawn on it is `#ffffff` and clears AA at 17.7:1; the active badge carries the state.
2. **Canvas repaint is verified by pixels, not by eye.** The suite reads the bitmap histogram; I could not visually inspect the captured screenshots, so the confirmation is the measured pixel data rather than a human look at both renders.
3. **The browser run depends on the Sample Manager import path.** The canvas tests import a generated WAV through that modal. If the import workflow changes, those tests need updating. The empty-state tests do not depend on it.
4. **The `disabled:opacity-40` on controls is unchanged** and was not measured: those controls are disabled in the empty state, and the suite measures legible text on enabled controls. Disabled-label contrast was already out of scope in UI-03D.
5. **Windows packaging and the packaged runtime smoke test were not run locally.** They run in CI.
6. **Browser binary.** Playwright's own Chromium download is blocked in this sandbox. The suite ran against Chromium 153 from the `@sparticuz/chromium` npm package, installed to `/tmp` only and **not** added to `package.json`, placed at the `/tmp/chromium` path `playwright.config.ts` already checks. This is an environment detail, not a repo change. CI uses its own browser.

## Next phase

Not started. Remaining canvas modals: `AudioRecorderModal`, `ParametricEqModal`. Each needs its own seam pass and its own PR. Separately, 16 modals still carry the legacy `bg-black/85` scrim string; those are chrome-only and can be swept separately from the canvas seams.
