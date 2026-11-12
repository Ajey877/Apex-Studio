# Native VST3 editor — Windows acceptance

This is the **only** way to claim the native editor window works. Everything that
runs on Linux — JavaScript unit tests, IPC, helper framing, process separation,
`test:vst3-editor` — is contract-level. None of it creates an HWND.

Status of this change: **all twelve automated criteria PASS on real Windows; the
packaged-application checklist is still outstanding.**

`Native VST3 Validation / Native DSP (windows-latest)` ran the acceptance harness
against a real Windows helper, a real HWND, and the real pinned-SDK AGain VSTGUI
editor: **14 PASS, 0 FAIL, 2 NOT_VERIFIED** at commit `b399996`. The two
`NOT_VERIFIED` rows are the packaged-application claim and the AGain audio-policy
row — neither was observed, and neither is reported as passing. The interactive
packaged-application half has **not** been executed because no interactive Windows
x64 desktop was available. Both halves are recorded separately and never traded
for one another.

Observed on Windows for the record: helper `apex-vst3-host.exe` in its own
process, window style `0xcf0000`, outer `366×159`, client `350×120`, title
`Apex Studio VST3 Editor - AGain VST3`, `visible: true`, DPI 96 with a content
scale factor of 1 accepted by the plug-in.

- Automated evidence: `build/native-evidence/native-editor-acceptance.json`,
  produced by `node scripts/native-editor-windows-acceptance.mjs`. A checked-in
  snapshot of the Windows run is at
  `docs/evidence/native-editor-acceptance.windows-latest.json`, because CI
  artifacts and job logs are not always retrievable.
