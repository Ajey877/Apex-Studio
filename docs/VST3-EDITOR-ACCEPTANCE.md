# Native VST3 editor — Windows acceptance

This is the **only** way to claim the native editor window works. Everything that
runs on Linux — JavaScript unit tests, IPC, helper framing, process separation,
`test:vst3-editor` — is contract-level. None of it creates an HWND.

Status of this change: **all twelve automated criteria PASS on real Windows, and
the AGain audio policy is now measured rather than assumed; the two items that
remain `NOT_VERIFIED` are the packaged-application claim and interactive DPI
changes.** The packaged app is now driven end to end by
`scripts/packaged-editor-acceptance.mjs` (see below), and its editor criteria are
reported separately from the helper-level ones — never traded for one another.

`Native VST3 Validation / Native DSP (windows-latest)` ran the acceptance harness
against a real Windows helper, a real HWND, and the real pinned-SDK AGain VSTGUI
editor: **14 PASS, 0 FAIL, 2 NOT_VERIFIED** at commits `6dcdf1a`, `b399996` and
`53e7852`. The two `NOT_VERIFIED` rows were the packaged-application claim and the
AGain audio-policy row.

The AGain policy row has since been converted from an assumption into a
measurement, and that run reported **15 PASS, 0 FAIL, 1 NOT_VERIFIED** at
`78cad31` — the single remaining `NOT_VERIFIED` being the packaged-application
claim, which the separate packaged harness covers and this one does not.

Two corrections were made after the first green run, both found by measurement:

- `6-mouse-wheel` had been reading the response to the *click* request when
  asserting about the *wheel*, so it reported `wheelReachedPlugInView: false` on a
  healthy window. It now reads the wheel response.
- `12c-again-audio-policy` was a hardcoded `NOT_VERIFIED`. It now opens AGain
  through a real helper and requires the host's exact refusal message plus the
  absence of a session; a silent success would be a `FAIL`.

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

### Attempted is not received

Three rules decide every input-related criterion here, because violating them is
how a green test can prove nothing:

1. **An attempt is not a receipt.** The counter raised at the injection site
   (`sendInputAccepted`, `injectedWheelCount`) records only that we asked Windows
   to deliver something. Only counters raised *by the receiver* — the editor
   WndProc, or the plug-in's own `IPlugView` callback — are evidence.
2. **The event must be ours.** The observed delta and keycode are compared against
   what the harness actually sent, so a stray or earlier event cannot be credited.
3. **Attached is not delivered.** A window that exists and has focus says nothing
   about whether a keystroke or wheel event reached the plug-in.

Consequently no criterion may be gated on a comparison that is true of every
possible value (the previous wheel check used `hostWheelCount >= 0`, which could
never fail).

### Why the editor could not change the parameter (control tags)

A VSTGUI control reaches a parameter through a **control tag**: `UIDescription::getTagForName`
looks the name up in the uidesc's `<control-tags>` table, then asks the controller. A
name in neither place resolves to `-1`, and a control whose tag is `-1` is bound to
nothing — it still draws, still takes clicks, and still never emits
`beginEdit`/`performEdit`/`endEdit`, so the host cannot observe an edit at all.

The fixture's layout named `control-tag="Gain"` but declared no `<control-tags>`
table, so the slider was decorative. This is why packaged `p3` reported a session
that stayed `open` with no edit and no error: nothing was broken in the host, the
plug-in, or the input injection; the layout had no binding. A unit test now asserts
that every `control-tag` used by the layout is declared in the table and that the
`Gain` entry resolves to the same ParamID the controller exposes.

The binding was necessary but not sufficient, and the second half is worth recording
because it looks like success. The packaged driver pressed and released at the slider's
**centre** — and the fixture's default gain is `0.5`, which puts the handle exactly
there. VSTGUI's slider computes its value from the pointer position, so a press at the
handle re-sets the value it already holds; `isDirty()` stays false and `valueChanged()`
is never called, so no `performEdit` is emitted and no edit can be observed. A
perfectly aimed click on a correctly bound control produces nothing.

The driver therefore performs a **drag**: land on the handle, press, move to a new
position, release — with the helper's per-step receipt recorded. That is also what a
user does to change a gain.

### Why the drag still did nothing (the button state is not in the message)

Two attempts failed here, and both failed for the same underlying reason:

> `Win32Frame::getCurrentMouseButtons()` reads the held buttons from
> `GetAsyncKeyState(VK_LBUTTON)`, **not** from `wParam`.

