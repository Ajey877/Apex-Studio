# UI-03B — Mastering Suite Light/Dark Theme Migration

**Baseline:** `main` @ `71349864511d58da9b242b2aeadaaf060a4c1442` (PR #207, UI-03A theme foundation — verified at the start of this phase, not assumed)
**Branch:** `arena/5baa67ff-apex-studio`
**Scope:** the Mastering Suite only — `src/components/MasteringSuiteModal.tsx`, its two
canvas surfaces, one new palette seam, tests, and this report. No other modal body,
no audio code, no token redesign.

---

## What changed

### Verified baseline figures

The UI-03A report estimated ~207 hardcoded colour literals in
`MasteringSuiteModal.tsx`. A recount at the verified baseline found **221** hex
literals (35 × `#888`, 24 × `#ff6e00`, 19 × `#00ff88`, …). After this phase the
component contains **zero** hex literals; the only colour values inside it are
`var(--apex-…)` token references and palette-seam reads.

### Surfaces migrated to the existing Midnight Aurora tokens

| Surface | Before | After |
| --- | --- | --- |
| Modal panel | `bg-[#121215]`, orange border, `shadow-2xl` | `--apex-surface`, `--apex-border`, `--apex-shadow` |
| Header / footer bands | `#18181c` | `--apex-panel-header` |
| Tab strip / tab group | `#141418` / `#0c0c0e` | `--apex-canvas` / `--apex-chrome-inset` |
| Cards, badges, preset grid | `#18181d`, `#1b1b22`, `#282830`, `#333` | `--apex-surface-2/3`, `--apex-border` |
| Inset readouts (GR row, ISP panel, meter tracks) | `#0a0a0c`, `#0c0c0e` | `--apex-chrome-inset`, `--apex-border` |
| Text steps | `text-white`, `#e0e0e0`, `#888`, `#777`, `#666` | `--apex-text`, `--apex-text-2`, `--apex-text-3` |
| Active tab, header tile, Close CTA, badge | legacy orange `#ff6e00` family | `--apex-accent`, `--apex-accent-strong`, `--apex-state-playing-fg`, `--apex-state-selected(-border)` |
| Master-chain ACTIVE/BYPASSED, path status, compliance verdicts, clipping/headroom, phase meter, solo/mute | `#00d26a`, `#ffaa00`, `#ff0055`, `#00ff88`, `#00ffcc` | semantic `--apex-success`, `--apex-gold`, `--apex-danger`, `--apex-cyan` (green/gold/red meaning preserved, AA-legible in both themes) |
| Hover/selected states | hand-picked darker greys | `--apex-state-hover`, accent borders |
| Sliders | per-control `accent-[#…]` literals | inline `accent-color` from a token or the band palette |

The scrim keeps its verbatim legacy classes (the ModalFrame contract pins them);
the themed scrim comes from the shared `.apex-modal-overlay` primitive exactly as
UI-03A established for every framed dialog.

No new token system was introduced and `src/index.css` was not touched: every
value resolves through the tokens UI-03A already locked for both palettes.

### Canvas rendering

`MasteringSuiteModal` paints two canvases (760×60 master FFT spectrum, 280×140
stereo goniometer) inside a `requestAnimationFrame` loop while the modal is open.

A new seam, `src/components/masteringSuiteTheme.ts`, supplies the palette:

- **Chrome colours** (scope background, grid lines, axes, axis labels, idle
  text) are read from the active document's semantic tokens
  (`--apex-chrome-inset`, `--apex-grid-line`, `--apex-grid-line-strong`,
  `--apex-text-3`, `--apex-text-muted`).
- Tokens that still carry `var()`/`color-mix()` references when declared (Dark's
  `--apex-chrome-inset` is one) are resolved through a hidden probe element
  before reaching the canvas, because a canvas context cannot resolve `var()`
  and would silently ignore such a string.
- The palette is **cached per (document, mode)** and the mode is re-derived from
  `<html data-theme>` on every read, so a theme flip repaints both canvases on
  the next frame — no reload, no stale palette, and reopening the modal always
  reads the current theme. Dimensions, bar geometry, shadow glow and the rAF
  cadence are unchanged.
- The DOM side reads the same seam through a small hook that also observes
  `data-theme`, so inline band colours repaint immediately when the theme
  flips even without a parent re-render.

### Intentional data colours preserved (not tokenised)

- **Mastering band accents** — low `#ffaa00`, mid `#00ff88`, high `#00e5ff` —
  remain the exact legacy literals in Dark. Light keeps each hue (drift ≤ 12°,
  asserted) at a darkened value so band readouts stay legible on light cards.
  These colours are the single source of truth in the seam; DOM inline styles
  and tests read them from there.
- **Spectrum level ramp** (`#00ff88 → #ff6e00 → #ff0055`) and the
  **correlation trace semantics** (coherent/wide/out-of-phase) stay literal in
  Dark — the same treatment UI-03A gave the mixer VU gradient — with readable
  light-theme equivalents for Light.
- Meter *verdict* colours moved onto the themed semantic state tokens, keeping
  their green/gold/red meaning in both palettes.

### Behaviour explicitly untouched

`MasteringProcessor` algorithms, control ranges/defaults/normalisation
(`MASTERING_CONTROL_RANGES` still drives every slider), the live audio graph,
offline export, project persistence (`apex:project`), undo/redo, metering
maths, every `data-control-id`, `aria-*` attribute, and every readout string
asserted by `masteringMeteringUi.test.ts` / `masteringControlsUi.test.tsx`.

## Tests

New, following current conventions:

- `src/components/masteringSuiteTheme.test.ts` (15 tests) — seam unit tests:
  chrome resolves from the active theme's tokens; flipping `data-theme`
  changes the palette on the next read with no reload and no stale cache;
  caching is observable (no repeated computed-style reads); band identities
  exact in Dark / hue-preserving in Light; spectrum/correlation semantics
  intact; probe resolution of `var()`-bearing tokens; total-fallback safety.
- `src/components/masteringSuiteThemeUi.test.tsx` (11 tests) — rendered-markup
  tests (`renderToStaticMarkup`): the suite opens in Dark and Light with its
  full structure; chrome rides the semantic tokens; the markup carries no
  non-band hex literal; band accents survive in both themes; the component
  source contains zero literals; canvas `fillStyle`/`strokeStyle` assignments
  only read the seam, per frame.
- `browser-tests/masteringSuiteTheme.spec.ts` (5 tests) — real-browser checks:
  the suite opens in Dark and Light; surfaces resolve to the correct pixels;
  switching themes while open repaints DOM and canvas without a reload (pixel
  probe of the goniometer corner); reopening after a switch shows no stale
  palette; band accents' computed styles survive in both themes; the stored
  project (`apex:project`), the status bar and the mastering parameters are
  byte-identical across the flip. The spec also captures Dark/Light
  screenshots into `assets/screenshots/` when it runs.

Both node test files are wired into `test:history` (the suite CI runs); the
browser spec is picked up by the existing Playwright configuration.

## Validation results (actual)

| Check | Result |
| --- | --- |
| `npm run lint` (tsc) | ✅ pass |
| `npm run build` | ✅ pass; generated CSS verified to contain every new token utility |
| `npm run verify:test-discovery` | ✅ pass |
| `npm run test:shell` (theme foundation suites) | ✅ 271/271 |
| `npm run test:history` (incl. mastering + new tests) | ✅ 749/749 |
| `npm run test:audio` (mastering DSP, export, persistence) | ✅ 1676/1676 |
| `npm run test:metering` | ✅ 78/78 |
| Playwright discovery (`--list`) | ✅ 24 tests in 3 files, incl. the 5 new ones |
| Playwright execution | ⚠️ **not runnable in this sandbox**: no Chromium binary is installed and the sandbox network policy blocks the Playwright browser CDN. The repo's documented fallback (`scripts/realOfflineRenderNode.mjs`) passed 9/9. CI installs Chromium (`npx playwright install --with-deps chromium`) and will execute the full browser battery, including the new spec and its screenshots. No screenshot or browser-pass claim is made for this sandbox. |

## Remaining theme work (out of scope here, unchanged by this phase)

- The other 24 legacy modal bodies listed in the UI-03A report remain dark-only.
- Canvas surfaces in other components (`Mixer`, `AudioRecorderModal`,
  `AudioSlicerModal`, `ParametricEqModal`, `WavetableSynthModal`) still paint
  literal palettes; each needs its own seam pass.
- The legacy compatibility layer in `index.css` stays until those bodies are
  converted; it was not broadened or rewritten here.
