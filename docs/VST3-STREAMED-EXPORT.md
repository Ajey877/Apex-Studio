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
   If a VST3 instrument produced sound before its first note, the status line
   gives the length of that sound and says it is not in the file (see
   "Scheduling" below).
3. Closing the dialog, cancelling, or any failure deletes the temporary file.
   A failure message always ends with "No file was written."

The transport is stopped for the export and stays stopped. Live VST3
instrument sessions are released first, so that the helper's 16 sessions are
available to the export.

## How it works

- `AudioEngine.renderTimelineOfflineStreamed(request, target, { signal })`
  runs the same offline graph as `renderTimelineOffline`: same step scheduler,
  same Mixer routing, same mastering chain, same 0.1 s preroll, 4 s tail and
  tail trim. The offline context is suspended every 196,608 frames. At each
  suspension the engine
  - schedules the timeline steps of the next window and no further (see
    "Scheduling" below),
  - asks each VST3 instrument for the next blocks (the same block boundaries
    and automation points as the in-memory path) and schedules them,
  - takes the audio captured in front of each VST3 effect, processes it in the
    helper, and appends the result to a scratch file,
  - takes the master output and writes it to the WAV.
- VST3 effects are processed in levels, exactly as in the in-memory path: one
  pass per level of the insert/routing order, then the final pass. Pass count
  = deepest effect level + 1. An effect's processed audio is read back from
  its scratch file window by window in the following passes.
- Helper sessions stay open from their first use to the end of the pass, so
  plug-in state is continuous across windows. They are closed at the end of
  each pass and on every error.
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

## Scheduling

The in-memory export calls the step scheduler for every step of the song
before rendering starts. The streamed export calls the same scheduler for the
same steps, in the same order and with the same times, but a step is scheduled
only when the render is within one window plus 20,480 frames of it (217,088
frames, 4.5 s at 48 kHz). Voices, audio-clip sources, automation ramps and
VST3 note events therefore exist only for that stretch of the song and for
notes that are still sounding. VST3 events are removed once they have been
sent to the plug-in.

The export result carries `scheduling` (the largest value any pass reached):

| Field | Meaning |
| --- | --- |
| `timelineSteps`, `scheduledSteps` | Steps in the song and steps scheduled; equal after a complete export |
| `peakPendingSteps` | Most steps scheduled and not yet rendered |
| `peakLiveAudioSources` | Most voices, clip sources and PCM block sources scheduled and not finished |
| `peakRetainedVst3Events` | Most VST3 events scheduled and not yet sent |
| `leadInDiscardedFrames` | See below |

Three consequences:

- A VST3 instrument is opened when its first note is scheduled, not at the
  start of the pass. It is then run from frame 0 with the same process calls
  as in the in-memory export, so it reaches that note in the same state. Audio
  it produced for the part of the song that has already been rendered cannot
  be placed. For a plug-in that is silent until it receives a note this is
  silence. If it was not silent, the frames are counted in
  `leadInDiscardedFrames`, the dialog reports them, and the streamed file
  lacks that sound where the in-memory export would have it.
- A note that would start behind the frames already rendered stops the export
  with an error. It is never moved or dropped.
- Two places read an audio parameter while scheduling: the note-triggered
  sidechain duck and the drum-pad choke. Scheduled before rendering starts,
  that read returns the value the node was built with. The streamed export
  uses the same built value, so both exports schedule the same ramps. Live
  playback and the in-memory export are unchanged.

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

Renderer memory is no longer proportional to channels × length, and what the
engine schedules ahead is constant (see the counters below). It is still not
constant: the measured renderer peak grows by about 60 MB per minute of song
between 1 and 10 minutes (figures below). The part that is accounted for: the
offline context keeps a mono render target for the whole song (about 11.5 MB
per minute at 48 kHz, per pass). The rest is memory the browser manages. In a
3-minute traced run the JavaScript old space stayed at 14 MB for the whole
render, while the young generation grew from 8 to 64 MB and the Blink heap
from 6 to 77 MB with 11 MB of live objects. There is no fixed duration limit;
a render the machine cannot hold fails when the offline context is created or
with an out-of-memory renderer, and the main process then removes the
temporary files.

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

