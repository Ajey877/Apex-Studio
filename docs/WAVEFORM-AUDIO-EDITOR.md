# Integrated waveform audio editor

Select an imported/recorded **audio clip in the Playlist**, then choose **Open in Audio Editor**. The editor resolves that clip's actual engine/persisted asset, copies its visible source region, and displays channel waveforms, source seconds, frame count, and sample rate. Drag to select, enter exact exclusive frame boundaries, zoom up to 128×, and navigate with the position slider. **Select all** makes each operation apply to the complete region.

## Operations and timeline semantics

- **Crop** keeps the selected frames at the clip's existing timeline start.
- **Delete** joins the two remaining sections, shortening only this clip; deleting every frame is refused. **Silence** replaces selected samples with zero without changing duration.
- **Reverse**, **linear fade in/out**, and **gain** affect only the selection, across the source's existing channels. Frames outside the selection are unchanged. One-frame fades produce silence.
- **Normalize** uses one linked-channel sample peak and a user target from −60 to 0 dBFS. Silent selections are refused. Gain accepts −60 to +24 dB and refuses a request that would clip. This is sample-peak normalization, not loudness or true-peak mastering.
- Mono/stereo, source sample rate, playback rate, routing, and timeline start are preserved. Apply resets the source offset and derives `lengthBars` from committed frames, sample rate, playback rate, BPM and project meter. Existing timeline fades are capped to half the new duration.
- The editor handles the visible **source PCM**, before mixer processing and clip-envelope fades. At non-unit playback rate its ruler/audition are in source time, not stretched timeline time.

## Preview, Apply, history and storage

Preview uses independent Web Audio source/gain nodes at **80% monitor gain** into the raw destination, not the mixer. Stop, further editing, Cancel, and unmount stop those nodes. Preview does not register or persist an asset.

Apply copies the draft into a fresh `waveform-edit-<UUID>` asset and uses the existing lossless float WAV persistence pipeline. **The durability barrier completes before the selected clip reference is published.** App prepares its normal project-history snapshot before runtime/project publication. It updates the exact captured clip ID, not the first audio clip. Original audio and other clips sharing it remain unchanged.

Project Undo/Redo restores original/edited references and exact PCM; the normal autosave/reconciliation path retains audio referenced by both past and future history. Draft undo is separate (8 versions / 128 MiB); no PCM is inserted into project JSON. Reload restores committed audio through existing IndexedDB hydration, and the production live/offline engines consume the committed asset ID. As elsewhere in Apex, undo history is session-local, not restored after application reload.

Abort, project-generation/revision changes, selected-clip changes, tempo/meter changes, missing audio, and persistence errors refuse publication. A fresh unpublished asset is cleaned up on failure; orphan deletion failure is tolerated rather than masking the original error. No existing/shared asset is deleted by this cleanup.

## Boundaries and honest limitations

- Requires non-empty finite mono/stereo PCM, 8–384 kHz, at most **64 MiB per source/draft buffer**. Invalid/noninteger/empty/outside ranges and unsafe allocations are rejected before processing. Operations run synchronously on bounded buffers, not in a background DSP worker.
- Comp/take-group clips must be flattened/bounced first. Nonzero Repitch pitch must be reset or bounced first. Recorded standalone clips use the same path as imported audio; microphone capture itself is not reimplemented.
- No spectral editing, denoising, pitch-preserving processing, ripple editing, per-channel selection, clipboard/paste, or Edison parity beyond the listed first-slice operations is claimed.
- Physical microphone/audio-device playback has not been tested in the sandbox. Automated audition checks exercise the actual Web Audio destination; browser runs are headless/muted.

## Reproducible evidence

`src/audio/waveformEditing.test.ts` contains 24 deterministic tests: actual mono/stereo Float32 operations and unchanged source/outside ranges; boundaries and malformed inputs; linked normalization/clipping protection; selected-ID commit through production persistence hooks; failed storage/cancellation/replacement; trim/rate/meter; draft/project history; actual destination audition; and production offline song render compared with an independently registered reference buffer. Node persistence uses a Blob sink at the real installer seam, **not IndexedDB**.

`browser-tests/waveformEditor.spec.ts` supplies the real IndexedDB/UI proof for mono and stereo. It generates asymmetric float WAV, imports it through the production decoder, promotes/persists the decoded asset like Playlist import, reloads App, selects the non-first shared audio clip, exercises drag/zoom/navigation/audition/Cancel, then reverses a range, normalizes to −6 dBFS, fades, uses draft history, crops, and Applies. An independent expected Float32 calculation checks committed samples. After autosave, project Undo/Redo, reload and production `renderTimelineOffline`, it checks exact PCM/export hashes and the untouched shared clip.

Measured Chromium results (44,100 Hz source, 8,820 committed frames):

| Source | Maximum PCM error | Committed PCM checksum | Production export peak | Export hash | Reload equality |
|---|---:|---:|---:|---:|---|
| Mono | 0 | 3469650828 | 0.19055119156837463 | 2788088434 | exact |
| Stereo | 0 | 327143799 | 0.2694800794124603 | 1926382033 | exact |

Hashes are test diagnostics, not cross-platform cryptographic guarantees. The actual test computes its expectation dynamically and compares each run before/after reload; it does not hard-code browser sample-rate-dependent hashes.

Commands: `npm run lint`, `npm run test:audio`, `npm run test:history`, `npx playwright test`, `npm run test:browser:node`, `npm run build`, `npm run test:desktop-permissions`, `npm run verify:desktop`, `npm run native:vst3:build`, `npm run test:native-vst3`, `npm run test:vst3-daw`. Existing PR workflows also build/test the native helper on Linux/Windows and package/smoke-test Windows. See the PR checks for results at its exact head; local Linux runs are not a Windows runtime claim.

Implementation base: `3680ab99e91a10adda64ac8041648a4ae6fe0f63`. Stable tag `v1.2.2` remains untouched at `88d5889331be89a29b775e6773885b6531c7e802`.
