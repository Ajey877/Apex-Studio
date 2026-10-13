# UI-03A — Design System & Light/Dark Theme Foundation

**Baseline:** `main` @ `7fd75dc702bfa081f2b987159851b9032bac2f6d` (PR #206, Phase 90)
**Scope:** theme foundation only. The visual identity, the token architecture and the
Settings surface were extended, not replaced.

This document exists for one reason: to record precisely which surfaces are theme-correct
after this phase and which are not, so the remaining migration can be scoped honestly in
later phases instead of being implied as finished.

---

## What is theme-correct now

Both palettes are correct, verified, and locked by tests for:

| Surface | Notes |
| --- | --- |
| Application menu bar (`#application-menu-bar`) | Moved off the legacy neutral palette onto `--apex-chrome-menu`, `--apex-border`, `--apex-text-2`, `--apex-state-hover`, `--apex-state-selected`, `--apex-state-disabled`. |
| Transport bar, view ribbon, status bar, browser pane, channel rack | Already tokenised before this phase; unchanged. |
| Settings dialog (`#appearance-settings-modal`) | New. Every colour is a token, including its scrim. |
| Modal scrims for all framed dialogs | Now themed per palette via `--apex-modal-overlay`. |
| Global focus ring, native form-control accent, scrollbars | Tokenised globally. |
| Playlist / Piano Roll / Mixer structural surfaces | Already tokenised before this phase; data colours (track identity, waveform, VU) deliberately left as-is. |

## What is still dark-only

These are real, visible defects in the Light theme. They are **not** fixed by this phase and
should not be described as if they were.

### 1. Legacy modal bodies — 1,569 hardcoded literals across 25 components

> **UI-03B status:** `MasteringSuiteModal.tsx` (the largest offender below) has since been
> migrated to the semantic token system, canvas included — see
> `UI03B_MASTERING_SUITE_THEME_REPORT.md`. The "remaining 24 bodies" wording records the
> UI-03B snapshot only; UI-03C through UI-03H have since migrated additional planned surfaces.
>
> **Current migration status — main @ `e9b799ba766f9c5546e980109ca7a6e14064c90a` (PR #216, UI-03J):**
> UI-03B Mastering Suite, UI-03C Mixer, UI-03D Wavetable Synth, UI-03E Audio Slicer,
> UI-03F Audio Recorder, UI-03G Parametric EQ, UI-03H Vocal Tuner, UI-03I MIDI Controller,
> and UI-03J Gross Beat are merged. Their individual reports remain the implementation and
> validation evidence.
>
> **UI-03K status:** the `ArpeggiatorModal` theme migration is implemented on the current
> Arena session branch; its dedicated PR is pending review/merge. The implementation report
> records the exact scope and validation for this phase.
>
> **Remaining planned modal order:** UI-03K `ArpeggiatorModal` (implementation in the current
> branch; PR pending review), then `MidiLearnModal`, `MasterMacroRackModal`,
> `MultiZoneSamplerModal`, `PolyphonicEditorModal`, `SidechainRoutingModal`, `TakeCompingModal`,
> `WarpAudioProcessorModal`, `CollaborationModal`, `HotkeysModal`, `AnalyticsModal`,
> `OrientationLockModal`, and `DesktopAppModal`. The order follows the verified UI-03
> migration plan; completed or already-tokenised modals are excluded.

Each of these files paints its own body with literals (`bg-[#18181b]`, `bg-[#141416]`,
`border-[#2a2a2d]`, `text-[#888]`, …). The compatibility layer in `index.css` only remaps the
subset of names it knows about, and several of the literals in use are not in that subset at
all — `#18181b` and `#27272a` are concrete examples.

Largest offenders, by literal count:

| File | Literals |
| --- | --- |
| `MasteringSuiteModal.tsx` | 207 |
| `DesktopAppModal.tsx` | 136 |
| `MidiControllerModal.tsx` | 131 |
| `VocalTunerModal.tsx` | 90 |
| `AudioRecorderModal.tsx` | 77 |
| `MidiLearnModal.tsx` | 74 |
| `GrossBeatModal.tsx` | 72 |
| `AudioSlicerModal.tsx` | 64 |
| `ArpeggiatorModal.tsx` | 64 |
| `WavetableSynthModal.tsx` | 62 |
| …19 more | 592 |

Observed symptom: with Light active, these dialogs render as a dark body with a light header
band (the header band is a remapped legacy name, the body is not). Screenshot:
`assets/screenshots/ui03a-theme-light-remaining-work.png`.

**Why it was not fixed here:** the phase brief explicitly rules out an automatic rewrite of
thousands of colour literals. Doing it properly is a per-component pass, because several of
these literals are *intentional* data or signal colours rather than chrome — the mastering
band accents (`#ffaa00`, `#00ff88`, `#00e5ff`), the meter gradient in `Mixer.tsx`, the
waveform identity colour in `PlaylistArranger.tsx` — and a mechanical rewrite would destroy
them. `Theme-critical surfaces carry no hardcoded neutral literals` in
`src/state/ui03aThemeFoundation.test.ts` pins the six surfaces this phase *did* convert so
they cannot regress.

### 2. Canvas-rendered interfaces

`AudioRecorderModal.tsx`, `AudioSlicerModal.tsx`, `MasteringSuiteModal.tsx`, `Mixer.tsx`,
`ParametricEqModal.tsx`, `WavetableSynthModal.tsx` draw with `getContext('2d')` and pass
literal palettes to `fillStyle` / `strokeStyle`. Canvas content cannot read CSS custom
properties through Tailwind classes; each one needs its own token read at draw time (for
example via `getComputedStyle(document.documentElement).getPropertyValue(...)` cached per
theme change). This is a separate, mechanical-but-deliberate change per component.

### 3. Remaining legacy compatibility layer

`index.css` still carries the UI-1C compatibility layer that maps old utility names onto
tokens. It is now *safe* (every rule resolves through a token, and a test enforces that no
literal can reappear), but it is still a translation layer. It can be deleted once every
component above is converted.

## Explicitly preserved (not defects)

These are project data, not chrome, and must not be converted to theme tokens:

- Track/channel identity colours (`ch.color` in the channel rack and playlist).
- Drum-pad identity colours (`PAD_COLORS` in `DrumSamplerPanel.tsx`).
- Waveform identity colour `#00ff88` for dropped audio clips in `PlaylistArranger.tsx`.
- The mixer VU gradient `linear-gradient(to top, #00ff00 60%, #ff6e00 85%, #ff0000 100%)`.
- Sample start/end trim markers (`--apex-success` / `--apex-danger`).
- Mastering band accents.
- The Light-theme scrim is intentionally lighter in weight than the Dark one for the same
  reason: a near-black wash over a light canvas reads as a blackout rather than a dim.

## Token architecture

No competing design system was introduced. The existing Midnight Aurora `:root` block remains
the single source of palette; the Light theme is an override layer on
`:root[data-theme="light"]`. UI-03A adds or reconciles:

- `--apex-state-focus` is now the one focus-ring token (the global
  `button:focus-visible, input:focus-visible, …` ring previously used a 75%-alpha violet
  instead of the token).
- `--apex-modal-overlay` is theme-scoped instead of dark-only.
- `--apex-text-3` and `--apex-text-muted` were darkened/lightened per palette until every
  text step cleared 4.5:1 on *every* surface token, not only on the page background.
- `color-scheme` no longer carries a bare `:root` declaration; it is scoped to
  `[data-theme]`, with `:root:not([data-theme])` as the pre-paint fallback only.
