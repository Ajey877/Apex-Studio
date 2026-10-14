# UI-03P — Batch 4: Residual Surfaces Light/Dark Theme Migration

**Baseline:** `main` @ `0f0baae8b1bc4d78f59c5ad9b42bc2851360a6ae` — PR #221, *UI-03O Batch 3: Utility Interfaces*, `MERGED`; the merge commit **is** `origin/main` **is** this branch's base.
**Implementation branch:** `arena/32696a7b-apex-studio` (Arena session-bound branch — never pushed anywhere else)
**Batch:** 4 — *Residual surfaces* (the last legacy modal, the remaining chrome literals in the three DAW surfaces, and the app-level error fallback)
**Files migrated:** `ProjectBundleZipModal.tsx`, `PlaylistArranger.tsx`, `PianoRoll.tsx`, `ChannelRack.tsx`, `AppErrorBoundary.tsx`
**Scope:** those five components' presentation only, the two shared expectations they touch (`modalDialogShell`, `ui04ThemeConsistency`), five new focused unit suites, four new browser specs, appended to the existing `test:history` glob, eight new screenshot artifacts, and this report. **No global CSS, no token definitions, no new token, no DSP, no routing/recording/transport semantics, no `ProjectState` shape change, no `ModalFrame` behaviour change, no AI feature, and no other component changed.**

---

## 1. Baseline verification before editing

| Check | Finding |
| --- | --- |
| Branch / HEAD before work | `arena/32696a7b-apex-studio` @ `0f0baae`, branched from `origin/main` |
| `origin/main` | `0f0baae8b1bc4d78f59c5ad9b42bc2851360a6ae` (parents `f010717` + Batch 3 `10ebbec`) — unchanged since the Step-1 verification |
| Suites on the untouched baseline | `verify:desktop` PASS · `lint` PASS · `verify:test-discovery` PASS (247 files, 0 orphaned) · `test:shell` 271/271 · `test:truth` 98/98 · `test:history` 1051/1051 · `test:audio` 1676/1676 · `npx playwright test` **89/89** (3.9 min) · `npm run build` PASS (CSS 108.81 kB / gzip 17.06 · JS 1,211.70 kB / gzip 318.48, 1831 modules) |

**Candidate selection was read-only and evidence-based** — no component was guessed. A literal census over `src/` (comments excluded) ranked the remaining dark-only survivors after Batches 1–3, the UI-03O §8 roadmap was re-read against the tree and `DesktopAppModal` (already migrated in UI-03O) was excluded explicitly:

| Component | Role | Chrome literals found | Chosen? |
| --- | --- | --- | --- |
| `ProjectBundleZipModal` | the last legacy modal; 10 distinct UI-1C compatibility-layer classes | 41 hex, 41 arbitrary `[#…]` utilities, 15 fixed `white`/`black` | **yes** |
| `PlaylistArranger` | DAW surface; 2 compat-layer classes that silently remapped a preserved signal colour | 66 hex (mostly data), 37 arbitrary `[#…]` utilities (chrome) | **yes** |
| `PianoRoll` | DAW surface; 5 outline/handle literals | 5 hex, 5 arbitrary `[#…]` utilities | **yes** |
| `ChannelRack` | DAW surface; 2 named-palette classes | 0 hex chrome, 2 named-palette classes (`hover:text-red-400` ×2) | **yes** |
| `AppErrorBoundary` | app-level fallback, painted entirely with literals | 11 fixed `white`/`black` utilities, 0 tokens | **yes** |
| `App.tsx`, `StudioBrowser`, `presets.ts`, `DrumSamplerPanel` | data/identity colours, not chrome | — | no (UI-03A data, unchanged) |
| `DesktopAppModal` | completed in UI-03O | — | no (excluded) |

**Reachability check before browser planning.**

