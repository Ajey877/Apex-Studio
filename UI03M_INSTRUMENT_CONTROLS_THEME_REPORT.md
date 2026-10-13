# UI-03M — Batch 1: Instrument & Control Modals Light/Dark Theme Migration

**Baseline:** `main` @ `d4309d5b144e436573545effacb7a52691813eac` (PR #218, *UI-03L: MidiLearnModal Theme Migration*, `MERGED` at `2026-10-13T09:11:39Z`; merge commit == `origin/main` == this branch's base)
**Implementation branch:** `arena/14f5cfa4-apex-studio` (Arena session-bound branch)
**Batch:** 1 of 3 — *Instruments and Controls*
**Components:** `MasterMacroRackModal`, `MultiZoneSamplerModal`, `PolyphonicEditorModal`
**Scope:** those three components' presentation only, their focused unit and browser coverage, the shared modal-shell expectation, test-suite discovery wiring, screenshot-artifact hygiene, and this report. **No global CSS, no token definitions, no DSP, no MIDI semantics, no `ProjectState` shape, and no other component changed.**

---

## 1. Baseline verification before editing

| Check | Finding |
| --- | --- |
| Branch / HEAD before work | `arena/14f5cfa4-apex-studio` @ `d4309d5`, working tree clean |
| `git fetch origin --prune` | `origin/main` == `d4309d5b144e436573545effacb7a52691813eac` == local HEAD |
| PR #218 | `MERGED` `2026-10-13T09:11:39Z`, merge commit `d4309d5…` — confirms the UI-03L baseline |
| Pre-existing UI-03M PRs | none (`gh pr list --state all --search "UI-03M"` → `[]`) |
| Suites on the untouched baseline | `lint` PASS · `verify:test-discovery` PASS (236 files, 0 orphaned) · `test:shell` 271/271 · `test:truth` 98/98 · `midiLearnTheme.spec.ts` 2/2 |

**Roadmap reconciliation before editing.** `UI03A_THEME_FOUNDATION_REPORT.md` and the UI-03B…UI-03L reports were re-read against the tree. All eleven remaining planned modal migrations are unmigrated, and no planned UI-03 item other than those eleven is outstanding. A literal census confirmed each of the three Batch-1 targets still carried its full dark-only palette:

| Component | Lines | Hardcoded palette refs | `--apex-*` tokens |
| --- | --- | --- | --- |
| `MasterMacroRackModal` | 265 | 46 | 0 |
| `MultiZoneSamplerModal` | 383 | 60 | 0 |
| `PolyphonicEditorModal` | 387 | 63 | 0 |

None of the three was already complete, so none was skipped. The `index.css` UI-1C legacy-utility compatibility layer is **still required** and was left in place: it can only be deleted once every component converts, which Batches 2 and 3 have not yet done.

---

## 2. What changed

All three modals are DOM/SVG-rendered with no canvas, so the existing `--apex-*` tokens theme every surface directly — no palette seam, no theme observer, no new token. Across the three files **24 distinct existing tokens** are now consumed and **zero tokens were added**.

| Component | Lines | Hex literals | `--apex-*` token uses |
| --- | --- | --- | --- |
| `MasterMacroRackModal` | 265 → 291 | 46 → **9** (all persisted data) | 0 → **52** |
| `MultiZoneSamplerModal` | 383 → 414 | 60 → **0** | 0 → **81** |
| `PolyphonicEditorModal` | 387 → 426 | 63 → **1** (inert) | 0 → **88** |

The line growth is almost entirely explanatory comment; the presentation-only nature of the change is proved mechanically in §5.

### 2.1 Identity and signal colours

| Legacy | Meaning | Token | Precedent |
| --- | --- | --- | --- |
| `#00ff88` green | Macro-rack identity, Polyphonic prototype identity, root-pitch read-out, mapping MAX ceiling, audition glyph, ENABLED-style fills | `--apex-success` | UI-03H mapped `#00ff88` → `--apex-success` |
| `#ff6e00` warm orange | Multi-Zone Sampler identity (tile, badge, CTAs, key-range sliders) | `--apex-gold` | UI-03J/UI-03K mapped the orange identity → `--apex-gold` |
| `#00e5ff` cyan | Curve chip read-out, FORMANT SHIFT parameter | `--apex-cyan-text` (text) / `--apex-cyan` (control accent) | UI-03H used `-cyan-text` for small labels so they clear AA in Light |
| `#a855f7` purple | Fourth zone hue, third blob hue | `--apex-aux-text` | UI-03H mapped humanize purple → `--apex-aux`, using the `-text` variant where it is read as text |
| `#ffaa00` amber | NOT-APPLIED warning banner, PITCH DRIFT read-out, Split-Blob glyph | `--apex-gold` | UI-03H: "NOT APPLIED warnings use `--apex-gold`, the same token Parametric EQ and Audio Slicer use" |
| `text-black` / `text-black/80` on coloured fills | On-colour for solid identity fills | `--apex-state-playing-fg` | UI-03H: fixes 2.6:1 Dark / 1.9:1 Light failures |
| `bg-black/85 backdrop-blur-md` | Hand-rolled scrim | *removed* — `ModalFrame` supplies `--apex-modal-overlay` | UI-03B…UI-03L all dropped the dead fill |
| `#121215` / `#18181c` / `#141417` / `#0b0b0d` / `#16161a` / `#121214` | Panel, bands, cards, insets | `--apex-surface`, `--apex-panel-header`, `--apex-surface-2/3`, `--apex-canvas`, `--apex-chrome-inset` | UI-03L |
| `#e0e0e0` / `#181818` / `#111` | Reference piano-key strip | `--apex-piano-key-natural` / `--apex-piano-key-accidental` | The tokens `PianoRoll` already uses |
| `border-white/5`, `border-white/15` | Step grid and octave-lane rules | `color-mix(in srgb, var(--apex-text) 12% / 26%, transparent)` | Derived from the theme text colour so the grid stays visible on the dark inset **and** on the light one. `--apex-grid-line` was rejected: in Light it is `#e5e9f0` on a `#e3e8f0` inset, i.e. invisible |
| `hover:text-red-400` | Destructive delete | `--apex-danger` | UI-03L |
| `ring-white` / `ring-white/10` | Selection ring | `--apex-accent-strong` | `ChannelRack`, `PianoRoll`, `PlaylistArranger` |
| `text-amber-300` / `text-amber-400` | Formant-shift cue, Split-Blob glyph | `--apex-text` / `--apex-gold` | Tailwind named-palette utilities are not theme-aware |

Two deliberate surface choices, both driven by measurement rather than taste:

- **The Multi-Zone visualiser sits on `--apex-chrome-inset`, not `--apex-canvas`.** In Light, `--apex-canvas` and `--apex-surface-2` are the *same* colour (`#f4f6fa`), so the recessed keymap would have lost all separation from its card. `--apex-chrome-inset` reads `rgb(14.5,17.2,25.1)` in Dark against a `rgb(32,36,48)` card and `rgb(227,232,240)` in Light against `rgb(244,246,250)` — separation in both directions. `GrossBeatModal` already uses this token.
- **The knob-card hierarchy is `--apex-surface-2` (idle) → `--apex-surface-3` (selected)**, preserving the original's monotonic `#141417` → `#18181f` step in Dark and giving the equivalent step in Light.

### 2.2 Data colours: what was preserved and what was re-pointed

This batch had to separate three genuinely different kinds of colour. Each decision is pinned by a test.

**(a) `macro.color` — persisted project data → preserved byte-for-byte.**
`ProjectState.macroKnobs[].color` is a validated, saved field (`isMacroKnob`, `projectState.ts:499`). It is the same category UI-03A lists under *Explicitly preserved (not defects)* alongside `ch.color` and `DrumSamplerPanel`'s `PAD_COLORS`, and `ChannelRack.tsx:536` still paints `ch.color` directly today. It therefore survives unchanged on the value arc (`stroke={macro.color}`), the selected-card border, the range `accentColor`, and the mapping swatch — and `DEFAULT_MACRO_KNOBS` plus the add-macro rotation keep their exact `#ff6e00 / #00ff88 / #00e5ff / #a855f7 / #ffaa00` literals. The browser spec asserts `stroke="#ff6e00"` and `#ffaa00` on a newly created knob **in both themes**.

It is, however, **no longer painted as 10px text**. Measured on `--apex-surface-3`, the five stored hues as text give:

| Stored hue | Dark | Light |
| --- | --- | --- |
| `#ff6e00` | 5.04:1 | **2.37:1** |
| `#00ff88` | 10.54:1 | **1.13:1** |
| `#00e5ff` | 9.19:1 | **1.30:1** |
| `#a855f7` | **3.57:1** | **3.34:1** |
| `#ffaa00` | 7.41:1 | **1.61:1** |

So `{n} MAPPINGS` and `MAPPED DESTINATIONS FOR: <strong>` moved to `--apex-text-3` / `--apex-text`. The identity is not lost — the same colour is on the arc directly beneath the label, on the swatch in every mapping row, on the selected border and on the slider accent. This is the same refusal `mixerTheme.trackIdentityLabelColor` already encodes for Mixer strip names ("returns it unchanged when it already clears AA… otherwise lowers its lightness"). Selection additionally gained a themed `--apex-accent-strong` ring (6.54:1 / 6.39:1 on the selected card), so **selection never depends on a data colour alone**.

**(b) `KeyZone.color` — local decoration, never persisted → tokenised.**
`commitZones` strips it (`updated.map(({ name, color, ...zone }) => zone)`) and `SampleZone` has no `colour` field at all, so nothing reaches the project document. The four hues become `ZONE_IDENTITY_COLORS = ['var(--apex-gold)', 'var(--apex-success)', 'var(--apex-cyan-text)', 'var(--apex-aux-text)']` — hue-faithful to the `#ff6e00 / #00ff88 / #00e5ff / #a855f7` they replace, and each clearing WCAG 1.4.11 3:1 as a zone border on every surface it is painted on in both palettes (worst case: gold on `--apex-chrome-inset`, 11.05:1 Dark / 4.33:1 Light).

**(c) `INITIAL_BLOBS[].color` — module-local prototype decoration → tokenised.**
`PolyphonicEditorModal` takes no blob props and publishes nothing. Four hues map onto the token of the same hue (`#00e5ff`→cyan-text, `#00ff88`→success, `#a855f7`→aux-text, `#ff6e00`→gold). The two shared harmony-voice blobs were `#ffaa00`, one step from the lead's `#ff6e00`; both warm hues collapse onto `--apex-gold`, so the harmony pair takes `--apex-accent` instead and **all six demo blobs stay distinguishable** (five distinct hues). This is the one place where an exact legacy hue was not reproducible from the existing token set, and it is recorded as such in §7.

Because a hex-alpha suffix (`${zone.color}33`) cannot be appended to a `var()` reference, the block fills became `color-mix(in srgb, ${color} 22%, transparent)` (zones, matching the original `0x33` ≈ 20%) and `…27%…` (blobs, matching the original `0x44` ≈ 27%). These are inline styles resolved by Chromium, verified live in both themes — not Tailwind utilities, so they correctly do not appear in the compiled CSS.

### 2.3 Files touched

1. `src/components/MasterMacroRackModal.tsx` — presentation only.
2. `src/components/MultiZoneSamplerModal.tsx` — presentation only, plus two accessible names.
3. `src/components/PolyphonicEditorModal.tsx` — presentation only, plus one accessible name.
4. `src/components/masterMacroRackThemeUi.test.tsx` **(new, 11 tests)** — appended to `test:history`.
5. `src/components/multiZoneSamplerThemeUi.test.tsx` **(new, 11 tests)** — appended to `test:history`.
6. `src/components/polyphonicEditorThemeUi.test.tsx` **(new, 14 tests)** — appended to `test:history`.
7. `browser-tests/masterMacroRackTheme.spec.ts` **(new, 2 real-Chromium cases)**.
8. `browser-tests/multiZoneSamplerTheme.spec.ts` **(new, 2 real-Chromium cases)**.
9. `src/state/modalDialogShell.test.tsx` — **only** the three migrated `overlayClass` expectations, updated in lockstep to pin `ModalFrame`'s shared themed scrim and drop the dead black fill. No other case touched.
10. `package.json` — the three new suites added to the `test:history` glob list so `verify:test-discovery` keeps reporting 0 orphaned files.
11. `UI03M_INSTRUMENT_CONTROLS_THEME_REPORT.md` — this report.

### 2.4 Behavior explicitly untouched

Verified mechanically (§5) and by test: every `useState`/`useEffect`, prop signature, event handler, `audioEngine.playNote` call, published payload shape, control `min`/`max`/`step`, and every user-visible string. Specifically preserved:

- `handleKnobChange` → `setMacros` → `onUpdateMacros(updated)`; `handleAddMacro`'s generated id/name/rotation and its publish-then-select.
- `commitZones` → `onUpdateChannel(selectedChannel.id, { sampleZones: … })` with `name`/`color` stripped; the persisted-zones-then-`customSample` hydration order; `rootPitch ?? 60`; `if (zones.length <= 1) return;`.
- `handleAuditionZone` still plays `zone.rootNote` through the real engine; `handleAuditionBlob` still routes through `polyphonicBlobAuditionNote` on `PREVIEW_CHANNEL`, whose `durationSteps`→`Note.duration` pass-through (Phase 1B) is asserted unchanged.
- `handleQuantizeAllPitch`, `handleSplitBlob` (including the `durationSteps <= 2` guard and the length-conserving split).
- **Every prototype disclaimer.** `PolyphonicEditorModal` still reads `POLYPHONIC AUDIO BLOB EDITOR (PROTOTYPE)`, `PROTOTYPE — DEMO BLOBS`, `NOT APPLIED — PROTOTYPE, NO AUDIO ANALYSIS OR EDITING`, `SAMPLE BLOBS ONLY`, `6 Demo Blobs (not detected from audio)`, `Prototype: edits stay in this window and never reach the audio engine`, `Close Prototype`, and the audition toast still says *synth preview, not your audio*. A theme migration must not make a stub read as a working feature; `polyphonicEditorThemeUi.test.tsx` pins all nine strings and all six blobs' data, and `src/state/productTruthStrings.test.ts` (which reads this component) still passes at 98/98.

### 2.5 Accessibility additions

Three controls were icon-only or glyph-only with no accessible name. Naming them is the same kind of fix UI-03L recorded, and each is pinned by a test:

| Control | Added name |
| --- | --- |
| Multi-Zone inspector delete (`Trash2` only) | `aria-label={`Delete zone ${selectedZone.name}`}` |
| Multi-Zone status-toast dismiss (`✕`) | `aria-label="Dismiss status message"` |
| Polyphonic status-toast dismiss (`✕`) | `aria-label="Dismiss status message"` |

Nothing else about the a11y tree changed: dialog `id`s, `role="dialog"`, `aria-modal`, `aria-labelledby`, title ids and close labels are byte-identical, and `modalDialogShell.test.tsx` (28/28) still enforces them.

---

## 3. Three real defects found and fixed during validation

Each was found by measurement in a real browser or by the contrast matrix computed from the shipped `src/index.css` token values — not by inspection.

### 3.1 The macro knob card's hover feedback has never worked (fixed)

`MasterMacroRackModal` set `style={{ borderColor: isSelected ? macro.color : '#28282e' }}` on **every** card. An inline style beats a class, so the sibling `hover:border-[#444]` was dead: an unselected card never responded to the pointer. Measured live before the fix, idle and hovered were identical — `rgb(43,48,64)` Dark, `rgb(201,208,220)` Light.

The inline style now carries **only** the selected card's persisted identity colour (`style={isSelected ? { borderColor: macro.color } : undefined}`) and the idle card takes `border-[var(--apex-border)] hover:border-[var(--apex-grid-line-strong)]`. Measured after: idle `rgb(43,48,64)` → hovered `rgb(52,58,74)` in Dark. "Correct interaction states" is an explicit requirement of this migration, the fix is two lines of presentation, and the browser spec asserts the hover lift in both themes.

### 3.2 The status-toast dismiss glyph could not clear AA in Light (fixed)

The first implementation washed the `✕` to 78% of the on-colour for a hover step. The `✕` is **text**, so SC 1.4.3 applies at 4.5:1; measured on the fills it gives 7.00:1 Dark but **3.92:1 Light** on gold and **4.24:1 Light** on success. Both components now use the full-opacity on-colour in both states — byte-identical to the convention `WavetableSynthModal.tsx:195`, `AudioSlicerModal.tsx:294`, `PianoRoll.tsx:1387` and `PlaylistArranger.tsx:819` already ship (11.23:1 / 5.33:1 on gold; 10.73:1 / 5.85:1 on success). An alpha sweep confirmed 88% is the lowest wash that still clears Light, so the hover step was dropped rather than tuned to a margin of 0.03. Two unit assertions now forbid washing the on-colour below AA.

### 3.3 The NOT-APPLIED banner qualifier failed AA in Dark (fixed)

`SAMPLE BLOBS ONLY` at `--apex-text-3` on the 14% gold wash measures **4.17:1 in Dark**. Moved to `--apex-text-2`: 6.11:1 Dark / 6.51:1 Light. The banner's NOT-APPLIED statement itself uses `--apex-text` (11.54:1 / 13.51:1). Both are pinned.

### 3.4 Two findings deliberately *not* "fixed", with reasons

- **The knob's background arc track stays a low-contrast groove** (1.25:1 Dark, 1.31:1 Light on the selected card). This matches the shipped `#25252b`-on-`#18181f` relationship (~1.15:1). SC 1.4.11 covers graphical objects *required to understand the content*; the track is the groove behind the value, not the value indicator, and the value is also present as AA text in the knob centre (`--apex-text`, 12.97:1 / 13.81:1) and as a percentage. Inflating the groove to 3:1 would redesign the knob. The spec asserts instead that the track resolves from the palette (`--apex-grid-line-strong`) **and** stays distinguishable from its card in both themes.
- **The icon-only zone delete control's hovered `--apex-danger` glyph measures 4.46:1 Dark / 4.40:1 Light** on the hover-lifted band. SC 1.4.11 (3:1) is the applicable criterion for an icon-only control with no rendered text — the identical reading, at the identical 4.46:1, that `browser-tests/midiLearnTheme.spec.ts:383` already applies to its own icon-only delete. The idle state is still held to 4.5:1 (5.14:1 / 4.75:1).

---

## 4. Contrast evidence

Computed from the real `src/index.css` token values in both palettes, then **re-verified live** through `getComputedStyle` in Chromium. Text is held to WCAG 2.1 SC 1.4.3 (4.5:1) against the *effective composited surface* — translucent `color-mix()` washes are flattened onto the first opaque ancestor, because measuring a wash against its raw colour gives the wrong answer.

### 4.1 Text (SC 1.4.3, ≥ 4.5:1)

| Element | Surface | Dark | Light |
| --- | --- | --- | --- |
| Dialog title | `--apex-panel-header` | 14.22 | 13.69 |
| Subtitle / footer note / close idle / field labels | `--apex-panel-header` (`--apex-text-3`) | 5.14 | 4.75 |
| Panel body copy | `--apex-surface` (`--apex-text-2`) | 8.27 | 7.89 |
| Identity badge label | success-20% wash over header | 9.07 | 10.44 |
| Identity badge label | gold-20% wash over header | 8.99 | 10.57 |
| Knob mapping count | `--apex-surface-2/3` (`--apex-text-3`) | 5.13 | 4.69 |
| Knob value / name | `--apex-surface-2/3` (`--apex-text`) | 14.20 | 15.12 |
| Mapping row target / track id | `--apex-canvas` | 16.26 / 5.88 | 15.12 / 5.24 |
| Mapping **MAX** ceiling (green kept) | `--apex-canvas` (`--apex-success`) | 9.94 | 5.40 |
| Curve chip (cyan kept) | `--apex-surface-3` (`--apex-cyan-text`) | 8.72 | 6.74 |
| CTA on-colour | solid `--apex-success` | 10.73 | 5.85 |
| CTA on-colour, hovered | success mixed 82% toward text | 11.66 | 7.12 |
| CTA on-colour | solid `--apex-gold` | 11.23 | 5.33 |
| CTA on-colour, hovered | gold mixed 86% toward text | 11.93 | 6.31 |
| Status toast text + dismiss glyph | solid `--apex-gold` / `--apex-success` | 11.23 / 10.73 | 5.33 / 5.85 |
| NOT-APPLIED statement | gold-14% wash over `--apex-surface` | 11.54 | 13.51 |
| NOT-APPLIED qualifier | gold-14% wash over `--apex-surface` (`--apex-text-2`) | 6.11 | 6.51 |
| Zone block name | zone-hue 22% wash over `--apex-chrome-inset` | 10.69–11.94 | 9.46–10.04 |
| Zone block low/high notes | zone-hue 22% wash over inset (`--apex-text-2`) | 5.54–6.33 | 4.56–4.84 |
| Blob pitch / amplitude / formant labels | blob-hue 27% wash over inset (`--apex-text`) | 9.06–11.10 | 8.70–9.38 |
| Root-pitch read-out (green kept) | `--apex-panel-header` (`--apex-success`) | 8.69 | 4.89 |
| PITCH DRIFT read-out | `--apex-canvas` (`--apex-gold`) | 10.40 | 4.93 |
| FORMANT SHIFT read-out | `--apex-canvas` (`--apex-cyan-text`) | 10.93 | 7.39 |
| "N Demo Blobs" count | `--apex-surface-2` (`--apex-success`) | 8.68 | 5.40 |
| Piano-ruler labels | `--apex-surface-3` (`--apex-text-3`) | 4.69 | 4.79 |
| Audition label, idle and hovered | `--apex-surface-3` / 85%-toward-text | 12.97 / 8.22 | 13.81 / 10.30 |
| Form controls (`select`, text input) | `--apex-canvas` | 16.26 | 15.12 |

### 4.2 Non-text (SC 1.4.11, ≥ 3:1)

| Element | Against | Dark | Light |
| --- | --- | --- | --- |
| Identity tile / CTA, green | `--apex-panel-header` | 8.69 | 4.89 |
| Identity tile / CTA, gold | `--apex-panel-header` | 9.09 | 4.46 |
| Add Zone Split, gold | `--apex-surface-2` | 9.08 | 4.93 |
| Zone border, gold / success / cyan-text / aux-text | `--apex-chrome-inset` | 11.05 / 10.56 / 11.61 / 7.34 | 4.33 / 4.75 / 6.49 / 6.53 |
| Blob border, accent | `--apex-chrome-inset` | 6.66 | 4.67 |
| Selection ring `--apex-accent-strong` | `--apex-surface-3` / inset | 6.54 / 8.72 | 6.39 / 6.15 |
| Audition `Play` glyph, success | `--apex-surface-3` | 7.93 | 4.93 |
| Split `Scissors` glyph, gold | `--apex-surface-3` | 8.30 | 4.50 |
| Matrix `Settings` glyph, success | `--apex-panel-header` | 8.69 | 4.89 |
| Keymap `Music` glyph, gold | `--apex-surface-2` | 9.08 | 4.93 |
| Hovered delete glyph (icon-only) | washed header band | 4.46 | 4.40 |
| Piano naturals vs accidentals | each other | `rgb(32,36,48)` vs `rgb(17,19,26)` | `rgb(255,255,255)` vs `rgb(223,228,236)` |

Every ratio the browser specs assert was read from the running app; the specs re-derive them from live computed styles rather than trusting this table.

---

## 5. Proof the change is presentation-only

Each migrated file was normalised against its `d4309d5` baseline by stripping JSX and line comments and blanking **every** `className` value, then diffed token-by-token. What remains is the complete inventory of non-`className` changes:

**`MasterMacroRackModal` — 3**
1. `style={{ borderColor: isSelected ? macro.color : '#28282e' }}` → `style={isSelected ? { borderColor: macro.color } : undefined}` (§3.1 defect fix).
2. `<span style={{ color: macro.color }}>` → `<span className=…>` (data colour no longer text, §2.2a).
3. `<strong style={{ color: currentMacro.color }}>` → `<strong className=…>` (same).

**`MultiZoneSamplerModal` — 8**
1. new `ZONE_IDENTITY_COLORS` constant; 2–4. its three use sites replacing the literal hue arrays; 5. zone fill `${zone.color}33` → `color-mix(… 22% …)`; 6. root-note span drops `style={{ color: zone.color }}`; 7–8. the two `aria-label` additions (§2.5).

**`PolyphonicEditorModal` — 8**
1–6. the six `INITIAL_BLOBS[].color` literals → token references; 7. blob fill `${blob.color}44` → `color-mix(… 27% …)`; 8. the `aria-label` addition.

**No change to any handler, hook, prop signature, `audioEngine` call, published payload, control range, or string.** The `ModalFrame` invocation differs only in its `className`.

---

## 6. Validation (all executed in this run, on the final code)

Nothing below is inherited from an earlier run or from the UI-03L report. The suites invalidated by the §3.2/§3.3 fixes were re-run to completion afterwards.

| Gate | Command | Result |
| --- | --- | --- |
| TypeScript / lint | `npm run lint` (`tsc --noEmit`) | **PASS**, exit 0 |
| Desktop config | `npm run verify:desktop` | **PASS** |
| Test discovery | `npm run verify:test-discovery` | **PASS** — 239 files (src 237, tests 2), 239 covered, **0 orphaned** (was 236; +3 new suites) |
| New focused unit suites | `masterMacroRackThemeUi` + `multiZoneSamplerThemeUi` + `polyphonicEditorThemeUi` | **36/36 PASS** (11 + 11 + 14) |
| Shared modal shell | `src/state/modalDialogShell.test.tsx` | **28/28 PASS** |
| Product truth strings | `src/state/productTruthStrings.test.ts` | **PASS** (reads `PolyphonicEditorModal`) |
| Shell / theme foundation | `npm run test:shell` | **271/271 PASS** |
| Truthfulness | `npm run test:truth` | **98/98 PASS** |
| History / publication / theme UI | `npm run test:history` | **972/972 PASS**, 83 suites (was 936; **+36**) |
| Audio / DSP / state | `npm run test:audio` | **1676/1676 PASS**, 353 suites — unchanged, as expected for a presentation-only batch |
| **Full real-browser suite** | `npx playwright test` | **73 passed (3.6m)**, 0 failed (was 69; **+4**) |
| New per-component browser specs | `masterMacroRackTheme.spec.ts`, `multiZoneSamplerTheme.spec.ts` | **4/4 PASS** (2 each × Dark/Light) |
| Production build | `npm run build` | **PASS**, exit 0 — CSS 109.87 kB (gzip 17.26 kB), JS 1203.72 kB |
| Production CSS emission | scan of `dist/assets/index-*.css` | **PASS** — 25/25 expected token utilities present |
| Whitespace / conflict markers | `git diff --check` | **clean** |

**Production-CSS emission check.** Every new *utility class* is present in the compiled bundle: the gold and success fills, the 14/20/40/82/86% `color-mix` washes and hover steps, the `--apex-text` 12%/26% grid rules, `--apex-state-playing-fg` on-colour, `--apex-chrome-inset`, both `--apex-piano-key-*` tokens, `--apex-accent-strong`, `--apex-cyan-text`, `--apex-grid-line-strong`, `--apex-state-hover`, `--apex-danger`, `--apex-canvas`, `--apex-panel-header`; and all 24 token *definitions* survive into the bundle. The 22%/27% zone and blob washes are correctly **absent** — they are inline styles built from a template literal, resolved by Chromium at runtime and verified live in both themes, not statically extractable classes.

**Legacy literals still in the compiled CSS, and why that is correct.** `.bg-\[\#00ff88\]`, `.bg-\[\#ff6e00\]`, `.text-\[\#777\]`, `.bg-\[\#18181c\]`, `.bg-\[\#121215\]`, `.bg-\[\#0b0b0d\]` and `.hover\:text-red-400` are still emitted. Each was traced to its remaining consumers and **none is a Batch-1 file**: `SidechainRoutingModal`, `TakeCompingModal`, `WarpAudioProcessorModal` (Batch 2); `CollaborationModal`, `HotkeysModal`, `AnalyticsModal`, `OrientationLockModal`, `DesktopAppModal` (Batch 3); plus the untouched `ProjectBundleZipModal`, `PlaylistArranger` and `ChannelRack`. `.text-amber-300`, `.text-amber-400`, `.bg-\[\#e0e0e0\]`, `.bg-\[\#181818\]`, `.border-white\/5` and `.ring-white` are **gone**. This is the expected intermediate state and the concrete reason the UI-1C compatibility layer cannot be deleted yet.

**Browser-spec coverage** (both themes, live `getComputedStyle`, no stubbed styles): themed scrim and every chrome surface; identity tile/badge/CTA fills with on-colour AA and 3:1 against their band; the persisted `macro.color` on arc, border, range accent and swatch; arc geometry (`20, 100` → `80, 100`) and value read-outs tracking the slider; card selection re-pointing the mapping matrix; the §3.1 hover lift; Add Macro → 5 knobs → `MACRO 5 (CUSTOM)` with the fifth data colour `#ffaa00`; Escape; **cross-reopen persistence** (5 knobs, the edited 80% value, 2 zones then 1); the 48-key piano strip on both piano tokens; the 8 octave lanes; inset-vs-card separation; the add-zone flow with its toast, zone block wash/border/ring and inspector; the three range clamping invariants before and after an edit (`[0,72,60] [60,127,72] [60,72,60]` → `[0,72,48] [48,127,72] [48,72,60]`) and the resulting block geometry (`left 37.7953%`, `width 19.685%`); audition through the real engine; the one-zone delete guard; a second zone taking the next palette hue; the toast auto-dismiss timer; and keyboard initial focus, tab order and focus rings at 2px solid `--apex-accent` @ 0.78 in both themes — including that a *pointer*-focused control correctly shows no ring.

### 6.1 Negative controls (proving the new assertions are not vacuous)

All three controls were run against the **final** code, after the §3 fixes, and each was reverted from a saved copy.

| # | Injected regression | Result |
| --- | --- | --- |
| 1 | Two dark-only chrome literals per component (`bg-[#18181c]` header band, `text-white` title) restored in all three files | **5 of 64 fail**, all of them literal scanners: `carries no fixed chrome palette in any rendered state…`, `carries no fixed palette in any rendered class…` (×2, one per component), `…in any className in the source, including the post-hydration branches`, `carries no chrome literal anywhere in the component code`. The other **59** rendering, behaviour and truthfulness assertions correctly stay green — the failures are specific, not blanket. |
| 2 | All 10 `var(--apex-success)` → `var(--apex-accent)` in `MasterMacroRackModal` | **2 of 11 fail**: `keeps the rack's green identity, the MAX ceiling and the curve chip meanings` and `renders a single stored knob without the matrix losing its target rows`. |
| 3 | The §3.3 fix reverted — `SAMPLE BLOBS ONLY` back to `--apex-text-3` | **1 of 14 fails**: `keeps the NOT-APPLIED banner qualifier at AA on the gold wash`. |

After restoring all three, the four suites were re-run to **64/64 green** (36 new + 28 modal-shell) before continuing.

### 6.2 Unrelated changes caught and reverted

- **`package-lock.json`** was rewritten by the environment's `npm install --legacy-peer-deps` (203 lines of `@electron/windows-sign` and peer-optional entries removed). It is not part of this migration and was reverted with `git checkout --`; the final diff contains no lockfile change.
- **`assets/screenshots/*.png`** — the full browser suite rewrites `ui03b-mastering-light-after-live-switch.png`, `ui03c-aux-dark.png`, `ui03c-aux-light.png` and `ui03e-audio-slicer-light.png` through font/render nondeterminism in this sandbox. None belongs to a Batch-1 spec; all four were reverted with `git checkout -- assets/screenshots/` and the working tree confirmed clean before committing.

### 6.3 Environment note

`npx playwright install chromium` fails in this sandbox (`ECONNRESET` on `cdn.playwright.dev`), as the UI-03L report records. Chromium was staged out-of-tree from `@sparticuz/chromium@153.0.0` (npm registry is reachable) into `/tmp`, which `playwright.config.ts` already auto-detects. **Nothing was added to the repository for this** — the diff contains no browser binary, no config change and no cache directory. GitHub Actions installs Chromium normally via `npx playwright install --with-deps chromium`, so CI is unaffected.

---

## 7. Known limitations

1. **`PolyphonicEditorModal` is unreachable from the UI, so it has no browser spec.** `App.tsx:2016` passes `onOpenPolyphonicEditor={() => setIsPolyphonicEditorOpen(true)}` to `TransportBar`, which declares the prop in its interface (`TransportBar.tsx:61`) but **never destructures or calls it** — zero occurrences inside the component body. `setIsPolyphonicEditorOpen(true)` has exactly that one call site, there is no `applicationMenu` command, no hotkey, and no `fl-polyphonic-*` trigger anywhere in `src/`. `isPolyphonicEditorOpen` therefore can never become `true`. This is a pre-existing product defect, **not** introduced or altered here; adding an entry point is a product/architecture decision outside a theme migration, so it was deliberately not made. Coverage is instead: 13 unit/markup tests (the blobs are module state, not an effect, so the full surface — six blobs, ruler, 16-step grid, inspector, three parameters, footer — renders under `renderToStaticMarkup` and is asserted in both themes), the shared `modalDialogShell` contract, the `productTruthStrings` guard, and the production-CSS emission check. Its token vocabulary is identical to the other two, whose live Dark/Light resolution is verified in Chromium.
2. **The exact legacy blob hues are not reproducible from the existing token set.** `#ff6e00` and `#ffaa00` are one step apart and both collapse onto `--apex-gold`; the harmony pair was moved to `--apex-accent` so all six demo blobs stay distinguishable. No new token was introduced to preserve them, per the batch constraint.
3. **Shared semantic tokens are not byte-identical to the legacy literals in Dark.** `--apex-success` is `#62d7a4` where the shipped literal was `#00ff88`; `--apex-gold` is `#ffb86b` where it was `#ff6e00`. Same hue family, lower saturation, and the change is what makes them clear AA in Light. UI-03H/J/K record the same trade-off. Dark therefore shifts slightly for those fills — and shifts *more* for solid neon-green fills, because the compatibility layer maps `text-[#00ff88]` → `--apex-success` but has **no `bg-[#00ff88]` rule at all**, so those fills previously rendered as raw literal neon green in both themes. That is a dark-only defect this batch removes.
4. **`accent-*` utilities are dead app-wide** (pre-existing, not touched). `src/index.css:144` declares `input[type="range"], input[type="checkbox"], progress { accent-color: var(--apex-accent); }` **outside any `@layer`**, and unlayered CSS beats every Tailwind utility in `@layer utilities`. Reproduced in Chromium: a freshly created `<input type="range" class="accent-[var(--apex-gold)]">` computes to `rgb(155,138,251)` Dark / `rgb(101,82,206)` Light — identical to a bare input with no class. This affects already-merged modals too (ArpeggiatorModal's `accent-[var(--apex-cyan)]`, VocalTuner's four slider accents) and the legacy `accent-[#…]` literals. Fixing it means editing global CSS, which this batch is explicitly not allowed to do. The migrated classes were still written to declare the intended per-control hue, and **no Light-theme readability bug results**: the computed accent resolves `--apex-accent`, which is theme-correct in both palettes. `MasterMacroRackModal`'s knob sliders are unaffected because they set `accentColor` inline (inline beats unlayered), and the browser spec asserts the persisted data colour there.
5. **`--apex-canvas` and `--apex-surface-2` are the same colour in Light** (`#f4f6fa`). Where the original design nested one inside the other, separation had to come from a different token (§2.1) or from a border. This is a property of the existing palette, not something introduced here.
6. **Multi-Zone zone hydration renames zones.** After `Add Zone Split`, the publish triggers the hydration effect, which reassigns `name: 'Zone ' + (index + 1)` — so a user-typed zone name is overwritten. This is pre-existing behaviour, unchanged, and the browser spec asserts what actually happens (`Zone 1`) rather than what might be intended. The zone-name text field is themed and its value asserted, but the spec deliberately does not claim renaming works.
7. **`statusMessage` survives close/reopen** in `MultiZoneSamplerModal` because the component stays mounted while the dialog returns `null`. Pre-existing; the spec documents it in a comment and waits for the auto-dismiss timer rather than clicking the dismiss control — `ModalFrame` handles Escape through a keydown handler on the overlay itself, so removing the focused button would drop focus to `<body>` and strand the dialog.
8. **No jsdom in this repository.** Unit suites use `renderToStaticMarkup`, so `useEffect` never runs. `MultiZoneSamplerModal` hydrates its zones in an effect, which is why its zone blocks and inspector are pinned by scanning every `className` in the source (including the post-hydration branches) and exercised live in Chromium, rather than by first-paint markup. `MasterMacroRackModal` and `PolyphonicEditorModal` initialise from `useState` values and render fully.
9. **The legacy-utility compatibility layer in `index.css` remains.** It can only be removed once Batches 2 and 3 convert the remaining eight modals plus `ProjectBundleZipModal`, `PlaylistArranger` and `ChannelRack`.

---

## 8. Remaining UI-03 work after this batch

Eight modals remain, exactly as planned:

- **Batch 2 — Audio Workflow:** `SidechainRoutingModal` (289 lines / 58 literals), `TakeCompingModal` (175 / 38), `WarpAudioProcessorModal` (271 / 49).
- **Batch 3 — Utility Interfaces:** `CollaborationModal` (204 / 47), `HotkeysModal` (137 / 24), `AnalyticsModal` (231 / 42), `OrientationLockModal` (146 / 30), `DesktopAppModal` (671 / 137).

Notes carried forward for those batches: `HotkeysModal` exports `HOTKEY_GROUPS`, guarded by `src/state/hotkeyDocumentation.test.ts` — every row must keep tracing to a real handler. `AnalyticsModal` is opened by the `project.statistics` application-menu command, not by a transport button. `OrientationLockModal` is **not** a `ModalFrame` dialog and is **not** in `MODAL_CASES`; it self-detects (`innerHeight > innerWidth` and touch-or-narrow) and needs a viewport/emulation-driven spec. `modalDialogShell.test.tsx` `OVERLAY_STUDIO` is still referenced by the Batch-2/3 cases, so it must not be removed until the last of them converts.

---

## 9. Merge recommendation

**Recommend merging.** All eleven validation gates pass on the final code, including the full 73-case real-browser suite in both themes and a clean production build. The change is presentation-only, proved mechanically in §5, with three real defects fixed (§3.1–3.3), two findings deliberately left alone with stated WCAG reasoning (§3.4), zero new design tokens, zero global-CSS changes, and no weakening of any existing assertion. `test:audio` is unchanged at 1676/1676 and `test:truth` at 98/98, which is the expected signature of a migration that touched no DSP and no truth copy.

One item needs a product decision that is **not** part of this PR and should be tracked separately: `PolyphonicEditorModal` is unreachable from the UI (§7.1). The modal is now theme-correct and fully tested, but no user can open it.