1. Delivering press/move/release with `SendInput` while `deliverMouse` paired every
   press with an immediate `MOUSEEVENTF_LEFTUP`. That makes a click. `WM_LBUTTONDOWN`
   told the slider to begin an edit, but the `WM_MOUSEMOVE` that followed was processed
   with the button already up, so `CSliderBase::onMouseMoved` saw no button and
   returned `kMouseEventNotHandled` without touching the value.
2. Posting `WM_LBUTTONDOWN` / `WM_MOUSEMOVE` carrying `MK_LBUTTON`. The messages
   admitted the press, but `GetAsyncKeyState` still said the button was up, so the
   control behaved identically. Claiming a button in `wParam` is not holding it.

The transport is now a real `SendInput` sequence in which `down` genuinely leaves the
button held and **only `up` releases it**:

| step | injected | effect |
| --- | --- | --- |
| `move` | `MOUSEEVENTF_MOVE` | cursor reaches the handle |
| `down` | `MOUSEEVENTF_LEFTDOWN` | edit begins, button really held |
| `move` | `MOUSEEVENTF_MOVE` | the drag — processed with the button down |
| `up` | `MOUSEEVENTF_MOVE` + `MOUSEEVENTF_LEFTUP` | value commits, button released |

The helper reports `buttonHeldAfter` from `GetAsyncKeyState` after each step, so the
evidence says the button was actually held rather than asserting it. The zoom modifier
is a real held shift key (`keybd_event`), for the same reason: VSTGUI reads `kShift`
from the live key state, which makes the drag a stepped change rather than a jump to
the pointer — which is how a user changes a gain.

Two things followed from that change and are worth keeping:

* **A leftover block undid it silently.** One version added the new transport but left
  the old `SendInput` tail below it. That tail re-sent `MOUSEEVENTF_LEFTUP` after every
  gesture — the original defect, restored — and did not compile at all, because its
  `INPUT` record was scoped to the wheel branch. A structural test now asserts that the
  release is issued exactly once, in the `up` branch, and that the press branch never
  releases; it was verified by reintroducing the defect.

* **A local "no work to do" is not a build.** The header was missing from ninja's
  depfile, so a GCC rebuild reported success without recompiling it and only MSVC
  caught the error. Native verification now deletes the object directory first.

### Where the genuine drag stops — what is proven, and what is not

Four delivered revisions of real input (click, drag, posted messages, held-button
SendInput) all reached the plug-in window with the button genuinely held and none
produced a `performEdit`. This section records exactly what has been established and,
just as importantly, what has not.

**Proven from the SDK source and the scenario's own diagnostics**

1. Windows routes the drag to the plug-in's VSTGUI child window:
   `hitIsChildWindow: true`, `hitWindowClass: VSTGUI…`, same process.
2. The button really is held across the drag: `buttonHeldAfter: true` after the
   `MOUSEEVENTF_LEFTDOWN`, read back through `GetAsyncKeyState`, and the preceding
   move is a separate accepted `MOUSEEVENTF_MOVE`. `SendInput` returns 1 for each.
3. The input is not rejected downstream: the session stays `open`, `sessionError` is
   null, and no `unknown or read-only ParamID` rejection appears.
4. `mouse-enabled` is a real uidesc attribute — `kAttrMouseEnabled` in
   `uiviewcreatorattributes.h`, applied by `ViewCreator::apply` at
   `viewcreator.cpp:127`, and containers inherit it because
   `ViewContainerCreator::getBaseViewName()` returns `kCView`.

**A real defect that was fixed, but which was not the last blocker**

`CViewContainer::onMouseDownEvent()` skips any child whose `getMouseEnabled()` is
false, before hit-testing it:

```cpp
if (pV && pV->isVisible() && pV->getMouseEnabled() && pV->hitTest (event.mousePosition, event))
```

The fixture's `panel` container — which carries the Gain slider — was declared
`mouse-enabled="false"`, which does put every control inside it out of the mouse's
reach. That is a genuine bug in the fixture and it is fixed, with a test that walks the
layout and fails if any container above an interactive control disables the mouse.

**It was not the only cause.** With the panel corrected, `p3` still reports no edited
parameter. So the fixture bug was real but not sufficient to explain the failure, and
this document does not claim otherwise.

**Not yet established: where it stops after the frame receives the press**

The remaining range is lead-engineer cases **C/D**: either `CSlider` receives the press
and does not change its value, or it changes and never calls `performEdit`. Reading the
dispatch path rules out the alternatives but cannot decide between those two:

| case | status |
| --- | --- |
| A. Windows routed it wrongly | **ruled out** — the drag lands on the plug-in child window with the button held |
| B. The frame hit-tests the wrong view | **contributed** (the panel flag, now fixed); no container above the control disables the mouse after the fix |
| E. performEdit happened, host rejected it | **ruled out** — no rejection, session stays open, `editedParameterIds` empty rather than refused |
| F. Host accepted, Apex did not consume | **ruled out for the same reason** — the helper's edit snapshot is empty, so there is nothing for Apex to miss |
| C. The control got it and did not change | **open** |
| D. It changed and never called performEdit | **open** |

Deciding between C and D needs an observation *inside* the plug-in's editor, where the
`CSlider` runs. A runtime probe in `editor-host.hpp` cannot do it: that header is
compiled with no VSTGUI include path by design, and naming `VSTGUI::CFrame` there broke
the build with `C2653`. The observation has to live in the fixture's own editor
translation unit (`acceptance-fixture-editor.cpp`), which is the only place that
compiles with VSTGUI — and also the only place that cannot be built on this Linux
development host, because VSTGUI needs a GUI toolchain.

That is the honest state: the failure is narrowed to two specific stages inside the
plug-in's control, and the instrument that would separate them belongs in fixture code
that only the Windows runner can compile. Adding it unverified is how the previous two
revisions broke the build, so it is proposed rather than guessed at.

### Why the probe was withdrawn, and what distinguishes these cases instead

A read-only `describeViewAt(point)` probe was written to ask the live `CFrame` which
view it places under a point. It was **withdrawn from this change**, and the reason
matters:

`editor-host.hpp` is compiled without any VSTGUI include path, on purpose — the
helper's DSP/parameter half must build on a host with no GUI toolchain, and the fixture
keeps VSTGUI isolated in one translation unit for the same reason. Naming
`VSTGUI::CFrame` in that header pulled a GUI dependency into the native host and failed
both Windows builds (`C2653: 'VSTGUI' is not a class or namespace name`). A diagnostic
is not worth eroding that separation, and the separation is itself load-bearing.

So how is this class of failure distinguished without the probe? By reading the
authoritative dispatch source, which settles it without touching the plug-in:

| case | what the evidence shows |
| --- | --- |
| A. Windows routed it wrongly | `hitIsChildWindow` false, or the receiver is another process |
| B. The frame hit-tests the wrong view | a container in the chain is not `getMouseEnabled()`, or an interactive child is `mouse-enabled="false"` — checkable statically from the uidesc, and now asserted by a test |
| C. The control got it but did not change | `mouse-enabled="true"` all the way down, so the value is the next thing to read |
| D. It changed but never called performEdit | `isDirty()`/`valueChanged()` path in `cslider.cpp`/`ccontrol.cpp` |
| E. performEdit happened, host rejected it | the helper's edit events are empty but the callback counters move |
| F. Host accepted, Apex did not consume | the helper reports edits but `editedParameterIds` in Apex stays empty |

The decisive static fact here was B: `CViewContainer::onMouseDownEvent()` skips a child
whose `getMouseEnabled()` is false before hit-testing it, and the panel was false. The
uidesc test now prevents that specific silent case, which is cheaper and more durable
than a runtime probe that cannot be compiled where it is needed.

### Why redo looked broken (history stores sanitized state)

`projectHistory` stores `sanitizeProjectSnapshot(state)` — a normalize plus document
round-trip — not the raw React state object. After a redo the live state is therefore
the *sanitized* representation, so comparing it against the raw pre-undo object
reports a difference that undo/redo neither caused nor controls. Packaged `p5` was
doing exactly that, and additionally compared `JSON.stringify` output, which is
sensitive to key insertion order.

The first correction was to compare sanitized against sanitized. That was necessary
but not sufficient, because the same key-order blindness lived in *history itself*:
`areSemanticallyEqual` decided whether to record an entry with `JSON.stringify(snapshot)`.
A captured plug-in state legitimately arrives rebuilt from a parameter list, so closing
an editor that changed **nothing** recorded a history entry whose only difference was
property order. Undo then restored a document that compared equal to what was already
on screen, so `p5` reported `undoRestored: false` — the undo step was real, it just
undid nothing.