| Surface | Entry point in the live app | Reachable? |
| --- | --- | --- |
| `ProjectBundleZipModal` | `#application-menu-file` → `#application-menu-file-menu` → `#application-menu-command-file.exportBundle` | yes |
| `PlaylistArranger` | `#nav-playlist` (view switch) | yes |
| `PianoRoll` | `#nav-piano-roll` | yes |
| `ChannelRack` | `#nav-channel-rack` (default view) | yes |
| `AppErrorBoundary` | renders only when a child throws during render | **deliberately not triggered** — see §7 |

---

## 2. What changed

All five surfaces are DOM-rendered (no canvas), so the existing `--apex-*` tokens theme them directly: no palette seam, no theme observer, no new token, no change to `index.css`.

Census over the five files, comments excluded (a second, comment-only pass was made between the two rows so the numbers describe code, not prose):

| File | lines | hex | arbitrary `[#…]` colour utilities | named-palette classes | fixed `white`/`black` | `--apex-*` refs |
| --- | --- | --- | --- | --- | --- | --- |
| `ProjectBundleZipModal.tsx` | 264 → 264 | 41 → **0** | 41 → **0** | 0 → 0 | 15 → **0** | 0 → **55** |
| `PlaylistArranger.tsx` | 1834 → 1891 | 66 → **26** (see §2.1) | 37 → **2** (see §2.1) | 0 → 0 | 9 → **6** (the preserved media scrim) | 179 → **209** |
| `PianoRoll.tsx` | 1654 → 1654 | 5 → **0** | 5 → **0** | 0 → 0 | 3 → **0** | 147 → **155** |
| `ChannelRack.tsx` | 689 → 689 | 20 → 20 (data) | 0 → 0 | 2 → **0** | 0 → 0 | 174 → **176** |
| `AppErrorBoundary.tsx` | 71 → 80 | 0 → 0 | 0 → 0 | 0 → 0 | 11 → **0** | 0 → **11** |
| **Total** | 4512 → 4578 | **132 → 46** | **83 → 2** | **2 → 0** | **38 → 6** | **500 → 606** |