The table above was measured before scheduling was bounded. The same harness
on the bounded scheduler, with a built-in synth playing sixteen notes per bar
added to the project (9 channels, 120 bpm, 24-bit, mastering on, no forced
garbage collection; idle renderer 192–194 MB):

| | 1 minute | 5 minutes | 10 minutes |
| --- | --- | --- | --- |
| Frames written | 3,072,000 | 14,592,000 | 28,992,000 |
| Passes / windows | 2 / 32 | 2 / 150 | 2 / 296 |
| Wall time | 74 s | 385 s | 771 s |
| Renderer peak RSS | 697 MB | 1,031 MB | 1,252 MB |
| Renderer + browser + 16 helpers + harness, peak | 1,285 MB | 1,648 MB | 1,891 MB |
| Temporary disk peak | 214 MB | 1,021 MB | 2,029 MB |
| Steps in the song = steps scheduled | 480 | 2,400 | 4,800 |
| `peakPendingSteps` | 37 | 37 | 37 |
| `peakLiveAudioSources` | 176 | 176 | 176 |
| `peakRetainedVst3Events` | 11 | 11 | 11 |
| `leadInDiscardedFrames` | 0 | 0 | 0 |
| Helper sessions after | 0 | 0 | 0 |
| Non-finite samples | 0 | 0 | 0 |

The scheduling counters are the same at all three lengths. Renderer RSS is
not: it rises through each render (10 minutes: 434 MB at 31 s, 778 MB at the
end of the first pass, 1,252 MB peak in the second).

The previous scheduler on the same 1-minute project: 108 s and a renderer
peak of 714 MB. The audio is the same: streamed files of an 8-bar version,
mastering off, differ by at most 1.5e-7 between the two schedulers. Its
5-minute run was stopped after 10 minutes of rendering, at 38 % of the first
pass.

## Equivalence with the in-memory export

`native-browser-tests/vst3StreamedExport.spec.ts` renders the same project
through both paths and compares the 32-bit float PCM with a tolerance of 1e-4
peak and 1e-5 RMS and equal frame counts. Most mastering-off cases are
bit-identical. A fixed tolerance is used because two in-memory renders of the
same project are themselves not always bit-identical.

Scheduler coverage (mastering off, 8 bars, 48 kHz): swing 0.35, an
arpeggiator, Mixer and VST3-parameter automation, sends, bus routing, an audio
clip, a note-triggered sidechain, a drum-pad choke group and a VST3 instrument
whose first note is in bar 6. Streamed against in-memory: 2.1e-6 peak, 1.5e-8
RMS, equal frame counts; two in-memory renders of it differ by 2.4e-7. Without
the two built-value fixes above the same comparison fails at 0.11. A second
test renders that project at 8 and at 32 bars and requires identical
scheduling counters (36 pending steps, 259 live sources, 44 retained VST3
events at both lengths).

Mastering on (default Mastering Suite, two VST3 instruments, a built-in synth,
three VST3 inserts on the master, 4 bars plus the 4 s tail): three renders
through each path, compared pair by pair in three regions. Worst peak / RMS
difference:

| | First 0.5 s | Body | Tail |
| --- | --- | --- | --- |
| In-memory against in-memory (3 pairs) | 5.8e-6 / 1.5e-6 | 8.6e-6 / 1.8e-6 | 5.1e-6 / 4.9e-7 |
| Streamed against streamed (3 pairs) | 5.1e-6 / 1.4e-6 | 1.0e-5 / 1.8e-6 | 5.9e-6 / 5.0e-7 |
| Streamed against in-memory (9 pairs) | 5.8e-6 / 1.5e-6 | 1.0e-5 / 1.8e-6 | 5.9e-6 / 5.0e-7 |

Frame counts are equal, the best alignment of every streamed render against
the in-memory render is 0 frames, and two of the nine streamed/in-memory pairs
were bit-identical. The difference between the two paths is the same size as
the difference between two runs of either path.

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
It also requires every step to have been scheduled and no discarded lead-in,
and records the scheduling counters in its report.