Both places now use one shared `canonicalProjectJson` (sorted object keys,
`undefined` dropped, array order preserved), and a unit test fails if either side
stops using it. Verified locally against the real `createHistory`: a document in
another key order adds **no** entry, a genuine parameter change still adds exactly
one, and undo/redo transitions 1 → 1 → 0 restore the document exactly.

### Why the crash changed nothing (a dead helper dropped its session)

Packaged `p8` killed the real helper (`killedPid` set, session `failed`), yet no
recovery record was offered. The service deleted the editor session on the first
failed poll after the helper died, so `getEditorRecovery` — the shipped surface that
builds the record — answered *"closed or belongs to another renderer"*, which
describes a foreign owner, not a crash. Every parameter the plug-in had already
reported was still in `draftParameters`, but nothing could reach it.

A dead helper now **retires** the session instead of deleting it: it keeps the values
the plug-in last reported, marks itself crashed, and is released when the renderer
calls `finishEditor`. The record states that the helper exited rather than pretending
the final state was captured, and it is never counted against the live-editor limit.

### Two defects the stricter criteria found

Rewriting criteria 5 and 6 to demand real receipts immediately turned both red.
Neither failure was a test problem:

1. **`WM_CHAR` double-reported one keystroke.** `WM_CHAR` carries the translated
   character for the *same* stroke as `WM_KEYDOWN`. The host was counting it as a
   second `onKeyDown` invocation and overwriting the recorded keycode with the
   character code, so one TAB press appeared as two `onKeyDown` calls with keycode
   9 instead of `KEY_TAB`. `WM_CHAR` is now tracked separately
   (`keyCharMessageCount`, `lastCharKey`) and never counted or reported as a key.

2. **The criterion compared against a misremembered keycode.** It asserted
   `KEY_TAB == 3`. Reading `pluginterfaces/base/keycodes.h` shows `KEY_BACK = 1`
   and `KEY_TAB = 2`, so the host's `VK_TAB -> KEY_TAB` mapping was correct and the
   test was accusing it wrongly. Both defects were hiding behind the old
   "is the window still attached" gate, which stayed green either way. The
   expected value is now derived from the SDK header by a unit test rather than
   remembered.