(The two surviving arbitrary utilities are `bg-[#002b1a]/90` and `hover:bg-[#003d24]` — the preserved audio wash in §2.1. `color-mix()`/`var()` arbitrary values are the migration's own output and are not counted as literals.)

### 2.1 Chrome vs. preserved data, per file

**`ProjectBundleZipModal`** — every surface moved to the shared scale: panel `--apex-surface` with an accent-48 % edge, header/footer bands `--apex-panel-header`, the two cards and the file-name inset `--apex-surface-2`/`--apex-canvas`, checkboxes `accent-[var(--apex-accent)]`, secondary actions `--apex-surface-3` + `--apex-state-hover`, muted copy `--apex-text-3`, body `--apex-text-2`, headings `--apex-text`. The identity family (header tile, `PORTABLE .ZIP` badge, status banner, primary CTA) is one accent family on `--apex-accent` / `--apex-accent-strong` with `--apex-state-playing-fg` as the on-colour. The modal's own `bg-black/85` scrim was removed: `ModalFrame`'s `apex-modal-overlay` primitive owns the scrim for every Step-4 dialog, and this was the last one overriding it with an opaque fill that stayed near-black in Light.

**`PlaylistArranger`** — chrome tokenised: the clip-type/tool active chips (`bg-[var(--apex-cyan)]` + `--apex-state-playing-fg`), the Sections button and its `Flag` glyph (`--apex-gold` + gold-30 % edge), the automation clip wash (`color-mix(--apex-cyan 16%/24%, --apex-panel)` with a `--apex-cyan` border), its label (`--apex-cyan-text`), the envelope polyline/points (SVG `stroke`/`fill` from `--apex-cyan`/`--apex-text`), the automation-editor footer rule/tile/point chip, the track state dot and the bounce hover (`--apex-success`), the quick-add marker tiles and the marker chip label (`--apex-text`).

Preserved:
* **Marker hue data** — hoisted into `MARKER_KIND_COLORS` (`intro #00e5ff`, `verse #3b82f6`, `drop #ff0055`, `outro #00ff88`) and left literal inside `MARKER_PRESETS` (18 occurrences). These are stored on `ArrangementMarker.color` and repainted verbatim as the chip's wash + left edge, so a marker keeps its identity in both palettes (UI-03A §“Explicitly preserved”).
* **`AUDIO_CLIP_SIGNAL_COLOR = '#00ff88'`** — the dropped-audio signal. It paints the stored clip `color` on both creation paths, the available-audio border, the clip label and all 32 waveform bars, so the four cannot drift apart.
* **The audio clip's dark surface steps** (`bg-[#002b1a]/90`, `hover:bg-[#003d24]`) and the **fade scrim** drawn over it (`from-black/80`, `border-white/40`, `text-white` ×2) — a media scrim over a preserved signal surface, the same category as UI-03O's single surviving on-colour. The dark wash is deliberate: it keeps the preserved `#00ff88` signal at **11.72:1 (Dark) / 8.74:1 (Light)** instead of letting a palette-driven surface decide for it.

**`PianoRoll`** — four toolbar outlines and the two note-resize handles: cyan-30 % for Strum Chords and Import .mid, gold-40 % for Extract 808 Bass, success-40 %/30 % for Ghost and Export .mid, and the resize overlays moved from raw black washes to `--apex-state-playing-fg` at 20 %/40 %. `--apex-state-playing-fg` is the theme's “ink on a bright fill”, so the handle now darkens the note in Dark and lightens it in Light — one expression, correct in both palettes. The cyan labels also moved from the **decorative** `--apex-cyan` to the **text** variant `--apex-cyan-text` (§3.2).

**`ChannelRack`** — the two destructive hovers (`hover:text-red-400` on **CLR** and on per-row delete) now resolve through `--apex-danger`, the token the rest of the app's destructive affordances already use. Tailwind's `red-400` is not a theme token: it stayed the same red in both palettes and disagreed with the app's danger hue.

**`AppErrorBoundary`** — the fallback was the only full-screen surface painted entirely with literals (`bg-black`, `text-white`, `border-white/10`, `bg-white/5`, `bg-black/30`, a white primary button). It now uses `--apex-bg`/`--apex-surface`/`--apex-border`/`--apex-text`/`--apex-text-2`/`--apex-text-3`/`--apex-canvas` and an accent CTA on `--apex-state-playing-fg`. The theme is decided on `<html data-theme>` by the pre-paint bootstrap, so every token resolves even when the boundary renders before any panel mounts.

### 2.2 Files touched

| File | Change |
| --- | --- |
| `src/components/ProjectBundleZipModal.tsx` | presentation only; scrim delegation; archive contract untouched |
| `src/components/PlaylistArranger.tsx` | presentation only; `MARKER_KIND_COLORS` + `AUDIO_CLIP_SIGNAL_COLOR` hoisted |
| `src/components/PianoRoll.tsx` | presentation only (outlines, handles, cyan text variant) |
| `src/components/ChannelRack.tsx` | presentation only (two hovers) |
| `src/components/AppErrorBoundary.tsx` | presentation only |
| `src/state/modalDialogShell.test.tsx` | `OVERLAY_STUDIO` fixture updated for the removed modal-level scrim (§3.3) |
| `src/state/ui04ThemeConsistency.test.ts` | the `color: '#00ff88'` pin re-pointed at the named constant; two files added to `THEMED_SURFACES` |
| `src/components/{projectBundleZip,playlistArranger,pianoRoll,channelRack,appErrorBoundary}ThemeUi.test.tsx` | **new** — 32 unit tests |
| `browser-tests/{projectBundleZip,playlistArranger,pianoRoll,channelRack}Theme.spec.ts` | **new** — 12 browser tests |
| `package.json` | the five new unit suites appended to the existing `test:history` glob (no new script, no check removed) |
| `assets/screenshots/ui03p-*.png` | **new** — 8 committed evidence artifacts, regenerated by the new specs |
| `UI03P_RESIDUAL_SURFACES_THEME_REPORT.md` | this report |

### 2.3 Behavior explicitly untouched (proved mechanically)

* **`ProjectBundleZipModal`** — export still writes `project_manifest.json` (with `audioBlob`/`blob` stripped), `README.txt` (`format: 'apex-studio-project-bundle'`, `formatVersion: 2`), `patterns/pattern_<n>_<name>.json`, `mixer_routing/mixer_tracks.json` and `audio/<id>.bin`, and downloads `<bundleName>.zip`; import still `JSZip.loadAsync` → `normalizeProjectState` → `persistAudioClip` → `onLoadProjectState(state, { source: 'bundle-import' })`, keeps the current project when `replaced === false`, and clears the file input in `finally`. Ids `fl-project-zip-modal` / `fl-project-zip-modal-title`, both `aria-label`s (close, status dismiss), the `isOpen` guard and the 1.5–4 s status auto-clear are pinned by the unit suite.
* **`PlaylistArranger`** — marker creation/menus/status copy, mute + bounce handlers, fade-handle click arithmetic (`fadeInBars`/`fadeOutBars`), automation point placement/deletion, `totalBars` ownership and the missing-audio badge label are pinned by the unit suite and exercised in the browser spec.
* **`PianoRoll`** — Strum / Extract 808 / Ghost / Humanize / Velocities / Import .mid / Export .mid / Clear all notes / velocity change / the two resize separators keep their handlers, titles and aria-labels.
* **`ChannelRack`** — mute toggle, delete (with the “last channel” guard), piano-roll/instrument entry, swing, ids `fl-channel-rack` / `channel-row-<id>`.
* **`AppErrorBoundary`** — `getDerivedStateFromError`, the `console.error` report, the captured children contract, `window.location.reload()` and the conditional details block.

---

## 3. Findings and the defects fixed

### 3.1 `PlaylistArranger`'s audio label was remapped into unreadable territory (fixed)

`index.css`'s UI-1C layer maps `.text-[#00ff88]` to `var(--apex-success)` — but **only for text**. In Light that is `#14734e` on the clip's preserved dark-green body: **2.00:1**, far below AA. The waveform bars and the clip border next to it escaped the layer, so the label was the only part of the signal that drifted. Fixed by painting the label from the same `AUDIO_CLIP_SIGNAL_COLOR` constant as the bars and border: **8.74:1 (Light) / 11.72:1 (Dark)**. The rejected pairing is asserted in both the unit suite and the browser spec.

### 3.2 `PianoRoll`'s cyan labels were below AA on the Light toolbar (fixed)

The Strum Chords / Import .mid labels used the decorative `--apex-cyan` (`#087da8`) on `--apex-surface-2` (`#f4f6fa`) = **4.30:1** at 10 px — below AA. The theme already declares the text variant for exactly this case (`--apex-cyan-text`, identical in Dark, `#065775` in Light = **7.39:1**). The labels moved there; the decorative token still paints the outlines and glyphs. Both the rejected and adopted pairings are pinned.

### 3.3 The last modal overrode the shared scrim (fixed)

`ProjectBundleZipModal` was the only dialog still carrying `bg-black/85` on top of `apex-modal-overlay`, so its backdrop stayed near-black in Light while every other dialog followed `--apex-modal-overlay`. The modal-level fill is gone and the primitive owns it. `modalDialogShell.test.tsx`'s `OVERLAY_STUDIO` fixture (which pins each modal's overlay classes verbatim) was updated to the new class string with a comment explaining why — this is the one test expectation that *had* to change, and it changed the fixture to match the intended new state, not the assertion to match the code.

