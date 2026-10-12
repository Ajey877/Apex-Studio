# UI-03D — Wavetable Preview Light/Dark Theme Migration

Scope: `WavetableSynthModal` only (one modal per PR, as chosen for Phase B).
Follows the UI-03B (Mastering) and UI-03C (Mixer) pattern: semantic tokens for chrome, a per-mode palette seam for the canvas, and intentional signal colours kept as constants per mode.

Not in scope: `AudioRecorderModal`, `AudioSlicerModal`, `ParametricEqModal`. Each still needs its own pass.

## Starting state (measured, before this change)

Measured in Chromium on the unchanged modal (`browser-tests/wavetableTheme.spec.ts`, computed colour against the composited background):

| Theme | Result |
| --- | --- |
| Dark | Text passes AA. The canvas paints a literal `#0a0a0d`, not a token. |
| Light | **22 text nodes below WCAG AA.** Worst: the title, section labels and harmonic values use hardcoded `text-white` on light surfaces, at **1.08–1.20:1**. Cyan and muted labels measured 3.0–4.2:1. |

Root cause: the legacy compatibility layer in `index.css` maps `bg-[#18181c]` and `bg-[#121214]` to the light panel tokens in Light, while the modal's own `text-white` stays white.

## What changed

1. **`src/components/wavetableTheme.ts` (new).** The palette seam:
   - The waterfall background is read from `--apex-canvas` through the shared `canvasThemeTokens.ts` resolver.
   - The waveform and selected-frame colours are per-mode constants.
   - Dark keeps the shipped literals. `waveFrameStroke` in Dark produces a string byte-identical to the legacy `rgba(0, 229, 255, …)`, verified by a unit test over 17 frame positions.
   - Light uses `--apex-cyan` (`#087da8`) for the waveform and `#9a5d00` (`--apex-gold`) for the selected frame.
   - The palette is cached per (document, mode) and re-read every animation frame.
2. **`src/components/WavetableSynthModal.tsx`.** Every colour literal in the component is replaced with a semantic token class. The file now has zero hex literals, zero `text-white`/`text-black`/`bg-black` utilities, and no `rgba()`. The canvas background and strokes come from the seam. Layout, state, handlers, and copy are unchanged.
3. **`src/index.css`.** One new text-only token, `--apex-cyan-text`, following the `--apex-aux-text` precedent from UI-03C-fix. Dark = `#67d9ff` (same as `--apex-cyan`, so Dark text is unchanged). Light = `#065775`. The decorative `--apex-cyan` is unchanged. Light `#087da8` as text only reached 3.0–4.3:1 on the light panel. `#065775` clears 4.5:1 on the panel header, the cards, the well, and the translucent cyan badge and preset washes (computed worst case 5.22:1).
4. **`src/state/modalDialogShell.test.tsx`.** The shared modal shell test pinned this modal's old overlay class string verbatim. I updated that one case to the new overlay string, with a comment. This mirrors the Settings dialog's UI-03A change to `apex-modal-overlay`. The assertion was not weakened: it still requires the overlay classes verbatim and the shared scrim primitive.
5. **`package.json`.** The two new unit test files are added to `test:history`, next to the Mixer theme tests, so `verify:test-discovery` covers them.

## Tests

| Layer | File | What it proves |
| --- | --- | --- |
| Unit (seam) | `src/components/wavetableTheme.test.ts` (13 tests) | Background follows the theme token; Dark signal colours are the exact literals; Dark frame strings are byte-identical to the legacy output; the Light selected frame is ≥3:1 on the canvas; the strongest Light inactive frame is ≥3:1 once composited; Light cyan text is ≥4.5:1 on every surface including the washes; Dark cyan text equals the decorative Dark cyan; no-DOM and missing-token fallbacks; no stale palette after a flip; cache identity. |
| Unit (markup) | `src/components/wavetableThemeUi.test.tsx` (7 tests) | Full dialog renders; no colour literal or white/black utility in any class attribute; chrome uses the expected `var(--apex-…)` tokens; overlay uses the shared scrim; the draw loop paints from the seam; component source has no hex literal; preview-only truth copy unchanged. |
| Real browser | `browser-tests/wavetableTheme.spec.ts` (5 tests) | For Dark and Light: every visible text node in the dialog reaches AA against its composited background (47 nodes each); the canvas corner pixel equals the theme background; the exact selected-frame RGB appears in the bitmap. A live theme flip repaints the open canvas with no reload. Reopening after a Settings switch shows the current palette. Visible text and control count are identical across themes. |

