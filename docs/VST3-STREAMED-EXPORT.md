# Streamed VST3 song export (Phase 10G)

A song that uses native VST3 audio is exported to WAV without holding the
whole render in memory. The desktop application renders it in windows, sends
each window to the main process, and the main process writes the WAV to disk.
This removes the 128 MiB working-memory refusal for that export; the in-memory
path is unchanged and still serves every other export.

## When the streamed path is used

All four must hold (`usesStreamedWavExport` in `src/components/ExportModal.tsx`):

| Condition | Value |
| --- | --- |
| Format | WAV 16-bit, 24-bit or 32-bit float |
| Scope | Song (Playlist timeline) |
| Host | Desktop application (`desktopApp.exportStore` present) |
| Project | At least one audible VST3 instrument, or one enabled VST3 Mixer effect with Mixer FX included |

Everything else keeps the in-memory path and its existing limits: pattern
scope, the stems ZIP, MIDI, bounce and freeze, the browser build, and projects
without VST3 audio. A stems export of a long VST3 song is therefore still
refused above 128 MiB of native PCM.

## What the user sees

1. **Start export** renders to a temporary file. Progress names the pass
   (`Pass 1/2 — …`); the settings are locked and **Cancel** stops the render.
2. When the render ends, the dialog shows "Rendered to disk" with the length
   and size, and **Save**. Save opens the system save dialog (Music folder,
   WAV filter, overwrite confirmation). Cancelling that dialog keeps the
   rendered file available; Save can be pressed again.
   The in-app audition preview is not offered for this export, because the
   audio is on disk and not in the application; the dialog says so.
3. Closing the dialog, cancelling, or any failure deletes the temporary file.
   A failure message always ends with "No file was written."

The transport is stopped for the export and stays stopped. Live VST3
instrument sessions are released first, so that the helper's 16 sessions are
available to the export.

## How it works

- `AudioEngine.renderTimelineOfflineStreamed(request, target, { signal })`
  runs the same offline graph as `renderTimelineOffline`: same scheduler, same
  Mixer routing, same mastering chain, same 0.1 s preroll, 4 s tail and tail
  trim. The offline context is suspended every 196,608 frames. At each
  suspension the engine
  - asks each VST3 instrument for the next blocks (the same block boundaries
    and automation points as the in-memory path) and schedules them,
  - takes the audio captured in front of each VST3 effect, processes it in the
    helper, and appends the result to a scratch file,
  - takes the master output and writes it to the WAV.
- VST3 effects are processed in levels, exactly as in the in-memory path: one
  pass per level of the insert/routing order, then the final pass. Pass count
  = deepest effect level + 1. An effect's processed audio is read back from
  its scratch file window by window in the following passes.
- Helper sessions stay open for a whole pass, so plug-in state is continuous
  across windows. They are closed at the end of each pass and on every error.
- The main-process store (`desktop-export.cjs`) owns the files:
  `<temp>/apex-studio-export/pid-<pid>/job-<uuid>/master.wav.partial`, renamed
  to `master.wav` after the header is written and validated, plus
  `scratch-N.f32` per effect. Save copies to `<destination>.<hex>.apex-partial`,
  validates the copy, then renames it over the destination, so a failed save
  never leaves a truncated WAV under the chosen name.
- The renderer reaches the store only through `desktopApp.exportStore`
  (`export:*` IPC). The main process accepts those calls only from the main
  frame of the application window on the application origin. The renderer
  never supplies a path: the destination comes from the save dialog.

## Limits

| Limit | Value | Behaviour at the limit |
| --- | --- | --- |
| Enabled VST3 effect slots in one export | 8 | Refused before rendering |
| Helper sessions | 16 in total, an open plug-in editor counts | Refused with a message naming the editor window |
| VST3 instruments | 8 (live runtime limit) | Unchanged |
| Pre-master output with a VST3 master insert | not supported | Refused, as before |
| One export per window | 1 | A second `begin` is refused |
| Message size to the store | 4 MiB, whole frames | Renderer sends at most 1 MiB |
| Scratch files per export | 16 | Refused |
| Temporary disk | WAV + 8 bytes per frame per VST3 effect | Checked against free space before rendering; a full disk stops the export |