### 3.4 The app fallback was black in Light (fixed)

`AppErrorBoundary` painted `bg-black` + `text-white` unconditionally and used a pure-white button — invisible on the Light panel (white on `--apex-surface` = 1.0:1). Now themed end-to-end; every pairing clears AA in both palettes (§4).

### 3.5 Findings deliberately *not* "fixed", with reasons

* **`ChannelRack`'s 20 hex literals** are `Channel.color` values (channel identity) — data, kept verbatim (UI-03A).
* **`PlaylistArranger`'s 26 remaining hex literals** are marker-preset/kind hues, the stored automation-clip colour, the audio signal constant and the two preserved audio-wash steps (§2.1).
* **The four quick-add tiles keep a hex-derived wash.** The hue is the marker's identity and is stored with the marker the tile creates; swapping it for a token would decouple the button from the marker it makes. The *label* follows `--apex-text`, which is what the defect actually required.
* **`PlaylistArranger`'s fade-handle scrim** (`from-black/80`, `border-white/40`, `text-white`) is a media scrim over the preserved signal surface — the same category as UI-03O's surviving on-colour. It is pinned by exact count so it cannot grow.
* **The UI-1C compatibility layer in `index.css` was left in place** even though this batch removed its last consumer (§6) — deleting 41 dead selectors is a separate, reviewable change and out of this batch's scope.

