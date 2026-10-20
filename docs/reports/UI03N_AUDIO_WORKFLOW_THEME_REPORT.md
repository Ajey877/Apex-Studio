# UI-03N — Batch 2: Audio Workflow Modals Light/Dark Theme Migration

**Baseline:** `main` @ `63add478e6c6865bbc6cb52593b31d36c9f3dfa9` (PR #219, *UI-03M Batch 1: Instrument & Control Modals*, `MERGED`; merge commit == `origin/main` == this branch's base)
**Implementation branch:** `arena/fbf95e3d-apex-studio` (Arena session-bound branch)
**Batch:** 2 of 3 — *Audio Workflow*
**Components:** `SidechainRoutingModal`, `TakeCompingModal`, `WarpAudioProcessorModal`
**Scope:** those three components' presentation only, their focused unit and browser coverage, the shared modal-shell expectation, test-suite discovery wiring, and this report. **No global CSS, no token definitions, no DSP, no routing/recording/warp semantics, no `ProjectState` shape, and no other component changed.**

---

## 1. Baseline verification before editing

| Check | Finding |
| --- | --- |
| Branch / HEAD before work | `arena/fbf95e3d-apex-studio` @ `63add47`, working tree clean |
| `git fetch origin main` | `origin/main` == `63add478e6c6865bbc6cb52593b31d36c9f3dfa9` — **unchanged since the verified merge** |
| Suites on the untouched baseline | `lint` PASS · `verify:desktop` PASS · `verify:test-discovery` PASS (239 files, 0 orphaned) · `test:shell` 271/271 · `test:truth` 98/98 · `test:history` 972/972 · `test:audio` 1676/1676 |

**Roadmap reconciliation before editing.** `UI03M_INSTRUMENT_CONTROLS_THEME_REPORT.md` §8 was re-read against the tree: exactly three Audio-Workflow modals remained for Batch 2, and a literal census confirmed all three still carried their full dark-only palette:

| Component | Lines | Hardcoded palette refs | `--apex-*` tokens |
| --- | --- | --- | --- |
| `SidechainRoutingModal` | 289 | 58 | 0 |
| `TakeCompingModal` | 175 | 38 | 0 |
| `WarpAudioProcessorModal` | 271 | 49 | 0 |

None was already complete, so none was skipped. The `index.css` UI-1C legacy-utility compatibility layer is still required (Batch 3 and the non-modal files remain unconverted) and was left in place.

**Reachability check before browser planning.** All three are opened from the transport Tools overflow menu (`#fl-sidechain-matrix-btn`, `#fl-take-comp-btn`, `#fl-warp-processor-btn`), so all three are live-app reachable. The shipped default project, however, holds only pattern clips and no take groups, so two of the three modals can only show their *un-actionable* states in a headless browser (the ready states need recorded/bounced audio, which the recording pipeline cannot be driven to produce headless). Those branches are pinned by the unit suites with real audio-clip fixtures instead — the same coverage split UI03M used for the unreachable Polyphonic editor.

---

## 2. What changed

All three modals are DOM-rendered with no canvas, so the existing `--apex-*` tokens theme every surface directly — no palette seam, no theme observer, no new token.

| Component | Hex literals | `--apex-*` token uses (post-migration, comments excluded) |
| --- | --- | --- |
| `SidechainRoutingModal` | 58 → **1** (the `playNote` data colour) | **72** |
| `TakeCompingModal` | 38 → **0** | **45** |
| `WarpAudioProcessorModal` | 49 → **0** | **65** |

### 2.1 Identity, signal and audio-state colours

| Legacy | Meaning | Token | Precedent |
| --- | --- | --- | --- |
| `#ffaa00` amber | Sidechain identity (tile, badge, CTAs, source label, meter), Warp's NOTHING-SELECTED / NO-CLIP / LENGTH-NOT-PRESERVED qualifiers | `--apex-gold` | UI03H/M: warnings and amber identities use `--apex-gold` |
| `#00ff88` green | Warp identity (tile, panel edge, target/behaviour/pitch read-outs, CTAs, toast); Sidechain attack read-out and meter green floor | `--apex-success` | UI03H/M mapped `#00ff88` → `--apex-success` |
| `#00e5ff` cyan | TakeComping identity (tile, panel edge, selected group, active take, Check, Done); Sidechain destination/ducked read-out; Warp rate read-out | `--apex-cyan` (control) / `--apex-cyan-text` (AA text) | UI03D: `-cyan-text` for small labels that must clear AA in Light |
| `from-[#00e5ff] to-[#0077ff]` | TakeComping tile gradient | `from-[var(--apex-cyan)] to-[var(--apex-cyan-strong)]` | `VocalTunerModal`'s identical tile, byte-for-byte pattern |
| `#00ff88 / #00aa55` | Warp tile gradient | solid `bg-[var(--apex-success)]` | UI03M solid identity tiles |
| `#ffaa00 / #ff6e00` | Sidechain tile gradient | solid `bg-[var(--apex-gold)]` | UI03M solid identity tiles |
| `from-[#00ff88] via-[#ffaa00] to-red-500` | Sidechain preview meter (VU-style audio-state gradient) | `from-[var(--apex-success)] via-[var(--apex-gold)] to-[var(--apex-danger)]` | the meter's green → amber → red audio-state meaning is preserved through the semantic state tokens |
| `text-black` / `text-black/80` on coloured fills | On-colour for solid identity fills, toast text and dismiss glyphs | `--apex-state-playing-fg` | UI03M §3.2: full-opacity on-colour in both idle and hover states |
| `bg-white` (Warp `Previewing...` fill) | Auditioning-state fill | `bg-[var(--apex-text)]` + `--apex-state-playing-fg` | the high-contrast "preview is running" reading, theme-aware (see §3.1) |
| `bg-black/85 backdrop-blur-md` | Hand-rolled scrim | *removed* — `ModalFrame` supplies `--apex-modal-overlay` | UI03B…UI03M all dropped the dead fill |
| `#121215` | Panel | `--apex-surface` | UI03M |
| `#18181c` | Header/footer bands, cards | `--apex-panel-header` (bands), `--apex-surface-2` (cards) | UI03M |
| `#0b0b0d` / `#0a0a0c` / `#121214` | Insets, banners, selects, control insets | `--apex-canvas` | UI03M |
| `#1a1a20` (selected group) | Selected card step | `--apex-surface-3` | UI03M's monotonic idle → selected surface step |
| `#2e2e34` / `#28282e` / `#26262a` / `#333` / `#333336` / `#33333e` / `#242428` | Borders | `--apex-border` | UI03M |
| `#25252a` / `#333338` (Cancel) | Secondary button + hover | `--apex-surface-3` / `color-mix(in srgb, var(--apex-surface-3) 85%, var(--apex-text))` | `MidiLearnModal`'s secondary button |
| `#222` (meter track) | Groove | `--apex-grid-line-strong` | UI03M's knob groove |
| `#b0b0b0` / `#888` | Body/secondary text | `--apex-text-2` | UI03M |
| `#777` / `#666` / `#555` | Muted text | `--apex-text-3` | UI03M |
| `text-white` | Emphasis text | `--apex-text` | UI03M |
| `hover:border-[#444]` | Idle-card hover lift | `hover:border-[var(--apex-grid-line-strong)]` | UI03M |
| `hover:bg-[#222226]` (close) | Close hover wash | `hover:bg-[var(--apex-state-hover)]` | UI03M |
| `hover:bg-[#16161c]` (take row) | Row hover step | `hover:bg-[var(--apex-surface-3)]` | one-step hierarchy surface |

### 2.2 Data colours and selection

- **The audition note's `color: '#ff6e00'`** in `SidechainRoutingModal.handleAuditionPump` is a data field for `audioEngine.playNote` — the same category UI-03A explicitly preserves for `ch.color` and `PAD_COLORS`. It survives byte-for-byte, and is the only hex literal left in the batch.
- **`clip.audioBufferId?.slice(0, 12)`** in `TakeCompingModal` is a *read* of persisted data (buffer-id prefix read-out), not a fabrication — the Phase-48 guard in `playlistClipIntegrity.test.ts` (`doesNotMatch /audioBufferId:/`) still passes.
- **Group/take selection is UI state, not persisted data.** The selected group card takes a themed `--apex-surface-3` step, its cyan identity border and a `--apex-accent-strong` ring (8.72:1 / 3.93:1 Dark/Light against the selected surface; ring 6.54:1 / 6.39:1), so selection never depends on a single colour alone — the same refusal UI03M encoded for macro-card selection. The active take keeps its cyan wash (`--apex-cyan` 20%), cyan border (10.93:1 / 4.30:1 vs the canvas) and cyan Check glyph (6.85:1 / 3.32:1 on the wash — SC 1.4.11 for a non-text glyph).

### 2.3 Files touched

1. `src/components/SidechainRoutingModal.tsx` — presentation only.
2. `src/components/TakeCompingModal.tsx` — presentation only.
3. `src/components/WarpAudioProcessorModal.tsx` — presentation only.
4. `src/components/sidechainRoutingThemeUi.test.tsx` **(new, 10 tests)** — appended to `test:history`.
5. `src/components/takeCompingThemeUi.test.tsx` **(new, 12 tests)** — appended to `test:history`.
6. `src/components/warpAudioProcessorThemeUi.test.tsx` **(new, 14 tests)** — appended to `test:history`.
7. `browser-tests/sidechainRoutingTheme.spec.ts` **(new, 2 real-Chromium cases)**.
8. `browser-tests/takeCompingTheme.spec.ts` **(new, 2 real-Chromium cases)**.
9. `browser-tests/warpAudioProcessorTheme.spec.ts` **(new, 2 real-Chromium cases)**.
10. `src/state/modalDialogShell.test.tsx` — **only** the three migrated `overlayClass` expectations, updated in lockstep to pin `ModalFrame`'s shared themed scrim and drop the dead black fill. `OVERLAY_STUDIO` stays: `ProjectBundleZipModal` and `DesktopAppModal` (Batch 3) still reference it. No other case touched.
11. `package.json` — the three new suites added to the `test:history` glob list so `verify:test-discovery` keeps reporting 0 orphaned files (239 → 242).
12. `UI03N_AUDIO_WORKFLOW_THEME_REPORT.md` — this report.

### 2.4 Behavior explicitly untouched

Verified mechanically (§5) and by test: every `useState`/`useEffect`, prop signature, event handler, `audioEngine` call, published payload shape, control `min`/`max`/`step`, and every user-visible string. Specifically preserved:

- **Sidechain routing semantics.** `handleApplyRouting` emits exactly the five engine-consumed `SidechainSettings` fields (`enabled`, `sourceTrackId`, `amount`, `attackMs`, `releaseMs`) onto the destination track only; the Phase-79 inert forward-compat state (`thresholdDb`, `lowFreqOnly`, `highPassFilterHz`) is preserved in state and still not rendered as controls; the 50 ms sine-pulse preview meter keeps its waveform and 18 dB ceiling; `handleAuditionPump` still plays the `sub_808` pump note on the selected destination track; the note-triggered (no level detector) wording appears in all three of its places.
- **Take comping.** Group enumeration through `getTakeGroupIds` / `getTakeGroupClips` / `resolveActiveTakeIndex` is unchanged (the explicit-selection-wins and latest-take-default resolutions are asserted with real fixtures); take selection publishes through `onSelectActiveTake` → `selectActiveTake` → `commitPlaylistHistory` in App (asserted by `phase1m.integration.test.ts` and `playlistClipIntegrity.test.ts`, both still green); the group cards toggle expansion without the take-row click toggling its group (`stopPropagation` pinned).
- **Warp.** Target resolution through `resolveWarpTarget` / `isWarpTargetReady` / `warpTargetMessage`; the re-seed `useEffect` on `[isOpen, targetClip?.id]`; the real-buffer audition path (`getSampleBuffer` → `BufferSource` with `playbackRate`/`detune`, 4 s ceiling, 0.9 gain, `onended`); the apply payload `{ ...targetClip, pitchShiftSemitones, timeStretchRate }` and its exact toast; the apply → close 1 s timer; `WARP_BEHAVIOUR_SUMMARY` read verbatim from the module.
- **Truth strings.** `productTruthStrings.test.ts` still passes at 98/98: TakeComping carries no `DEMO|PROTOTYPE|INCOMPLETE`; Warp states repitch and claims no `granular|formant|transient warp|time-stretch`; Sidechain carries no `lookahead`.

### 2.5 Accessibility additions

Two status-toast dismiss glyphs (Sidechain, Warp) were glyph-only with no accessible name. Both now carry `aria-label="Dismiss status message"` — the same fix UI03M recorded for its two toasts — and both are pinned by the shell and unit suites.

---

## 3. Findings and one defect fixed

### 3.1 The Warp "Previewing…" state fill was a fixed `bg-white` (fixed)

The auditioning state painted `bg-white` unconditionally. In Dark that read as a high-contrast "preview is running" state; in Light it was a white fill on a light panel with near-black on-colour — readable, but a fixed-palette utility that cannot follow the theme and the one place a Light-mode user saw raw white where every sibling surface is themed. The fill now resolves to `--apex-text` with `--apex-state-playing-fg` on-colour (17.56:1 Dark, 16.36:1 Light — computed from the shipped token values), which keeps the same high-contrast state reading in both palettes. The class contract is pinned by a source assertion in `warpAudioProcessorThemeUi.test.tsx` and the unit suite's `sourceClassNames` scanner would flag any regression to a literal.

### 3.2 Findings deliberately *not* "fixed", with reasons

- **The Sidechain preview meter track is a low-contrast groove** (`--apex-grid-line-strong` at 3.44:1–6.66:1 against the fill colours, ~1.2:1 against the card). SC 1.4.11 covers graphical objects *required to understand the content*; the track is the groove behind the value, and the value is also present as an AA gold read-out (`preview ~X dB`, 10.40:1 Dark / 4.93:1 Light). Inflating the groove to 3:1 would redesign the meter. The spec asserts instead that the track resolves from the palette and that all three fill colours clear 3:1 against it in both themes.
- **The audition note colour stays a literal.** It is data for `playNote`, not chrome; tokenising it would change what gets passed to the engine call and is outside a presentation migration.
- **The `accent-[var(--apex-*)]` declarations on the range inputs are dead app-wide** (pre-existing, UI03M §7.4): the unlayered `accent-color: var(--apex-accent)` rule at `src/index.css:144` beats every `accent-*` utility. The classes were written to declare the intended per-control hue, consistent with every migrated modal, and no Light-theme readability bug results — the computed accent resolves `--apex-accent`, theme-correct in both palettes. Fixing it means editing global CSS, which this batch is not allowed to do.
- **Sidechain/TakeComping local state survives close/reopen** (the components stay mounted while the dialog returns `null`). Pre-existing; the sidechain browser spec asserts what actually happens (the re-pointed source select and the edited ducking depth survive) rather than what might be intended.

---

## 4. Contrast evidence

Computed from the real `src/index.css` token values in both palettes, then **re-verified live** through `getComputedStyle` in Chromium (the three new browser specs read every asserted surface from the running app). Text is held to WCAG 2.1 SC 1.4.3 (4.5:1) against the *effective composited surface* — translucent `color-mix()` washes are flattened onto the first opaque ancestor, because measuring a wash against its raw colour gives the wrong answer.

### 4.1 Text (SC 1.4.3, ≥ 4.5:1)

| Element | Surface | Dark | Light |
| --- | --- | --- | --- |
| Dialog title | `--apex-panel-header` | 14.22 | 13.69 |
| Subtitle / footer note / close idle | `--apex-panel-header` (`--apex-text-3`) | 5.14 | 4.75 |
| Panel body copy | `--apex-surface` (`--apex-text-2`) | 8.27 | 7.89 |
| Body on cards | `--apex-surface-2` | 7.52 | 7.29 |
| Muted captions on insets/banners | `--apex-canvas` (`--apex-text-3`) | 5.88 | 5.24 |
| Muted captions on cards | `--apex-surface-2` | 5.13 | 5.24 |
| Parameter/control labels | `--apex-surface-2` (`--apex-text`) | 14.20 | 15.12 |
| Source label, meter read-out, NOTHING-SELECTED | `--apex-surface-2` / `--apex-canvas` (`--apex-gold`) | 9.08 / 10.40 | 4.93 / 4.93 |
| Attack, pitch read-outs, behaviour summary | `--apex-surface-2` (`--apex-success`) | 8.68 | 5.40 |
| Destination, release, rate read-outs | `--apex-surface-2` (`--apex-cyan-text`) | 9.54 | 7.39 |
| Identity badge / repitch badge label | gold-20% wash over `--apex-panel-header` (`--apex-text`) | 8.99 | 10.57 |
| CTA on-colour | solid `--apex-success` / `--apex-gold` / `--apex-cyan` | 10.73 / 11.23 / 11.80 | 5.85 / 5.33 / 4.66 |
| CTA on-colour, hovered | 82% / 86% toward text; `--apex-cyan-strong` | 11.66 / 11.93 / 14.12 | 7.12 / 6.31 / 5.27 |
| Cancel label / hovered | `--apex-surface-3` / 85% toward text | 12.97 / 8.22 | 13.81 / 10.30 |
| Auditioning state | `--apex-text` (`--apex-state-playing-fg`) | 17.56 | 16.36 |
| Active take row label | cyan-20% wash over `--apex-canvas` (`--apex-text`) | 10.19 | 11.67 |
| Idle take row, hovered | `--apex-canvas` → `--apex-surface-3` (`--apex-text-2`) | 8.62 → 6.87 | 7.29 → 6.66 |
| Empty-state icon / heading / hint | `--apex-canvas` | 5.88 / 7.29 / 5.24 | 5.24 / 7.29 / 5.24 |
| Take group meta / footer counts | `--apex-surface-2` / `--apex-panel-header` | 7.52 / 5.14 | 7.29 / 4.75 |

### 4.2 Non-text (SC 1.4.11, ≥ 3:1)

| Element | Against | Dark | Light |
| --- | --- | --- | --- |
| Identity tile, gold | `--apex-panel-header` | 9.09 | 4.46 |
| Identity tile, cyan | `--apex-panel-header` | 9.55 | 3.89 |
| Identity tile, cyan-strong (gradient ceiling) | `--apex-panel-header` | 11.43 | 4.40 |
| Identity tile, success | `--apex-panel-header` | 8.69 | 4.89 |
| Active take border (cyan) | `--apex-canvas` | 10.93 | 4.30 |
| Active take Check glyph (cyan) | cyan-20% wash over `--apex-canvas` | 6.85 | 3.32 |
| Selected group border (cyan) | `--apex-surface-3` | 8.72 | 3.93 |
| Selection ring `--apex-accent-strong` | `--apex-surface-3` | 6.54 | 6.39 |
| Meter arrow (gold) | `--apex-canvas` | 10.40 | 4.93 |
| Meter fill, success / gold / danger | `--apex-grid-line-strong` track | 6.36 / 6.66 / 3.84 | 3.77 / 3.44 / 3.87 |

The panel identity edges (20–40% `color-mix` washes against the page) are asserted as *resolved colours* in the specs but not held to 3:1 against the page — the same treatment UI03M applied to its identity borders: the panel boundary against the scrimmed backdrop is not a control boundary, and the legacy `border-[#…]/40` washes had the same relationship.

---

## 5. Proof the change is presentation-only

Each migrated file was diffed against the `63add47` baseline with every `className` value blanked. What remains is the complete inventory of non-`className` changes:

**`SidechainRoutingModal` — 1**
1. The UI-03N explanatory panel comment (prose only).

**`TakeCompingModal` — 1**
1. The UI-03N explanatory panel comment. (The selected-group ternary was re-wrapped over three lines to fit the longer class strings; no expression changed.)

**`WarpAudioProcessorModal` — 1**
1. The UI-03N explanatory panel comment (prose only).

**No change to any handler, hook, prop signature, `audioEngine` call, published payload, control range, or string.** The `ModalFrame` invocation differs only in its `className` (the dead `bg-black/85` fill removed in all three).

---

## 6. Validation (all executed in this run, on the final code)

Nothing below is inherited from an earlier run. `npm run lint` is `tsc --noEmit`; there is no ESLint configuration in this repository. The full unit gates were run once each on the completed batch — per the batch's CI-efficiency rule, one valid run of an unchanged suite covers all three modals, so no suite was re-run after each component beyond its focused run.

| Gate | Command | Result |
| --- | --- | --- |
| TypeScript / lint | `npm run lint` (`tsc --noEmit`) | **PASS**, exit 0 |
| Desktop config | `npm run verify:desktop` | **PASS** |
| Test discovery | `npm run verify:test-discovery` | **PASS** — 242 files (src 240, tests 2), 242 covered, **0 orphaned** (was 239; +3 new suites) |
| New focused unit suites | `sidechainRoutingThemeUi` + `takeCompingThemeUi` + `warpAudioProcessorThemeUi` | **36/36 PASS** (10 + 12 + 14) |
| Shared modal shell | `src/state/modalDialogShell.test.tsx` | **28/28 PASS** |
| Product truth strings | `src/state/productTruthStrings.test.ts` | **PASS** (reads all three components) |
| Phase 1M integration / clip integrity / warp target | `phase1m.integration.test.ts`, `playlistClipIntegrity.test.ts`, `warpClipTarget.test.ts` | **PASS** (all read one or more of the three) |
| Shell / theme foundation | `npm run test:shell` | **271/271 PASS** |
| Truthfulness | `npm run test:truth` | **98/98 PASS** |
| History / publication / theme UI | `npm run test:history` | **1008/1008 PASS**, 86 suites (was 972; **+36**) |
| Audio / DSP / routing / take state | `npm run test:audio` | **1676/1676 PASS**, 353 suites — unchanged, as expected for a presentation-only batch |
| **Full real-browser suite** | `npx playwright test` | **79 passed (3.7m)**, 0 failed (was 73; **+6**) |
| New per-component browser specs | `sidechainRoutingTheme`, `takeCompingTheme`, `warpAudioProcessorTheme` | **6/6 PASS** (2 each × Dark/Light) |
| Production build | `npm run build` | **PASS**, exit 0 — CSS 108.24 kB (gzip 17.15 kB), JS 1206.54 kB (gzip 318.92 kB) |
| Production CSS emission | scan of `dist/assets/index-*.css` | **PASS** — every new token utility present (gold/cyan/success fills, the 20/40/82/85/86% `color-mix` washes, the meter gradient stops, `--apex-text` auditioning fill, `--apex-cyan-strong` hover) |
| Whitespace / conflict markers | `git diff --check` | **clean** |

**Browser-spec coverage** (both themes, live `getComputedStyle`, no stubbed styles):

- **Sidechain** — themed scrim and every chrome surface; the gold identity (tile, 20% badge wash, 40% badge/panel edges) with theme-text badge label; both selects open on the shipped defaults (track 1 / track 2 of the 8-track default mixer); the meter track, gold read-out and the green → amber → red gradient stops resolved from `--apex-success` / `--apex-gold` / `--apex-danger`; the three parameter cards' ranges and AA read-outs in their three state colours; gold CTA fills with on-colour AA and 3:1 against the band; close hover; **Apply publishes the exact payload toast** (`Applied Sidechain Ducking to Snares & Claps (Source: Kick / 808)`), the toast fill/on-colour are themed; **Audition Pump** reports its envelope toast; sliders drive the read-outs (85% → 50%, 5 ms → 25 ms); re-pointing the source select re-points the toast (`…(Source: Master)`); Escape; **cross-reopen persistence of local state** (the re-pointed select and edited depth survive — pre-existing, asserted as-is); keyboard initial focus on Audition Pump, pointer-focus shows no ring, Tab to close with the 2px solid `--apex-accent` @ 0.78 ring.
- **Take Comping** — themed scrim and chrome; the cyan gradient tile (both stops resolved), 40% cyan panel edge; the empty state inset, icon, heading and hint in their AA colours; the footer count `0 take groups · 0 total takes`; the cyan Done CTA with on-colour AA and 3:1 against the footer band; close hover; keyboard initial focus (only close + Done are focusable in the empty state), Tab to Done with the themed ring; Escape; reopen re-themes.
- **Warp** — themed scrim and chrome; the success identity (tile, 40% panel edge) and the gold repitch badge (20% wash, 40% edge, theme-text label); **the disabled, honest un-actionable states**: `NOTHING SELECTED` amber, `NO AUDIO CLIP TO WARP` banner (canvas surface, 40% gold edge, AA heading and message), `PITCH AND RATE ONLY — LENGTH IS NOT PRESERVED` with its `NO LENGTH-PRESERVING STRETCH` qualifier; the behaviour summary in green (AA); green pitch / cyan rate read-outs; both sliders disabled with their exact ranges; the disabled Preview and Apply actions at 0.4 opacity with their themed fills; the themed Cancel button with its hover step; **the focus trap skips the disabled preview button** (lands on close, Tab to Cancel with the themed ring); Escape; **selecting the `Kick Pattern` clip in the Playlist Arranger reaches the unsupported-type state** — the banner names the clip and explains pattern clips are un-actionable, the sliders stay disabled — still fully themed in both palettes.

### 6.1 Negative controls (proving the new assertions are not vacuous)

Run against the **final** code: the dark-only header band (`bg-[#18181c]`) and `text-white` title were re-injected into all three component files, the suites were run, and the files restored from saved copies.

| Injected regression | Result |
| --- | --- |
| `bg-[#18181c]` header + `text-white` title in all three components | **5 of 36 fail** — all of them the literal scanners (`carries no fixed chrome palette in any rendered state of either theme` ×3, `carries no fixed palette in any className in the source…` ×2). The other **31** rendering, behaviour and truthfulness assertions correctly stay green — the failures are specific, not blanket. |

After restoring all three files, the four suites were re-run to **64/64 green** (36 new + 28 modal-shell) before continuing.

### 6.2 Unrelated changes caught and reverted

- **`package-lock.json`** was rewritten by the environment's `npm install --legacy-peer-deps` (203 lines: `@electron/windows-sign` and peer-optional entries removed) — the identical churn UI03M §6.2 recorded. Reverted with `git checkout --`; the final diff contains no lockfile change.
- **`assets/screenshots/*.png`** — the full browser suite rewrites committed PNGs through font/render nondeterminism in this sandbox (16 files this run, same mechanism as UI03M §6.2; e.g. `ui03b-mastering-*.png`, `ui03c-*.png`, `ui03d-wavetable-*.png`, `ui03e-audio-slicer-*.png`). None belongs to a Batch-2 spec. Reverted with `git checkout -- assets/screenshots/` and the working tree confirmed clean before commit. **The committed diff contains no binary change.**

### 6.3 Environment note

`npx playwright install chromium` fails in this sandbox (`ECONNRESET` on `cdn.playwright.dev`), as the UI-03L/M reports record. Chromium was staged out-of-tree from `@sparticuz/chromium@153.0.0` (npm registry is reachable) into `/tmp` — `/tmp/chromium`, `/tmp/al2023/lib`, `/tmp/fonts` — exactly the paths `playwright.config.ts` already auto-detects. **Nothing was added to the repository for this** — the diff contains no browser binary, no config change and no cache directory. GitHub Actions installs Chromium normally via `npx playwright install --with-deps chromium`, so CI is unaffected.

---

## 7. Known limitations

1. **`TakeCompingModal`'s group-list state is unreachable in the live app, so its browser spec covers the empty state.** Take groups are created only by the recording pipeline (`findMatchingTakeGroup`), which the headless browser cannot drive (no audio input), and the default project ships none. Coverage instead: 12 unit tests render every branch in both themes with real take-group fixtures (two groups, explicit and default active-take resolution, pluralisation, collapsed first paint) plus the `sourceClassNames` scanner covering the selected-group/active-take class strings that first paint never paints; the take-manager resolution logic is owned by `test:audio`.
2. **`WarpAudioProcessorModal`'s ready state is likewise unreachable in the live app** (it needs a recorded/bounced audio clip). Coverage: the unit suite renders the ready state in both themes with real audio-clip data (stored `+3 st` / `1.50x` values, enabled sliders, target read-out, verbatim `WARP_BEHAVIOUR_SUMMARY`) and pins the audition/apply payloads source-level; the browser spec covers both un-actionable states the live app can reach, including the pattern-clip unsupported-type state reached by selecting a real clip in the Playlist Arranger.
3. **Shared semantic tokens are not byte-identical to the legacy literals in Dark.** `--apex-success` is `#62d7a4` where the shipped literal was `#00ff88`; `--apex-gold` is `#ffb86b` where it was `#ffaa00`; `--apex-cyan` is `#67d9ff` where it was `#00e5ff`. Same hue family, lower saturation, and the change is what makes them clear AA in Light. UI-03H/M record the same trade-off. Dark therefore shifts slightly for those fills.
4. **The Warp auditioning-state fill changed from white to `--apex-text`** (§3.1). In Dark the reading is near-identical (near-white vs white); in Light it is the deliberate fix.
5. **`accent-*` utilities are dead app-wide** (pre-existing, UI03M §7.4). The per-control `accent-[var(--apex-*)]` classes declare the intended hue consistently with every migrated modal; the computed accent resolves `--apex-accent`, theme-correct in both palettes, so no Light-theme readability bug results.
6. **`--apex-canvas` and `--apex-surface-2` are the same colour in Light** (`#f4f6fa`). The take-row hover (canvas → surface-3) therefore steps *darker* in Light — the standard pressed look — rather than lighter as in Dark. This is a property of the existing palette, not something introduced here.
7. **Sidechain/TakeComping local state survives close/reopen** because the components stay mounted while the dialog returns `null` (§3.2). Pre-existing; the sidechain browser spec documents and asserts it.
8. **The legacy-utility compatibility layer in `index.css` remains.** It can only be removed once Batch 3 converts the remaining five modals plus `ProjectBundleZipModal`, `PlaylistArranger` and `ChannelRack`.

---

## 8. Remaining UI-03 work after this batch

Five modals remain, exactly as planned:

- **Batch 3 — Utility Interfaces:** `CollaborationModal` (204 lines / 47 literals), `HotkeysModal` (137 / 24), `AnalyticsModal` (231 / 42), `OrientationLockModal` (146 / 30), `DesktopAppModal` (671 / 137).

Notes carried forward (from UI03M §8, re-verified against the tree): `HotkeysModal` exports `HOTKEY_GROUPS`, guarded by `src/state/hotkeyDocumentation.test.ts` — every row must keep tracing to a real handler. `AnalyticsModal` is opened by the `project.statistics` application-menu command, not by a transport button. `OrientationLockModal` is **not** a `ModalFrame` dialog and is **not** in `MODAL_CASES`; it self-detects (`innerHeight > innerWidth` and touch-or-narrow) and needs a viewport/emulation-driven spec. `modalDialogShell.test.tsx`'s `OVERLAY_STUDIO` is still referenced by the Batch-3 cases and by `ProjectBundleZipModal`, so it must not be removed until the last of them converts.

---

## 9. Final validated state

| Item | Value |
| --- | --- |
| Base (`main`) | `63add478e6c6865bbc6cb52593b31d36c9f3dfa9` |
| Branch | `arena/fbf95e3d-apex-studio` |
| Gates re-run after the last code change | lint, verify:desktop, verify:test-discovery, test:shell, test:truth, test:history, test:audio, full playwright (79), build, `git diff --check` — all on the final tree |
| Files changed vs `main` | 12 (3 components, 3 new unit suites, 3 new browser specs, `modalDialogShell.test.tsx`, `package.json`, this report) |
| `git diff --check` | clean |
| Binary / lockfile / screenshot changes in the diff | **none** |
| New design tokens | **0** |
| Global CSS changes | **0** |

---

## 10. Merge recommendation

**Recommend merging.** All twelve validation gates pass on the final code, including the full 79-case real-browser suite in both themes and a clean production build. The change is presentation-only, proved mechanically in §5, with one fixed-palette defect fixed (§3.1), three findings deliberately left alone with stated reasoning (§3.2), zero new design tokens, zero global-CSS changes, and no weakening of any existing assertion. `test:audio` is unchanged at 1676/1676 and `test:truth` at 98/98 — the expected signature of a migration that touched no DSP, no routing/recording/warp semantics and no truth copy.