- Interactive evidence: still outstanding. See
  [Part 2](#part-2--interactive-packaged-application-checklist-not-executed).

## How to read a result

| Result | Meaning |
| --- | --- |
| `PASS` | The criterion was observed, on real Windows, by the recorded check. |
| `FAIL` | The criterion was observed and the behaviour was wrong. |
| `NOT_VERIFIED` | No observation was made. **This is not a pass.** It states what is missing. |

The script writes one record per criterion with the observed values, the Windows
build details, and whether the check was automated. A criterion is never written
as `PASS` unless the check actually ran and observed it. On a non-Windows host the
script records all criteria as `NOT_VERIFIED` and exits `2`, so a Linux CI log can
never be mistaken for Windows evidence.

---

## Part 1 — Automated acceptance on a real Windows desktop

Run with:

```bash
npm run native:vst3:build
node scripts/native-editor-windows-acceptance.mjs
```

Exit codes: `0` every criterion passed · `1` at least one `FAIL` · `2` not a
Windows x64 host or helper not built · `3` completed, but some criteria are
`NOT_VERIFIED` (an unattended runner cannot satisfy all of them).

The harness is deliberately not a mock: it launches the real helper `exe`, the
helper creates a real `HWND` through `CreateWindowExW`, and the real AGain
`IPlugView` attaches to it. Every assertion below reads Win32 state
(`IsWindowVisible`, `GetFocus`, `GetWindowRect`, `GetDpiForWindow`,
`GetWindowTextW`, `WindowFromPoint`, `EnumChildWindows`) or the plug-in's own
reported size.

| # | Criterion | How it is decided |
| --- | --- | --- |
| 1 | Native HWND creation and visibility | `windowCreated`, `IsWindowVisible`, `attached`, a separate helper `processId`, and outer size > client size (a real framed window). |
| 2 | Genuine VST3 editor view | `createView(kEditor)` returned a view that accepted `kPlatformTypeHWND`; the size and title come from the plug-in. |
| 3 | DPI scaling | `GetDpiForWindow` vs the scale factor actually pushed through `IPlugViewContentScaleSupport::setContentScaleFactor`, which must accept it. |
| 4 | Resize and `checkSizeConstraint` | A real `SetWindowPos` goes through `WM_SIZING` → `checkSizeConstraint` → `WM_SIZE` → `onSize`; the plug-in's `getSize` must then equal the real client area. |
| 4b | Plug-in-initiated resize | `IPlugFrame::resizeView` driven by the plug-in, recorded honestly as `NOT_VERIFIED` when the plug-in declines to resize itself. |
| 5 | Keyboard forwarding | `WM_KEYDOWN`/`WM_KEYUP` reach `onKeyDown`/`onKeyUp`; the view must stay attached. |
| 6 | Mouse and wheel forwarding | VST3 has **no** mouse entry point on `IPlugView`: see [Mouse semantics](#mouse-semantics) below. Verified by real hit-testing (`WindowFromPoint` lands on a plug-in child window) plus `WM_MOUSEWHEEL` → `onWheel`. |
| 7 | Focus gain and loss | `SetForegroundWindow`/`SetFocus` on the real window, then `GetFocus`/`GetActiveWindow`; `onFocus` follows `WM_SETFOCUS`/`WM_KILLFOCUS`. |
| 8 | State capture before destruction | The window is confirmed visible, *then* closed; component state bytes, parameter count, dirty flag and overflow flag are captured from the response. |
| 9 | Native close behaviour | A real `WM_CLOSE` (what the title-bar X sends) must capture state and be reported by the next `editorPoll`, without the app asking. |
| 10 | Repeated open/close | 10 cycles, each in a fresh helper (a helper hosts exactly one session), each confirming visible-then-closed. |
| 11 | Editor failure and recovery | The helper PID is killed mid-session; poll and close must both report an explicit error rather than fabricate success or hang. |
| 12 | Audio unaffected by editor failure | Real PCM through a separate audio helper before and after an editor helper is killed; the output must be bit-identical. |

Extra records the harness always writes:

- `12b` — real audio processed by `mda Delay` **while the editor window is open**.
- `12c` — `NOT_VERIFIED` by design: AGain declares an event input bus, and Apex
  deliberately refuses to run audio for such effects. That is a product policy,
  not a defect, and the audio path is proven with `mda Delay` instead.
- `packaged-app` — `NOT_VERIFIED` unless supplied from an interactive session. The
  harness cannot drive the Electron UI, so it never claims to have done so.

### Mouse semantics

VST3's `IPlugView` exposes `onWheel`, `onKeyDown`, `onKeyUp`, `onSize`,
`onFocus`, `canResize` and `checkSizeConstraint` — and **no mouse methods**. A
plug-in that wants clicks creates its own child `HWND` inside the host window and
Windows routes `WM_MOUSEMOVE`/`WM_LBUTTONDOWN`/… straight to it. So the host has
no mouse-forwarding responsibility; its duties are to create a real parent window,
not intercept those messages, and keep the child reachable. Criterion 6 verifies
exactly that, and does not pretend a forwarding API exists.

## Failure matrix (automated rows)

Every row must end with **either** the edits applied once **or** a recovery record
offered at next launch. "Edits quietly gone" is always a failure.

| Scenario | How it is decided | Where |
| --- | --- | --- |
| Capture failure | The window stays open, the error is reported through `nativeCloseError`, no partial state is published | `test:vst3-editor`, and the no-modal-dialog regression test |
| Helper crash while open | Poll/close report an explicit error; no fabricated success, no hang | criterion 11 |
| Audio during editor failure | Bit-identical PCM before and after a killed editor helper | criterion 12 |
| Repeated open/close | 10 visible-then-closed cycles | criterion 10 |
| State capture ordering | Window visible before capture, gone after | criterion 8 |
| Native close | Real `WM_CLOSE` path captures state | criterion 9 |

A blocking `MessageBoxW` used to be raised on the helper's UI thread when capture
failed. A modal dialog cannot be dismissed without a human click, so it froze the
helper, blocked every later `editorPoll`, and made the editor unrecoverable in any
unattended or automated session. It was removed: the failure is now carried by the
framed protocol and rendered by Apex, the window stays open for a retry, and
`tests/vst3Editor.test.mjs` fails if a modal message box ever comes back.

The remaining interactive rows (renderer teardown, quit, corrupt recovery,
removal/relink, IPC loss, overflow) stay in Part 2 because they need a real
application session.

---

## Part 2 — Interactive packaged-application checklist (not executed)

Status: **not executed.** No interactive Windows x64 desktop was available for
this change. Nothing below has been observed on screen.

### Prerequisites

- Windows 11 x64 desktop (physical or VM with an interactive session — a Session 0
  service or a CI runner without a desktop cannot show an HWND).
- `npm run native:vst3:build` completed; `build/native-vst3/VST3/Release/again.vst3`
  exists and `node scripts/verify-native-editor-fixture.mjs` exits 0.
- A packaged build (`npm run build` + the desktop packager step), not `npm run dev`.
- A project with one audio track whose Mixer shows an `AGain` insert.

Record for each step: pass/fail, screenshot or screen recording, and
`build/native-evidence/` logs.

### A. Genuine window on screen

1. Click **Open VST3 editor** on the AGain insert. Expect the plug-in's own
   window — AGain's GUI drawn from `again.uidesc`, its **Gain** slider at ParamID 0
   — and **no** Apex-drawn parameter panel.
2. Confirm it is a real native window: it appears in the taskbar/Alt-Tab, has
   Windows chrome, and can be moved off the app. `Get-Process apex-vst3-host |
   Select Id,MainWindowTitle` must show the window on the **editor** helper's PID,
   distinct from the audio helper's PID.
3. Move the Gain slider and confirm the app's Mixer/parameter readout follows
   live (this is `editorPoll` forwarding `performEdit`).
4. Keyboard and mouse: tab into the plug-in, arrow keys on the slider, right-click
   the control, mouse wheel over it.
5. Resize by dragging the corner, then change display scaling 125% → 150% and move
   the window between monitors with different DPI. The plug-in must re-layout
   without blank areas and the app must not crash or lose the session.

### B. One undoable change

6. With the editor open, make several Gain moves (one gesture each), then close
   with the plug-in's own **X**. Expect exactly **one** new undo entry: *Edit VST3
   effect in native editor*. Undo returns to the pre-editor value; redo re-applies
   the captured value.
7. Undo → redo → undo again, reopening the editor between steps. The editor must
   show the current committed value, not a stale one.
8. Confirm the project is marked dirty exactly once and saved with the commit.

### C. Persistence

9. Save, fully quit Apex, relaunch and reopen the project: the insert shows the
   edited Gain, the generic parameter list agrees, and reopening the editor shows
   the same value.
10. Play back the track and export it. Compare exported RMS/peak against a project
    saved before the edit; they must differ by the amount the Gain change implies.

### D. Lifecycle and hygiene

11. Close the editor 10×, then quit Apex with the editor **open**. Afterwards
    `Get-Process apex-vst3-host` must list nothing and no `electron.exe` window may
    survive. Task Manager must show no orphaned helper.
12. On a platform where the editor is not supported (Linux/macOS, or Windows
    arm64), **Open VST3 editor** must be unavailable with a plain reason — no
    silent no-op and no Apex-drawn substitute.

### E. Interactive failure and recovery

| Scenario | How to force it | Expected |
| --- | --- | --- |
| Capture failure | Make `IComponent::getState` fail (dev hook, or unload the bundle while open) | Window stays open, error shown in Apex, no partial state committed |
| Helper crash while open | Kill the editor helper PID while the window is shown | Window disappears; every edit made before the crash is in `vst3-editor-recovery.json` |
| Open cancellation | Click **Cancel** in the "opening editor" state | No helper left running, no window, no state change |
| Renderer teardown | Reload the renderer (Ctrl+R in dev) with the editor open | Recovery record written; helper released |
| Quit with editor open | File → Quit while the window is up | Recovery record written, helper released, no orphan |
| Corrupt recovery file | Truncate/garbage `vst3-editor-recovery.json` | App launches, reports the record is unusable, offers discard; no crash |
| Dismiss recovery | Choose **Discard** | Record deleted, project untouched, no re-prompt |
| Removal while open | Delete the insert (or the track) with the editor open | Editor closes, removal applies, no commit into a stale insert |
| Relink while open | Replace the plug-in on the insert with the editor open | Old session refused; captured state not applied to the new plug-in |
| Repeated open/close | 50 open/close cycles | Constant helper count, no PID growth, no window leak |
| Failed IPC | Kill the helper mid-poll | Poll loop stops after 3 consecutive failures, UI usable |
| Parameter-event overflow | Script rapid Gain moves past the bounded queue | `eventQueueOverflow` reported; **final** value per parameter still committed |

## Reporting

Attach `build/native-evidence/native-editor-acceptance.json` to the PR. Until
every criterion in Part 1 is `PASS` **and** Part 2 has been executed on an
interactive desktop, the feature stays **experimental, Windows x64 only**, and no
claim of a working on-screen plug-in window outside Part 1 may be made.