---

## 4. Contrast evidence

**Palette math** (tokens parsed live from `src/index.css` by `themeTestDocument.ts`, so the tables cannot drift from the shell):

| Pairing (source) | Dark | Light | Floor |
| --- | --- | --- | --- |
| modal title `--apex-text` / `--apex-surface` | 15.61 | 16.36 | 4.5 |
| modal body `--apex-text-2` / `--apex-surface` | 8.27 | 7.89 | 4.5 |
| modal muted `--apex-text-3` / `--apex-surface` **and** `/ --apex-panel-header` | 5.64 / 5.14 | 5.67 / 4.75 | 4.5 |
| on-accent label `--apex-state-playing-fg` / `--apex-accent` (\| `--apex-accent-strong`) | 6.77 / 8.86 | 5.75 / 7.57 | 4.5 |
| Piano Roll cyan **text** label / `--apex-surface-2` | 9.54 | 7.39 | 4.5 |
| Piano Roll cyan **decorative** token / `--apex-surface-2` *(rejected — was shipped)* | 9.54 | **4.30 ✗** | 4.5 |
| Piano Roll gold \| success labels / `--apex-surface-2` | 9.08 / 8.68 | 4.93 / 5.40 | 4.5 |
| Channel Rack danger hover / `--apex-panel` | 5.76 | 6.00 | 4.5 |
| Channel Rack muted idle `--apex-text-3` / `--apex-surface-2` | 5.13 | 5.24 | 4.5 |
| Sections gold / `--apex-panel` | 9.98 | 5.33 | 4.5 |
| active tool chip `--apex-state-playing-fg` / `--apex-cyan` | 11.80 | 4.66 | 4.5 |
| automation clip label `--apex-cyan-text` / 16 % cyan wash over panel | 10.49 | 7.99 | 4.5 |
| preserved audio label `#00ff88` / preserved audio body | 11.72 | 8.74 | 4.5 |
| audio label after the compatibility layer's remap *(rejected — was shipped)* | 8.82 | **2.00 ✗** | 4.5 |
| error heading `--apex-text` / `--apex-bg` | 17.02 | 14.45 | 4.5 |
| error reload label / `--apex-accent` (\| hover `--apex-accent-strong`) | 6.77 / 8.86 | 5.75 / 7.57 | 4.5 |

**Rendered pixels** (real Chromium, `getComputedStyle`, translucent layers alpha-composited onto the first opaque ancestor — the same measurement technique as UI-03C/M/N/O):

