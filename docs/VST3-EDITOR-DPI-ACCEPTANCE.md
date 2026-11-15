# Native VST3 editor — high-DPI and multi-monitor acceptance (P9)

This document covers one question: does the native VST3 editor window have the
right size, layout and input mapping when Windows is at 125% or 150%, when the
scale changes while the editor is open, and when the window moves between
displays that use different scales?

It complements [`VST3-EDITOR-ACCEPTANCE.md`](VST3-EDITOR-ACCEPTANCE.md), which
remains the specification for everything else about the editor window.

## Status at `684ff89`, the measured commit

Phrased against the measured commit, as that document requires. Anything committed
after `684ff89` on this branch is documentation and checked-in evidence only.

| Layer | Result | Where it was measured |
| --- | --- | --- |
| Helper-level, one display | P9-A, B, C, G, H, I, J, K, L, M **PASS**. P9-D, E, F **NOT_VERIFIED** (one display). | `P9 High-DPI Editor Acceptance` run 43712043056 (#11), job `branch` |
| Helper-level, two displays | **All 13 cases PASS** (672 of 672 checks). | Same run, job `branch-second-display` — a **virtual** second display, see [below](#the-second-display-is-virtual) |
| Helper-level, code before this change | P9-K **FAIL**, reproduced. | Same run, job `baseline` (expected to fail; `continue-on-error`) |
| Packaged application | `p9-dpi-125-150` **PASS** at real 100%, 125% and 150%. `p9b-multi-monitor` **NOT_VERIFIED**. Totals: 10 PASS, 0 FAIL, 1 NOT_VERIFIED. | `Desktop Validation` run 43712043018 (#1225), job `windows-package` |
| Interactive checklist (Part 2 of the main document) | **Not executed.** | — |

All of it ran on GitHub's `windows-latest` runner: Windows Server 2025 Datacenter
10.0.26100, image `win25-vs2026`, interactive session, primary display 1920×1080.
No physical monitor and no person was involved. Nothing was run on Windows 11
client hardware.

## What was wrong

Two defects, both found by running the editor at a real display scale. Opening the
editor at a fixed scale was already correct before this change; both defects needed
the scale to *change* under an open editor.

### 1. Scale change while the editor is open (P9-K)

On `WM_DPICHANGED` the host first moved the window to the rectangle Windows
suggested and only then told the plug-in its new scale. The plug-in therefore
received the new pixel size while it still believed in the old scale, treated that
size as its new layout size, and then scaled it again.

Measured on the baseline job (AGain, 350×120 at 100%):

| Change | Client area | Expected |
| --- | --- | --- |
| 100% → 125% | 548×182 | 437×150 |
| 125% → 150% | 626×202 | 525×180 |
| 150% → 125% | 364×118, then the helper stopped answering (timeout after 45 s) | 437×150 |

Window and plug-in view no longer agreed (at 125% the view was 550×190 in a 548×182
client area), and the drawing left blank strips on the right and at the bottom (`baseline-live-2-to-150.png` against
`branch-live-2-to-150.png` in `docs/evidence/p9/`).

### 2. Dragging the window to a display with another scale (P9-F)

Found after the first fix, once a second display was available. During a
title-bar drag Windows resizes the window *before* it sends `WM_DPICHANGED`. The
recorded order was `WM_GETDPISCALEDSIZE`, `WM_WINDOWPOSCHANGING`, `WM_SIZE`,
`WM_DPICHANGED`. The host forwarded that early `WM_SIZE` to the plug-in at the old
scale, with the same effect as above in the other direction: after a drag from a
125% display to a 100% display the client area was 276×88, from 150% it was 228×67.
Expected in both cases: 350×120.

Moving the window with `SetWindowPos` did not show this, because that route does not
resize before `WM_DPICHANGED`. Only a real drag did.

## How the host behaves now

The sizing decisions are plain functions in `native/vst3/editor-dpi.hpp`, so they are
unit-tested on every platform (`native/vst3/editor-dpi-test.cpp`). The window code
that uses them is in `native/vst3/editor-host.hpp`.

1. **The plug-in is told the scale first, and it chooses the size.** On
   `WM_DPICHANGED` the host calls `setContentScaleFactor`, lets the plug-in request
   its new size through `resizeView`, and fits the window to that. The rectangle
   Windows suggests is used for the position only. If the plug-in requests nothing,
   the host scales the last agreed size itself and checks it with
   `checkSizeConstraint`.
2. **A size that arrives before its `WM_DPICHANGED` is withheld.** While the window is
   being dragged, a `WM_SIZE` for a DPI the plug-in has not been told about is not
   forwarded. `WM_DPICHANGED` then sizes the editor. If no DPI change follows, the
   size is delivered when the drag ends.
3. **`WM_GETDPISCALEDSIZE` is answered** with the editor's real outer size at the new
   DPI, so Windows moves the window at the right size instead of a linear guess.
4. **The frame is measured for the DPI in use** (`AdjustWindowRectExForDpi`), and
   refreshed before a client size read inside a DPI change is trusted.
5. **A plug-in without `IPlugViewContentScaleSupport` keeps its own pixel size.** The
   window is fitted to it; the host does not stretch it.
6. **A fixed-size editor stays fixed**, but is no longer pinned to the size it had at
   the old scale, which would have clamped the plug-in's request away.
7. The helper declares per-monitor-v2 DPI awareness and reports what it asked for and
   what it got.

## The cases

`scripts/native-editor-dpi-acceptance.mjs` runs them. It changes the display scale
the way the Settings app does (`scripts/windows-display-scale.ps1`), so Windows
reports the DPI and Windows sends `WM_DPICHANGED`. The script never posts a DPI
message and never sets a scale factor by hand. Input is real OS input (`SendInput`).

| Case | What it checks | One display | Two displays | Baseline |
| --- | --- | --- | --- | --- |
| P9-A | Open at 100% | PASS | PASS | PASS |
| P9-B | Open at 125%: size, frame, layout, click position | PASS | PASS | PASS |
| P9-C | Open at 150%: same | PASS | PASS | PASS |
| P9-D | Second display at 125%, primary at 100% | NOT_VERIFIED | PASS | NOT_VERIFIED |
| P9-E | Second display at 150%, primary at 100% | NOT_VERIFIED | PASS | NOT_VERIFIED |
| P9-F | Move between the displays, three crossings plus a real title-bar drag | NOT_VERIFIED | PASS | NOT_VERIFIED |
| P9-G | Resize by dragging the border, and the plug-in's size constraints | PASS | PASS | NOT_VERIFIED |
| P9-H | Close and reopen: no stale window, no leak | PASS | PASS | PASS |
| P9-I | Keyboard, mouse wheel and focus | PASS | PASS | PASS |
| P9-J | State captured and preserved when the window is destroyed | PASS | PASS | PASS |
| P9-K | Scale changed while the editor is open: 100 → 125 → 150 → 125 → 100 | PASS | PASS | **FAIL** |
| P9-L | Plug-in without content-scale support at 150% | PASS | PASS | NOT_VERIFIED |
| P9-M | Fixed-size editor across a real scale change | PASS | PASS | NOT_VERIFIED |

P9-A to P9-J are the cases that were asked for. P9-K, L and M were added because the
defects sit exactly there.

The `NOT_VERIFIED` entries in the baseline column are honest gaps, not passes: the
old helper cannot drag a border and has no test mode for L and M. The baseline job
builds the native sources of `c246e2a` and runs today's script against them.

A case that was not executed is `NOT_VERIFIED`. With one display, P9-D, E and F are
`NOT_VERIFIED` whatever the other cases did.

### Measured values (`branch-second-display`)

AGain's editor is 350×120 at 100%. DPI awareness obtained: `per-monitor-v2`.

| Situation | Window DPI | Client area | Plug-in view | Outer window |
| --- | --- | --- | --- | --- |
| Opened at 100% | 96 | 350×120 | 350×120 | 366×159 |
| Opened at 125% | 120 | 437×150 | 437×150 | 455×197 |
| Opened at 150% | 144 | 525×180 | 525×180 | 547×236 |
| Live change to 125% | 120 | 437×150 | 437×150 | — |
| Live change to 150% | 144 | 525×180 | 525×180 | — |
| Live change back to 125% | 120 | 437×150 | 437×150 | — |
| Live change back to 100% | 96 | 350×120 | 350×120 | — |
| On the second display at 125% | 120 | 437×150 | 437×150 | — |
| On the second display at 150% | 144 | 525×180 | 525×180 | — |
| After each crossing back to the primary | 96 | 350×120 | 350×120 | — |
| After a title-bar drag back to the primary | 96 | 350×120 | 350×120 | 366×159 |

Every live change was a real `WM_DPICHANGED`, and the final size came from the
plug-in's own request (`source=plugin-requested`). The crossings must return the exact
size, not a size within a tolerance.

Message order recorded during the title-bar drag from the 125% display to the 100%
display, after the fix:

```
enter | getDpiScaledSize 96 (×3) | posChanging 366×159 | getDpiScaledSize 96 |
posChanged 366×159 | size 348×112 (withheld) | dpiChanged 96 |
size 350×120 (requested by the plug-in, inside WM_DPICHANGED) | exit
```

The `348×112` is the size Windows applied early, measured with the frame of the old
DPI. It is the one that used to reach the plug-in.

## The second display is virtual

The runner has one display. The job `branch-second-display` adds a second one with
the open-source [Virtual Display Driver](https://github.com/VirtualDrivers/Virtual-Display-Driver)
(MIT), installed by `scripts/ci-install-virtual-display.ps1` through
[nefcon](https://github.com/nefarius/nefcon) (MIT). Both downloads are pinned by
SHA-256 and the script refuses a file that does not match. It does nothing outside a
GitHub-hosted runner, and it is never part of the application.

Windows then reports two displays, each 1920×1080, each with its own scale, and the
editor is opened on, moved to and dragged across both. That is real Windows
per-monitor DPI behaviour. It is **not** two physical monitors: no GPU scan-out, no
differing panel sizes, no monitor hot-plug. A check on real hardware is still worth
doing once; the attended mode below does it.

## Packaged application

`scripts/packaged-editor-acceptance.mjs` drives the installed Electron app. With
`APEX_P9_ALLOW_DISPLAY_CHANGES=1` (set in `desktop-validation.yml`) its criterion
`p9-dpi-125-150` opens the editor from the Mixer at a real 100%, 125% and 150% and
compares size and layout. It was a hard-coded `NOT_VERIFIED` before.

Measured at `684ff89` with ApexAcceptanceGain (320×120 at 100%):

| Scale | Window DPI | Client area | Expected | Layout difference to 100% |
| --- | --- | --- | --- | --- |
| 100% | 96 | 320×120 | 320×120 | reference |
| 125% | 120 | 400×150 | 400×150 | 1.8 |
| 150% | 144 | 480×180 | 480×180 | 1.509 |

`p9b-multi-monitor` is `NOT_VERIFIED`: the packaged run has one display and nothing
that drags the window. The helper-level cases P9-D, E and F cover the same native
code, but that is not the same as having seen it in the installed app.

## Evidence

- `docs/evidence/p9/p9-dpi-acceptance.<host>.json`: the three reports of run
  43712043056 (#11), with every check, its actual and its expected value. Their
  `commit` field reads `73a7b3d`: a pull-request run checks out GitHub's merge of the
  branch into `main`. `main` was at `c246e2a`, an ancestor of the branch, so that merge
  has the same tree as `684ff89` (`33f7fe5`).
- `docs/evidence/p9/*.png`: a selection of the screenshots taken on the runner.
- `docs/evidence/p9/blob-manifest.txt`: every evidence file of that run with its git
  blob SHA. The workflow stores them as git blobs because artifacts and job logs are
  not always retrievable. Read one with
  `gh api repos/Ajey877/Apex-Studio/git/blobs/<sha> --jq .content | base64 -d`.
  The blobs are not referenced by any branch, so GitHub may eventually collect them;
  the checked-in files are the durable copy.
- The job annotations of each run carry `P9-RUNS`, `P9-MEASURED`, `P9-SUMMARY`,
  `P9-NOTES` and, for the two-display job, `P9-VIRTUAL-DISPLAY`.

## Running it

In CI: `.github/workflows/p9-dpi-acceptance.yml`, on pull requests to `main` and
pushes to `main` that touch the native editor or these scripts, and on demand
(`workflow_dispatch`).

On a Windows desktop, after `npm run native:vst3:build`:

```
# Attended: tests the display configuration that is set right now and changes nothing.
node scripts/native-editor-dpi-acceptance.mjs

# Unattended: the script changes the display scale itself and restores it afterwards.
set APEX_P9_ALLOW_DISPLAY_CHANGES=1
node scripts/native-editor-dpi-acceptance.mjs
```

Exit code 0 means every case passed, 1 means a case failed, 3 means nothing failed
but some cases were not executed, 2 means it cannot run on this machine. The report
is `build/native-evidence/p9-<label>/p9-dpi-acceptance.json`.

For two physical monitors, connect both, set them to different scales (or use the
unattended mode) and run the same command. P9-D, E and F then execute on the hardware.

On Linux and macOS, `npm run test:vst3-editor` checks the sizing functions and the
structure of the window code. It creates no window and verifies nothing about Windows.

## Not verified

- **Two physical monitors.** The multi-monitor result is from a virtual display.
- **The packaged application across two displays** (`p9b-multi-monitor`).
- **The interactive checklist** (Part 2 of the main document), including step 5.
- **A plug-in whose layout is genuinely resizable.** AGain and ApexAcceptanceGain
  have a fixed layout. The border-resize case proves that the window follows the
  plug-in's constraints at each scale, not that a resizable layout reflows well.
- **Third-party plug-ins.** Plug-ins that scale themselves without
  `IPlugViewContentScaleSupport`, or that ignore it, will behave as they choose; the
  host only guarantees that it tells them the truth in the right order.
- **Scales above 150%**, and Windows 10 and Windows 11 client editions. Everything
  ran on Windows Server 2025.