## Results (actual, this sandbox)

Browser text contrast after the change:

| Theme | Text nodes | Minimum contrast | Lowest element |
| --- | --- | --- | --- |
| Dark | 47 | **5.13:1** | "Preview curve only — no audio is generated from it." |
| Light | 47 | **4.66:1** | "Audition C3" (white on Light cyan) |

Before the `--apex-cyan-text` token, 8 Light elements failed. All of them were cyan text, and the failures went away when the token was added. The Light AA test was then run as a **negative control**: with `--apex-cyan-text` set back to the decorative `#087da8`, the test failed. With the real value restored, it passed.

Validation (`/home/user/tools/final.log`, final run after all edits):

| Check | Result |
| --- | --- |
| `npm run lint` (`tsc --noEmit`) | ✅ pass |
| `npm run verify:test-discovery` | ✅ pass |
| `npm run verify:desktop` | ✅ pass |
| `npm run test:history` (includes the 11 + 7 new tests) | ✅ pass |
| `npm run test:audio` | ✅ pass |
| `npm run test:metering` / `test:shell` / `test:effects` / `test:truth` / `test:desktop-permissions` | ✅ pass |
| `npm run test:playlist-geometry` | ❌ fails **6/6, identically on the untouched base branch** (pre-existing; not caused by this change) |
| `npm run build` | ✅ pass |
| `npx playwright test` | ✅ **36/36** (31 existing + 5 new Wavetable) |

Visual check: `assets/screenshots/ui03d-wavetable-dark.png` and `ui03d-wavetable-light.png` were captured from the real browser and reviewed. Both themes read clearly.

## Dark-theme deltas (deliberate, please review)

Dark is not pixel-identical. The chrome moves to the Midnight Aurora tokens, as the Mixer and Mastering migrations did:

- Modal scrim: literal `bg-black/85` becomes `--apex-modal-overlay` (Dark `rgba(5,7,12,0.66)`), a lighter scrim.
- Waterfall background: literal `#0a0a0d` becomes `--apex-canvas` (`#151821`).
- Dialog panel: `#121215` becomes `--apex-surface` (`#191c25`). Other card and header surfaces move to their tokens.
- Primary button hover: `#33edff` becomes `brightness-110`.

Unchanged in Dark: the waveform stroke and selected-frame colours (exact literals, verified byte-for-byte in unit tests), all text colours that already passed AA, and every label, control, and state.

## Behaviour explicitly untouched

Audio, the audition path (`audioEngine.playNote`), channel updates, preset handling, the preview-only truth copy ("NOT APPLIED", "PREVIEW ONLY"), ModalFrame focus and Escape handling, and the modal id and title wiring. No project data is read or written by this change.

## Known limitations

1. **Faint depth frames are decorative and below 3:1.** The inactive waterfall frames fade toward the back. The faintest is about 1.3:1 in Dark and about 1.5:1 in Light. The selected frame and the strongest inactive frames carry the information, and those meet the non-text threshold. I did not raise the faintest frames, because that would change the depth effect.
2. **Canvas repaint is verified by pixels, not by eye during playback.** The preview produces no audio, so there is nothing to drive the waveform beyond its own animation.
3. **Other canvas modals are not migrated** (`AudioRecorderModal`, `AudioSlicerModal`, `ParametricEqModal`).
4. **Windows packaging and the packaged runtime smoke test were not run locally.** They run in CI.
5. **Browser binary.** Playwright's own Chromium download is blocked in this sandbox. The suite ran against Chromium 153 from the `@sparticuz/chromium` npm package, placed at `/tmp/chromium` (the path `playwright.config.ts` already checks). This is an environment detail, not a repo change. CI uses its own browser.

## Next phase

Not started. Remaining canvas modals: `AudioRecorderModal`, `AudioSlicerModal`, `ParametricEqModal`. Each needs its own seam pass and its own PR.