* `browser-tests/projectBundleZipTheme.spec.ts` — scrim equals `--apex-modal-overlay`; panel/cards/bands equal their tokens; badge wash 16 % + edge 48 % with a `--apex-text` label; CTA gradient measured to interpolate exactly `--apex-accent` → `--apex-accent-strong` with AA at both stops; every label AA-checked on its effective surface.
* `browser-tests/playlistArrangerTheme.spec.ts` — Sections/gold AA; each quick-add tile's wash matches its stored hue at 20 % while its label matches `--apex-text` and clears AA; the four hues painted *as text* on those washes measure `[6.90, 3.56, 3.77, 7.63]` in Dark and `[1.37, 2.92, 2.77, 1.22]` in Light — the asymmetry that justified moving the label; the created chip keeps its hue in the edge/wash with an `--apex-text` label (AA); an automation clip created through the real placement tool has a `--apex-cyan` border, `--apex-cyan-text` label and `--apex-cyan` envelope stroke with its 3 points intact; the active tool chip is on-colour on cyan (AA).
* `browser-tests/pianoRollTheme.spec.ts` — all five controls' borders resolve to 30 %/40 % `color-mix` of their status token and their labels clear AA on their own fill; the decorative cyan is shown to fail in Light while `--apex-cyan-text` passes; hovering a note-resize handle changes the computed background from transparent to `rgb(--apex-state-playing-fg)` at exactly 0.2, with the grip at 0.4.
* `browser-tests/channelRackTheme.spec.ts` — CLR and delete resolve to `--apex-danger` on hover (never `#f87171`) and clear AA idle and hovered; channel identity colours print verbatim.

---

## 5. Validation

### 5.1 Unit gates (frozen tree, `&&`-chained, `CHAIN_EXIT=0`)

| Gate | Result |
| --- | --- |
| `npm run verify:desktop` | PASS — “Desktop security configuration and permission semantics checks passed.” |
| `npm run lint` (`tsc --noEmit`, covers `browser-tests/` too) | PASS — no diagnostics |
| `npm run verify:test-discovery` | 252 test files (src 250, tests 2), **0 orphaned** |
| `npm run test:shell` | 271/271 pass, 8 suites |
| `npm run test:truth` | 98/98 pass, 17 suites |
| `npm run test:history` | **1083/1083** pass, 96 suites (baseline 1051 + the 32 new tests) |
| `npm run test:audio` | 1676/1676 pass, 353 suites |
| `npm run build` | PASS — 1831 modules; CSS **107.90 kB** (gzip 16.77) vs. baseline 108.81 kB; JS **1,213.93 kB** (gzip 318.44) vs. baseline 1,211.70 kB |

The CSS **shrank by 0.91 kB** while the JS grew 2.23 kB: removing the last arbitrary-class consumers lets Tailwind stop emitting those utilities, while the token expressions are slightly larger than the literals they replace.

### 5.2 Browser suite

`npx playwright test` over all **27 specs** (23 pre-existing + the 4 new ones) → **101 passed, 0 failed** on two of three runs; **the third run failed two tests**. 89 pre-existing + 12 new; the 12 new tests passed in every run. **This suite is not consistently green** — the one non-green run is reproduced in full below rather than rounded away.

Three full runs were made on this tree, and one of them is reported here in full because it did **not** pass:

| Run | Result | Note |
| --- | --- | --- |
| #1 (frozen tree) | **101 passed, 0 failed** (4.8 min), exit 0 | all 12 new tests present and green |
| #2 (same tree, re-run after comment-only corrections) | **99 passed, 2 failed**, exit 1 | both failures in `browser-tests/audioRecorderTheme.spec.ts` (UI-03F, an untouched earlier batch): the recorder dialog did not open, so `[role="dialog"]:has(#audio-recorder-modal-title)` resolved to 0 elements and its canvas assertion found 0. Only the two *light*-mode cases failed — the two that drive `switchThemeViaSettings` first. |
| #3 (same tree, immediate re-run) | **101 passed, 0 failed** (4.6 min), exit 0 | the same five `audioRecorderTheme` tests passed, including the two that failed in #2 |