`WM_DPICHANGED` and the wheel paths likewise only became meaningful once the
counters were separated into attempt-versus-receipt.

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
| 3 | DPI scaling | Three things, reported separately and never conflated: (a) `IPlugViewContentScaleSupport` — a non-default factor pushed through `setContentScaleFactor` must be accepted *and* the plug-in must resize itself; (b) `WM_DPICHANGED` — counted only when Windows actually sends it (`dpiChangedMessageCount`), which no unattended runner triggers; (c) interactive 125%/150% display changes — always `NOT_VERIFIED` in CI. 96 DPI is never evidence of any of them. |
| 4 | Resize and `checkSizeConstraint` | A real `SetWindowPos` goes through `WM_SIZING` → `checkSizeConstraint` → `WM_SIZE` → `onSize`; the plug-in's `getSize` must then equal the real client area. |
| 4b | Plug-in-initiated resize | `IPlugFrame::resizeView` driven by the plug-in, recorded honestly as `NOT_VERIFIED` when the plug-in declines to resize itself. |
| 5 | Keyboard forwarding | Real `SendInput` for a TAB down and up. The `SendInput` return count must be `1` for each, the editor WndProc must observe `WM_KEYDOWN`/`WM_KEYUP` (`keyDownMessageCount`/`keyUpMessageCount`), and the plug-in's `onKeyDown`/`onKeyUp` must each be invoked **exactly once** with `KEY_TAB` and a recorded return value. A merely attached window is not evidence. |
| 6 | Mouse and wheel forwarding | VST3 has **no** mouse entry point on `IPlugView`: see [Mouse semantics](#mouse-semantics) below. The wheel is proven through whichever path Windows actually used, and the evidence names it: **path A** the host WndProc observed `WM_MOUSEWHEEL` and invoked `onWheel` with the injected delta, or **path B** a plug-in child window owned the point, so the OS delivered the wheel there and the host correctly saw nothing. The observed delta must equal the injected delta. An attempted injection is never counted as a receipt. |
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
not intercept those messages, and keep the child reachable.

Criterion 6 therefore accepts **either** routing outcome, but only one of them,
and it records which:

- **Path A** — no plug-in child owns the point, so the host window receives
  `WM_MOUSEWHEEL` (`wheelMessageCount`) and forwards it, invoking
  `IPlugView::onWheel` (`viewWheelCount`) with the delta we injected.
- **Path B** — a plug-in child window owns the point (`WindowFromPoint` lands on a
  child of the editor window), so Windows delivers the wheel to the plug-in
  directly and the host correctly observes nothing.

For the click, exactly one of "the plug-in child owned the point" and "the host
received the click" must hold; both being false means nothing observed it, and
both being true would mean the same event was counted twice.

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

## Part 1b — Automated packaged-application acceptance (Windows CI)

`npm run package:win:dir` then `node scripts/packaged-editor-acceptance.mjs` drives
the **real installed Electron app** on `windows-latest`. It is the automated half of
Part 2: it clicks the app's own controls, reads the OS process table and window
handles, and writes `build/native-evidence/packaged-editor-acceptance.json`. It is
run by `.github/workflows/desktop-validation.yml` (`windows-package`).

| id | Criterion |
| --- | --- |
| `p1-mixer-opens-editor` | A Mixer insert opens the plug-in's own editor window |
| `p2-native-window-responsive` | The native window appears and the app stays responsive |
| `p3-parameter-reaches-apex` | A parameter change reaches Apex |
| `p4-one-undoable-change` | Closing the editor commits exactly one undoable change |
| `p5-undo-redo` | Undo and redo work |
| `p6-save-quit-reload` | Save, quit and reload preserve state |
| `p7-no-leaked-helpers` | Quitting with the editor open leaks no helper process |
| `p8-recovery` | An editor crash leaves a recovery record |
| `p9-dpi-125-150` | 125% and 150% DPI behaviour (manual only) |
| `harness` | The driver itself completed |

Result at `78cad31` (`windows-package`, real installed app): **2 PASS, 0 FAIL,
7 NOT_VERIFIED** — `p6` and `p7` pass; `p1`–`p5` and `p8` are blocked by the fixture
limitation documented below; `p9` needs an interactive desktop. A criterion is only
`FAIL` when the host was shown to be wrong: a plug-in that correctly rejects an
edit naming parameters its controller never exposes is a fixture limit
(`blockedByFixture`), not a host defect.

Three rules keep this honest, and each of them exists because a real run was wrong
without it:

1. **No evidence is never a pass.** `helperProcesses()` used to return `[]` on any
   error, and `p7` passed on `survivors.length === 0` — so an unreadable process
   table looked like "no helper leaked". Enumeration now reports whether it
   actually succeeded (`tasklist`, with a PowerShell CIM fallback), and `p1`, `p2`
   and `p7` answer `NOT_VERIFIED` when the read failed.
2. **Name the real cause.** The editor session published the *last* poll failure.
   After a helper dies the service forgets the session, so later polls say only
   "closed or belongs to another renderer" and overwrote the actual reason. The
   first failure is kept.
3. **Drive the real UI, and only the real UI.** `p1` clicks the visible controls in
   the order a user does. There is no fallback: if an insert row does not render,
   `p1` records `NOT_VERIFIED` (or `FAIL`) rather than calling the handler the
   button would have called. Clicking a test-only entry point and reporting it as
   user-interface acceptance would prove nothing about the UI.

### The order the packaged run drives the real UI

Each step is a real DOM control in the packaged renderer, and each is recorded
before the next begins:

| Step | Control | Recorded as |
| --- | --- | --- |
| 1 | Mixer track strip for `Kick / 808` | `selectedTrack` |
| 2 | `Add Effect Plugin` (`+`) button | `openedAddEffectMenu` |
| 3 | `Native VST3 Effect` in the effect menu | `openedVst3Picker` |
| 4 | The discovered plug-in's row in the real picker | `choseFixtureFromPicker` |
| 5 | The rendered insert row's `Open VST3 editor` button | `insertRowRendered`, `insertRowText` |
| 6 | A real click on that button | `clickedControl` |

The run additionally cross-checks the result against project state: the number of
`type: 'vst3'` inserts must be non-zero, so a purely visual success cannot pass.
Gain edits then come from genuine `SendInput` aimed at the slider inside the
plug-in's own window, and the panel's normal poll loop observes the change — the
injection never synthesises a parameter event. That input hook is refused unless
`APEX_ACCEPTANCE=1`, so it is unreachable in a user session.

### Which plug-in the packaged run uses, and why

The packaged editor run needs one fixture that is simultaneously a **stereo audio
effect the Mixer accepts**, a **genuine VSTGUI editor**, and a plug-in whose
controller exposes the parameters its own editor edits. That intersection is empty
inside the pinned SDK:

| Sample | Stereo audio in/out | VSTGUI editor | Usable here |
| --- | --- | --- | --- |
| `again` (AGain) | yes | yes | **No** — declares an event input bus; the host refuses it by design |
| `dataexchange` | yes | yes | **No** — its editor drives UI-only parameters the controller never exposes, so its callbacks name unknown ParamIDs and the host correctly rejects them |
| `panner` | mono in | yes | No — the host requires stereo in and out |
| `utf16name` | yes | returns `nullptr` | No — there is no editor view |
| `adelay`, `syncdelay`, `remap_paramid`, `again_sampleaccurate` | yes | none on Windows | No — no editor |
| `hostchecker`, `note_expression_*`, `pitchnames` | n/a | none | No |
| MDA bundle (28 effects) | yes | none | No — no editor at all in this tree |

Rather than weaken a host policy to fit one of the above, Apex ships its own
test-only acceptance plug-in.

#### `ApexAcceptanceGain` — the acceptance fixture

Source: `native/vst3/acceptance-fixture-*.cpp` / `.hpp`, plus
`native/vst3/resources/acceptancegain.uidesc`. It is **original Apex code written
for this repository**, not copied from a Steinberg sample, so it carries no
sample-code licensing question; it is likewise **not** part of any release build.

| Property | Value | Why it matters |
| --- | --- | --- |
| Bus layout | Stereo in → stereo out, **no** audio side-chains | Matches the host's stereo-only policy |
| Event buses | **None declared** | The host refuses audio effects with event input buses; the fixture does not need one |
| Parameter | `Gain`, **ParamID 0**, automatable, `dB`, default `0.5` | One controller-exposed parameter, matching the slider in the editor |
| Gain law | `0.5` → 0 dB (unity), `0.0` → −24 dB, `1.0` → +12 dB | A known, testable curve with a real audible effect |
| Editor | Genuine VSTGUI `VST3Editor` from `acceptancegain.uidesc`, 320×120 | A real plug-in window, not a placeholder |
| Editor controls | `CSlider` **and** `CTextEdit`, both tagged `Gain` (ParamID 0) | Dragging the slider must produce `beginEdit`/`performEdit`/`endEdit` naming a real, writable ParamID |
| Identity | UID `41504558-41434741-494E0001-00000001` (processor) / `…00000002` (controller) | Stable across component, controller and editor |
| Build | `APEX_BUILD_ACCEPTANCE_FIXTURE` (default ON); bundle additionally gated on `APEX_BUILD_VST3_EDITOR_FIXTURE` | Buildable without X11 on Linux; the `.vst3` bundle only where VSTGUI exists |

The fixture proves itself. `native/vst3/acceptance-fixture-test.cpp` builds as
`apex-acceptance-vst3-test` and runs on **every** platform, asserting observed
behaviour rather than declared intent — 43 checks, all passing locally:

- the gain law is exact: `0.5` normalizes to unity, `1.0` measures ×`3.981071703`
  (the RMS ratio, not a nominal value), `0.0` measures ×`0.063095735`;
- a real `process()` call applies a parameter change **within the block that
  delivered it**, and the value persists into the next block when no new change
  arrives;
- there is **no** event input bus and **no** event output bus, and the audio
  buffers really are stereo;
- `getState`/`setState` round-trip a saved gain, and a **truncated** state is
  rejected rather than silently accepted;
- the controller exposes exactly one parameter and it is automatable;
- the component **declares its controller class id**, which
  `PluginHost::PlugProvider::initialize()` requires before it will create a
  controller at all.

The layout file is validated as XML too. VSTGUI parses `acceptancegain.uidesc`
at `createView` time, and a malformed file yields no view, so the plug-in reports a
zero size and the host correctly refuses with "invalid or unsupported initial size"
— a message that blames the host for a fault in the layout. That is exactly what
happened: an XML comment contained `--`, which is illegal inside a comment, and
nothing in the repository parsed the file.

That load-path check exists because its absence was a real defect: constructing the
processor and controller directly proves they work but says nothing about whether
a host can *load* them. `PlugProvider` asks the component for
`getControllerClassId` and fails when it gets `kResultFalse`, which is exactly what
happened — the packaged run died with `Plugin component/controller initialization
failed` while all the direct-construction checks were green. The fixture now calls
`setControllerClass(kControllerUID)` in its constructor, and the three load-path
assertions fail if that line is removed.

So when the packaged run fails to find a usable editor window, that is evidence
about the host or the package — not an unproven fixture.

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
