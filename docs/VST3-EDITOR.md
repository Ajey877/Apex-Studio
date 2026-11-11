# Native VST3 editor windows (Mixer effects, Windows x64)

This document explains the delivered editor contract for genuine VST3 Mixer
effects: what the window is, what is guaranteed about its state, and what still
requires a real Windows session. It deliberately separates the tested JavaScript
contract from the untested-in-CI native window itself.

## What "native editor" means here

A native Mixer insert (an `FxSlot` with `type: 'vst3'`) has two ways to edit the
same saved plug-in state:

1. **Open VST3 editor** — the plug-in's own editor view.
   `IEditController::createView(ViewType::kEditor)` is called in the isolated
   helper, and the returned `IPlugView` is attached to a real HWND created by
   `native/vst3/editor-host.hpp`. The plug-in paints and handles its own controls;
   Apex draws none of it.
2. **The generic parameter list** (existing) — validated controller metadata and
   normalized values, one acknowledged Apply per undo step.

Both write the same `Vst3State`, so either path can follow the other.

The window is owned by a dedicated helper process (`apex-vst3-host.exe
editorOpen`), never by Electron's main process, the renderer, or the audio
thread. A plug-in editor is a second, fully separate helper instance from the
live playback instance; opening the editor therefore cannot disturb a running
native insert graph, and the app refuses to open it during playback anyway.

## Lifecycle and state guarantees

| Step | Command | Guarantee |
| --- | --- | --- |
| Open | `vst3:openEditor` → `editorOpen` | Saved component/controller streams and normalized overrides are restored first. Opening fails (no window shown) if the class is not a Mixer effect, the plug-in has no edit controller, or `createView("editor")` returns nothing / refuses `kPlatformTypeHWND`. |
| While open | `vst3:pollEditor` → `editorPoll` | `beginEdit`/`performEdit`/`endEdit` for known, non-read-only ParamIDs are validated, coalesced per gesture, and reported. The final value per parameter is always retained even if the bounded queue overflows; `eventQueueOverflow` says intermediate moves were dropped. Ctrl/Alt/Shift/win, wheel, resize, DPI changes and focus are forwarded to the view. |
| Close (plug-in's X or the app's button) | `editorClose` | The plug-in window is destroyed only after `IComponent::getState`, `IEditController::getState` and the final callback values are captured and validated. If capture fails the window stays open and the user is told why — a partial state is never published. |
| Commit | renderer `NativeVst3EditorSession` | Exactly one `mutateProjectState(…, 'Edit VST3 effect in native editor')` and one synchronous save, only for the original project/track/slot/plug-in. A stale insert, replaced project, or failed save refuses the commit. |
| Finish | `vst3:finishEditor` | Releases the helper. `committed: false` first writes `vst3-editor-recovery.json`; `committed: true` leaves no recovery file behind. |

Rules that the tests pin down:

- **One window per app session**, bound to the renderer that opened it. Any other
  renderer, frame, or origin is denied by the existing IPC guard.
- **No silent loss.** Renderer crash/navigation/teardown, project replacement and
  app quit all capture the state and persist a recovery record rather than
  dropping the edits.
- **No silent application.** A recovery record is offered on the next launch as
  *Restore captured state* / *Discard*, and is only usable against the matching
  project ID, track, slot and plug-in identity.
- **Bounded work.** Polls are serialized, close is idempotent, and a failing
  helper stops the poll loop after three consecutive failures instead of spinning.

## Editor fixture

The CMake build option `APEX_BUILD_VST3_EDITOR_FIXTURE` (ON for Windows) adds the
pinned SDK's genuine VSTGUI **AGain** effect beside the MDA bundles. AGain is the
SDK's own editor sample: `again.uidesc` defines the plug-in window and binds its
Gain slider to ParamID 0, which makes it a real editor fixture rather than a
synthetic window. VSTGUI's BSD notice is kept in `native/vst3/licenses/`.

```sh
npm run native:vst3:build     # builds the helper, MDA bundles and AGain
npm run test:vst3-editor      # renderer + service editor contract (no binary needed)
```

## Validation status

Covered by `npm run test:vst3-editor` on every CI runner (no plugin binary, no
Electron):

- renderer session: commit-once, close-once sharing, refused/failed/state-less
  capture → recovery (never a fabricated state), poll-loop termination, foreign
  class ID rejection, unavailable editor, recovery/discard paths;
- service: open/poll/close/finish, callback chronology and read-only rejection,
  active-edit snapshot agreement, overflow coalescing with final-value
  authority, malformed state rejection, owner isolation, renderer-teardown
  recovery, and recovery-record contents;
- wiring: preload methods, IPC handlers, recovery persistence, quit handling,
  Mixer/App UI, and the packaged module allowlist.

Process separation is measured, not asserted, by
`npm run test:vst3-editor-process`: it starts a real editor session beside a
running audio session, records both helper PIDs from the OS, blocks the editor
helper and shows audio keeps producing bit-identical PCM, then checks no helper
survives teardown. The report is
`build/native-evidence/native-editor-process-separation.json` (the platform and
`editorNativeOnThisHost` fields say whether a real window was exercised — on
Linux it is `false`).

Not covered here, and therefore **not claimed**:

- actual Windows window creation, painting, DPI scaling, keyboard/mouse input
  and plug-in resizing (requires a real Windows x64 desktop session);
- packaged acceptance of an editor window through the installed app;
- third-party plug-in compatibility in general.

The Windows jobs in `.github/workflows/desktop-validation.yml` and
`.github/workflows/native-vst3-validation.yml` build the helper and fixture, run
`test:vst3-editor` and `test:vst3-editor-process`, and (on Windows) run
`node scripts/verify-native-editor-fixture.mjs`, which requires the genuine AGain
bundle with `again.uidesc` and discovers it as an effect through Apex's own host.
A passing source-level run is still not evidence that a windowed acceptance run
passed. Use `docs/VST3-EDITOR-ACCEPTANCE.md` for that, and do not describe the
editor as production-ready before it is filled in.