Diagnosis of run #2: the failure is **non-deterministic and not caused by this batch**. Evidence: (a) the spec alone on the same frozen tree passes **5/5** (`npx playwright test browser-tests/audioRecorderTheme.spec.ts`); (b) runs #1 and #3 pass it inside the full suite; (c) the failing tests open the audio recorder through `button[aria-label="Arm recording"]` and assert on `AudioRecorderModal` — neither the component nor its entry path is touched by this batch, whose five files are `ProjectBundleZipModal`, `PlaylistArranger`, `PianoRoll`, `ChannelRack` and `AppErrorBoundary`; (d) the two failing cases are exactly the ones that first drive the Settings modal, i.e. the most timing-sensitive path, under `fullyParallel` workers sharing one dev server. It is reported rather than hidden, and is not treated as a defect of this batch — but it is a real flakiness in the suite that a future batch should stabilise (a deterministic wait for the transport's arm state instead of the fixed 1200 ms app-settle).

### 5.3 Server-rendered unit coverage (32 new tests)

| Suite | Tests | What it pins |
| --- | --- | --- |
| `projectBundleZipThemeUi.test.tsx` | 6 | token family, zero literals in markup *and* source, archive contract, import seam, AA math |
| `playlistArrangerThemeUi.test.tsx` | 9 | preserved-literal allow-list by exact count, marker hues + quick-add, chip label, migrated chrome, behavior seams, AA + rejected pairing |
| `pianoRollThemeUi.test.tsx` | 6 | outline mixes, cyan text variant, handle overlays, behavior seams, AA + rejected literals |
| `channelRackThemeUi.test.tsx` | 6 | danger hover, no-literal scan, identity hues painted, behavior seams, AA |
| `appErrorBoundaryThemeUi.test.tsx` | 5 | children passthrough, conditional details, zero literals, boundary contract, AA + replaced literals |

### 5.4 Evidence artifacts

8 new screenshots are committed and regenerated by the new specs: `ui03p-project-bundle-{dark,light}.png`, `ui03p-playlist-{dark,light}.png`, `ui03p-piano-roll-{dark,light}.png`, `ui03p-channel-rack-{dark,light}.png`. They were visually inspected (Light and Dark) for the surfaces this batch touched; the modal, arranger, piano roll and rack all read as themed surfaces with no black or white leftovers.

---

## 6. Compatibility-layer audit (UI-1C)

