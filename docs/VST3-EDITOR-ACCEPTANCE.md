# Native VST3 editor — manual Windows acceptance checklist

This is the **only** way to claim the native editor window works. Everything in
`docs/VST3-EDITOR.md` that can run in CI is contract-level (JavaScript, IPC,
helper framing, process separation); none of it creates an HWND.

Status: **not executed.** No Windows x64 desktop runner was available for this
change. Nothing below has been observed on screen, so no claim of a working
plug-in window is made.

## Prerequisites

- Windows 11 x64 desktop (physical or VM with an interactive session — a
  Session 0 service or CI runner without a desktop cannot show an HWND).
- `npm run native:vst3:build` completed; `build/native-vst3/VST3/Release/again.vst3`
  exists and `node scripts/verify-native-editor-fixture.mjs` exits 0.
- A packaged build (`npm run build` + the desktop packager step), not `npm run dev`.
- A project with one audio track whose Mixer shows an `AGain` insert.

Record for each step: pass/fail, screenshot or screen recording, and
`build/native-evidence/` logs.

## A. Genuine window (1–5)

1. Click **Open VST3 editor** on the AGain insert. Expect the plug-in's own
   window — AGain's GUI drawn from `again.uidesc`, its **Gain** slider at ParamID 0 —
   and **no** Apex-drawn parameter panel.
2. Confirm the window is a real native window: it appears in the taskbar/Alt-Tab,
   has Windows chrome (title bar, min/max/close), and can be moved off the app.
   `Get-Process apex-vst3-host | Select Id,MainWindowTitle` must show a window on
   the **editor** helper's PID, distinct from the audio helper's PID.
3. Move the Gain slider and confirm the app's Mixer/parameter readout follows
   live (this is `editorPoll` forwarding `performEdit`).
4. Keyboard and mouse: tab focus into the plug-in, arrow keys on the slider,
   right-click context menu if AGain offers one, mouse wheel over the control.
5. Resize the window (drag the corner) and change display scaling (125% → 150%),
   then move the window between monitors with different DPI. The plug-in must
   re-layout without blank areas, and the app must not crash or lose the session.

## B. One undoable change (6–8)

6. With the editor open, make several Gain moves (one gesture each), then close
   with the plug-in's own **X**. Expect exactly **one** new undo entry:
   *Edit VST3 effect in native editor*. Undo once returns to the pre-editor
   value; redo re-applies the captured value.
7. Undo → redo → undo again, reopening the editor between steps. The editor must
   always show the current committed value, not a stale one.
8. Confirm the project is marked dirty exactly once and the save happens with the
   commit (no "unsaved changes" left behind after a successful close).

## C. Persistence (9–10)

9. Save the project, fully quit Apex, relaunch and reopen the project: the insert
   shows the edited Gain, the generic parameter list agrees, and reopening the
   editor shows the same value.
10. Play back the track and export it. Both must use the restored state — compare
    exported RMS/peak against a project saved before the edit; they must differ by
    the amount the Gain change implies.

## D. Lifecycle and hygiene (11–12)

11. Close the editor repeatedly (10×), then quit Apex with the editor **open**.
    After quit, `Get-Process apex-vst3-host` must list nothing, and no
    `electron.exe --type=...` window may survive. Task Manager must show no
    orphaned helper.
12. On a platform where the editor is not supported (Linux/macOS, or Windows
    arm64), the **Open VST3 editor** action must be unavailable and the reason
    must say so plainly — no silent no-op, no Apex-drawn substitute window.

## E. Failure and recovery matrix

Every row must end with **either** the edits applied once **or** a recovery
record offered at next launch. "Edits quietly gone" is a failure in every row.

| Scenario | How to force it | Expected |
| --- | --- | --- |
| Capture failure | Make `IComponent::getState` fail (dev build hook, or unload the bundle while open) | Window stays open, error shown, no partial state committed |
| Helper crash while open | Kill the editor helper PID while the window is shown | Window disappears; every edit made before the crash is in `vst3-editor-recovery.json` |
| Open cancellation | Click **Cancel** in the "opening editor" state | No helper left running, no window, no state change |
| Renderer teardown | Reload the renderer (Ctrl+R in dev) with the editor open | Recovery record written; helper released |
| Quit with editor open | File → Quit while the window is up | Recovery record written, helper released, no orphan |
| Corrupt recovery file | Truncate/garbage `vst3-editor-recovery.json` | App launches, reports the record is unusable, offers discard; no crash |
| Dismiss recovery | Choose **Discard** | Record deleted, project untouched, no re-prompt |
| Removal while open | Delete the insert (or the track) with the editor open | Editor closes, removal applies, no commit into a stale insert |
| Relink while open | Replace the plug-in on the insert with the editor open | Old session refused; captured state not applied to the new plug-in |
| Repeated open/close | 50 open/close cycles | Constant helper count, no PID growth, no window leak |
| Failed IPC | Stop the helper mid-poll (kill PID) | Poll loop stops after 3 consecutive failures, UI returns to a usable state |
| Parameter-event overflow | Script rapid Gain moves past the bounded queue | `eventQueueOverflow` reported; **final** value per parameter still committed |

## Reporting

Fill in `build/native-evidence/native-editor-acceptance.json` with one entry per
row above (`id`, `result`, `evidence`, `notes`) and attach it to the PR. Until
that file exists with all rows passing, the feature is **experimental, Windows
x64 only, and unverified on screen**.