Temporary disk is the main cost. Each VST3 effect needs a 32-bit float stereo
copy of the whole song: about 23 MB per minute per effect at 48 kHz, 184 MB
per minute for eight effects, plus the WAV itself.

Renderer memory is no longer proportional to channels × length, but it is not
constant: the offline context keeps a mono render target for the whole song
(about 11.5 MB per minute at 48 kHz) and the measured peak grows with length
(figures below). There is no fixed duration limit; a render the machine cannot
hold fails when the offline context is created or with an out-of-memory
renderer, and the main process then removes the temporary files.

## Measured (Linux, 2 CPUs, 3.9 GB RAM, Chromium 153, 48 kHz)

Project: 8 VST3 instruments (mda JX10, DX10, Piano, EPiano) on 8 Mixer tracks,
each with one VST3 insert (8 effects), mastering on. The in-memory path refuses
this project at both lengths with the 128 MiB message.

| | 5 minutes, 24-bit | 10 minutes, 32-bit float |
| --- | --- | --- |
| Frames written | 14,592,000 | 28,992,000 |
| WAV size | 87.6 MB | 231.9 MB |
| Passes / windows | 2 / 150 | 2 / 296 |
| Wall time | 365 s | 700 s |
| Renderer peak RSS (idle 190 MB) | 949 MB | 1,266 MB |
| Renderer + browser + 16 helpers + harness, peak | 1,564 MB | 1,847 MB |
| Temporary disk peak | 1,021 MB | 2,087 MB |
| Helper sessions at peak / after | 16 / 0 | 16 / 0 |
| Non-finite samples | 0 | 0 |

These were measured in headless Chromium against the real helper service and
the real export store, with the store reached over a local binary transport
instead of Electron IPC. They are not Electron or Windows measurements.

Same project without the effects, 9 minutes: renderer RSS 451 MB at the start
of the render, 662 MB at the end; JavaScript heap 18–47 MB throughout.

## Equivalence with the in-memory export

`native-browser-tests/vst3StreamedExport.spec.ts` renders the same project
through both paths and compares the 32-bit float PCM, mastering off, with a
tolerance of 1e-4 peak and 1e-5 RMS and equal frame counts. Most cases are
bit-identical. A fixed tolerance is used because two in-memory renders of the
same project are themselves not always bit-identical (up to 2.7e-5 with
mastering on).

## Failure behaviour

Cancel, a missing plug-in, a helper crash or timeout, malformed or non-finite
PCM from a plug-in, a full disk, a write error and the session limit all stop
the export. In each case the tests check: no output file, no temporary file,
no store job, no helper session, the engine is not left in its offline state,
and the next export of the same project succeeds.

Temporary files are also removed when the renderer crashes, reloads or is
closed, and when the application quits. A folder left by a process that was
killed is removed at the first export of the next launch.

## Tests

```sh
npm run test:export-store          # store, IPC surface, renderer-side pieces
npm run native:vst3:build          # helper + MDA fixtures
node scripts/run-native-vst3-browser.mjs   # includes vst3StreamedExport.spec.ts
npm run smoke:win                  # Windows: packaged export, save, cancel
```

`test:export-store` is part of `test:vst3-daw`, which CI runs on Linux and
Windows. The packaged smoke exports a one-bar song with one VST3 instrument
and two VST3 inserts at 24-bit, saves it without a dialog to a folder given by
the launching script (`APEX_SMOKE_EXPORT_DIR`, honoured only with
`APEX_SMOKE_TEST=1`), compares the saved samples with the in-memory render,
cancels a second export, and checks that no temporary data survives.