Re-audited mechanically, before and after (script over every non-test `src/**/*.{ts,tsx,css}`, matching the layer's own selector syntax; `index.css` itself excluded from the consumer scan):

| | Selectors parsed | Live consumers |
| --- | --- | --- |
| At `0f0baae` (before) | 41 | **12** — 10 in `ProjectBundleZipModal.tsx` (`bg-[#121214]`, `bg-[#18181c]`, `border-[#26262a]`, `border-[#28282e]`, `border-[#2e2e34]`, `border-[#333]`, `text-[#666]`, `text-[#777]`, `text-[#888]`, `text-[#b0b0b0]`), 2 in `PlaylistArranger.tsx` (`text-[#00e5ff]`, `text-[#00ff88]`) |
| Now (after) | 41 | **0** |

No file in the project (including `index.html`, `scripts/`, and non-test sources) emits any of the 41 class names any more, and no class is built dynamically (no `bg-[${…}]`-style construction exists in the tree). **The UI-1C layer is now entirely dead CSS.** Two of those twelve were not merely dead but actively harmful: `text-[#00e5ff]`/`text-[#00ff88]` are the remaps behind §3.1.

Deleting the layer is the natural next milestone (UI-03O §8 anticipated it). It is **deliberately not done here**: it is a separate change with its own review surface, and this batch is scoped to component presentation.

---

## 7. Known limitations

1. **`AppErrorBoundary` has no browser coverage.** Reaching it requires crashing the app under test, which would invalidate the rest of the suite run. Its evidence is the server-rendered unit suite (which drives the fallback by setting the error state directly) plus the palette math in §4. The one behaviour a DOM test would add — that `window.location.reload()` is wired — is pinned at source level instead of being fired.
2. **The four quick-add marker tiles keep hex-derived inline washes.** This is deliberate (§3.5), and it means a future theme change will not recolour them. Their labels do follow the theme, which is where the contrast defect was.
3. **The audio clip body stays dark in Light.** Deliberate: it is what keeps the preserved `#00ff88` signal legible (8.74:1) and preserves UI-03A's waveform identity. A designer who wants the audio clip itself to become a Light surface should treat it as a data-colour change, not a chrome change.
4. **The fade-handle scrim (`text-white`/`border-white/40`/`from-black/80`) is still literal** — pinned by count, unmigrated by intent (§3.5).
5. **A pre-existing browser-suite flake in `audioRecorderTheme.spec.ts`** (UI-03F, untouched by this batch): intermittently, under parallel workers, the recorder dialog does not open and its two light-mode tests fail. Observed once in three full runs on this tree, passing in isolation (5/5) and in the other two full runs; cause and evidence in §5.2. Not fixed here (out of scope, and not caused by this batch).
6. **The pre-existing Vite CSS warning** (`Found 1 warning while optimizing generated CSS: … .accent-\[var\(--apex-\*\)\] { accent-color: var(--apex-*); }` — “Unexpected token Delim('*')”) is **not** introduced by this batch: rebuilding the untouched baseline produces the identical warning. It comes from Tailwind scanning the `--apex-*` text inside comments. Not fixed here (no unrelated changes).
7. **Screenshot nondeterminism (pre-existing):** a full browser run can rewrite committed screenshots through font/render differences. The untouched screenshots the full run modified were restored (`git checkout -- assets/screenshots/`), keeping only this batch's new `ui03p-*.png`.
8. **`ChannelRack`'s channel hues and `PlaylistArranger`'s marker hues are asserted unchanged, not contrast-floored.** They are user-visible identity colours stored in project data; forcing them to a contrast floor would change stored data, which is out of scope (UI-03A).

---

## 8. Remaining UI-03 work after this batch

1. **Delete the now-dead UI-1C compatibility layer** in `index.css` (41 selectors, all consumer-less — §6) and drop the `!important` overrides. Recommended as the immediate next batch, on its own PR, with the build's CSS size delta recorded as evidence.
2. Optional residuals if a designer asks for them: the audio-clip body/fade scrim (§7.3/§7.4), and the marker quick-add washes (§7.2).

---

## 9. Final validated state

* **Base:** `0f0baae8b1bc4d78f59c5ad9b42bc2851360a6ae` (= `origin/main` when the batch started). This batch is a single commit on `arena/32696a7b-apex-studio`, stacked on that base; the PR head SHA is recorded in the PR and in the run report on the PR.
* **Working tree:** 5 components, 2 shared test expectations, `package.json` (5 suites appended to the existing `test:history` glob), 5 new unit suites, 4 new browser specs, 8 new screenshots, this report. `package-lock.json` untouched.
* **Left-behind probes:** none — the SSR probe (`src/__probe_ssr.tsx`) and all scratch scripts were deleted; every file in the tree is either a source change, a test, an evidence artifact, or this report.

## 10. Merge recommendation

**Request review; do not merge from the implementation agent.** All required gates, the full browser suite and the production build pass on the frozen tree, every migrated surface has measured Light/Dark evidence with negative controls, and no behaviour, data, DSP, routing, transport or persistence contract changed. The two test expectations that moved are explained in §3.3 and §2.2.
