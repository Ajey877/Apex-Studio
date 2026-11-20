# Track Freeze / Unfreeze (Phase 10H)

Freeze renders a Channel Rack channel's part of the Song timeline to audio and plays that audio
instead of the channel's instrument. Unfreeze goes back to the instrument. Nothing of the source
is changed by either: notes, steps, clips, instrument settings and VST3 state stay in the project
exactly as they were, and the frozen audio is one extra, separately stored asset.

The controls are on each Channel Rack row: **FRZ** (freeze), **FROZEN** (state), **STALE** /
**NO AUDIO** (click to freeze again) and **UNF** (unfreeze).

Bounce-In-Place is a different feature and was not changed. The playlist lane's snowflake button
still bounces the lane to a new audio clip; it does not freeze anything.

## 1. What was inspected first

| Area | Finding that shaped the design |
| --- | --- |
| `Channel` (rack) | Owns the instrument: type, synth/sampler/drum settings, VST3 identity and state, notes, steps, volume, pan, `mixerTrackId`. This is the only object that has "an instrument to switch off". |
| `PlaylistTrack` (lane) | A row of clips. A lane owns no instrument; several channels can have clips on one lane and one channel can have clips on many lanes. |
| `MixerTrack` (insert) | Receives any number of channels plus audio clips, routing and sends from other tracks. Its input is a mix, not one instrument. |
| Engine graph | Each channel has its own panner into its mixer track's `input` → latency-compensation delay → insert FX → panner → sidechain ducking gain → output → routing / sends → master → mastering. |
| Sequencer | `triggerCurrentStep` is shared by live playback and every offline render. Every sequenced voice goes through `playSingleVoice`. |
| Sidechain | Note-triggered: a note on a channel calls `triggerSidechainDucking(mixerTrackId, time)`. The ducking gain sits after the insert chain of the ducked track. |
| Automation | `channel_vol`, `channel_pan`, `channel_filter_cutoff`, `channel_filter_res`, `channel_pitch`, `vst3_param` act on the channel/instrument; the `mixer_*` and `fx_param` targets act on the mixer. |
| VST3 instruments | Live: one helper instance per audible VST3 channel, opened before the take (`prepareVst3Channel`), closed by `NativeVst3Runtime.reconcile`. A live session must be ready before the transport hands it a note. Offline: `NativeVst3OfflineRender` opens an instance per channel that received a note. |
| Audio assets | PCM lives in the `apex-studio-audio` IndexedDB store, keyed by buffer id. `getAudioIdsForProject` is the single list of referenced ids used by hydration, undo/redo protection, backups, orphan clean-up and the ZIP bundle. |
| Bounce-In-Place | Renders one lane with mixer FX, pre-master, into a *new clip*. Destructive in intent (it adds material); not a state of a channel. |

## 2. Decision: the freeze unit is the rack channel

`Channel.freeze?: ChannelFreeze` (`src/types/daw.ts`). One record per frozen channel:

```
version: 1            audioBufferId        sourceFingerprint    frozenAt
sampleRate            frameCount           leadInFrames         contentSeconds
tailSeconds           tailDecayed          audioUnavailable?
```

The PCM is a normal audio asset (`freeze-<channelId>-…`, 32-bit float); the project document
holds only the record (about 300 bytes).

### Baked into the frozen audio

- The channel's instrument voices for every unmuted pattern clip that plays the channel on an
  unmuted lane of the Song timeline — per-channel clips and full-pattern clips (`patternScope: 'all'`).
- Instrument settings and VST3 state, channel volume and pan, channel pitch, step velocities.
- Automation that targets the channel: `channel_vol`, `channel_pan`, `channel_filter_cutoff`,
  `channel_filter_res`, `channel_pitch`, `vst3_param`.
- Tempo, swing and time signature.
- An 8-second tail after the channel's last clip, with trailing silence trimmed.

### Left live

- Channel **mute / solo** and the channel's **mixer routing** (`mixerTrackId`).
- The whole mixer: insert effects (built-in and VST3), track volume / pan / mute / solo, routing,
  aux sends and returns, sidechain ducking, mixer automation, master track and mastering.
- Audio clips, other channels, and notes played by hand (keyboard, MIDI input, previews) — those
  still reach the instrument.
- **Pattern mode** always plays the instrument. A freeze is a render of the Song timeline.

### How the frozen audio enters the graph

One `AudioBufferSourceNode` → one gate gain → the **`input` of the channel's mixer track**: the
same node the channel's own panner feeds. Everything from there on is the live mixer, so the
frozen audio is latency-compensated, processed, ducked, routed and sent exactly like the
instrument's output was. The source is started from the Song branch of `triggerCurrentStep`, at
the timeline position of the step being scheduled, so play, resume, seek, a mid-take freeze and
an offline render all start it the same way.

### How doubling is prevented

One map, `activeChannelFreezes`, decides both halves of the swap:

- a channel in the map gets a frozen-audio source, and
- `playSingleVoice` drops that channel's *sequenced* voices (it still sends the note-triggered
  sidechain pulse, so tracks ducked by the channel keep pumping).

A channel is in the map only when its freeze is valid, its audio is loaded and the take is in
Song mode. So for every channel exactly one of the two plays. When a channel enters the map
mid-take its sounding voices are stopped; when it leaves, its source is stopped.

### Validity: the source fingerprint

`computeChannelFreezeFingerprint` hashes everything that is baked (list above). Editing any of it
makes the freeze **Stale**: the frozen audio is not used and the instrument plays, so what you
hear is always the current project. Undoing the edit makes the same freeze valid again.
Everything that stays live is outside the fingerprint, so mixing a frozen channel never
invalidates it. The fingerprint is deliberately a superset: the failure mode is a freeze reported
stale that would still have matched, never frozen audio that no longer matches its source.

| Status | Rack | What plays in Song mode |
| --- | --- | --- |
| none | `FRZ` | instrument |
| frozen | `FROZEN` + `UNF` | frozen audio |
| stale | `STALE` + `UNF` | instrument (click `STALE` to freeze again) |
| missing-audio | `NO AUDIO` + `UNF` | instrument (the asset could not be loaded; the record is kept) |

### Exports never change

Web Audio renders in 128-frame quanta, and a synth voice is not invariant under a shift of its
start inside a quantum. Measured with the built-in subtractive synth in Chromium: the same note
rendered 58 frames later differs by up to 0.5 full scale around its envelope corners; rendered a
whole number of quanta later it is bit-identical. A mastered export starts the timeline behind a
0.1 s lead-in (4,410 frames at 44.1 kHz — not a whole number of quanta), a pre-master render
does not.

So the freeze is rendered behind the same lead-in as a mastered export (`leadInFrames`), and an
offline render uses the frozen audio **only when it is sample-exact**: same sample rate and a
lead-in that differs by a whole number of quanta (`isChannelFreezeSampleExact`). Every other
offline render — another export sample rate, mastering switched off, a pre-master render, a lane
bounce — renders the instrument. The result: freezing a channel does not change an exported
file, in any export mode.

| Render | Frozen audio used? | Result vs. the unfrozen project |
| --- | --- | --- |
| Live Song playback | yes | same part; not comparable sample-for-sample (see limits) |
| WAV export, mastering on, device sample rate | yes | null (measured, §5) |
| Stem export, mastering on, device sample rate | yes | null (measured) |
| Streamed production export (desktop), same conditions | yes | null (measured) |
| Any export at another sample rate, or with mastering off | no — instrument | identical by construction |
| Bounce-In-Place (lane or channel) | no — instrument | unchanged feature |
| Pattern-scope export | no — instrument | unchanged |

### VST3 instruments

- A frozen VST3 channel is not prepared for a Song take and its instance is released when the
  channel becomes frozen mid-take. A mastered export of it opens no helper instance and sends no
  audio to the plug-in.
- When a frozen VST3 channel goes back to its instrument mid-take (edit → stale, or Unfreeze),
  the plug-in is loaded again immediately and the channel's sequenced notes are held until it is
  ready, because a live VST3 session must be ready before the transport gives it a note.
- An export that renders the instrument (table above) needs the plug-in, exactly as it does for
  an unfrozen project.

### Shared channels, routing, sends, sidechain

- A channel used by several clips, lanes and full-pattern clips is frozen as one render of all of
  them. Freezing one channel does not affect any other channel, including channels that share its
  mixer track or its clips.
- Re-routing a frozen channel to another mixer track is live and keeps the freeze valid.
- Sends, returns and buses are downstream of the injection point, so they are live.
- A frozen channel still triggers the ducking of tracks side-chained to it; a frozen channel on a
  ducked track is still ducked.

## 3. Rejected alternatives

| Alternative | Why not |
| --- | --- |
| Freeze a **mixer insert track** (input mix + inserts baked) | The input of a track is every channel and audio clip routed to it plus routing and sends from other tracks. Baking it would freeze other people's material, break per-channel mute/solo, and make "what is frozen" depend on routing. Baking inserts would also freeze sidechain-ducked and automated effects. A draft of this record was written and removed. |
| Freeze a **playlist lane** | A lane owns no instrument; the same channel plays on other lanes too, so its instrument could not be released. This is what Bounce-In-Place already does, as a one-off render. |
| Replace the channel's clips with an **audio clip** (reuse Bounce-In-Place) | Destructive to the arrangement and to undo history, cannot be reversed by removing one record, and would put the audio after the channel's position in the graph for automation targets. |
| Inject the frozen audio **after the inserts** (post-FX freeze) | Sidechain, sends, routing and mixer automation would stop being live; a later mix change would silently not apply. |
| Bake **channel mute / solo** | The user would have to unfreeze to mute a part. |
| Always use the frozen audio in exports | Not sample-identical outside the freeze's render-quantum phase or sample rate; an export would differ from the unfrozen project by up to envelope-corner transients. |
| Never use the frozen audio in exports | Loses the main export benefit: the default mastered export of a frozen VST3 channel needs no plug-in instance. |

## 4. Persistence, undo, backup

- **Freeze** = render → store the asset → wait until it is durable → one project mutation
  (`Freeze channel`). A failed render, a failed save, or an edit to the source during the render
  leaves the project exactly as it was and discards the audio (`channelFreezeWorkflow.ts`).
- **Unfreeze** = one mutation (`Unfreeze channel`) that removes the record. The asset stays until
  no undo step, backup or project references it; then the normal orphan clean-up removes it.
- Undo / redo of either restores the record; the asset is protected by `getHistoryAudioIds`.
- Save / reload: the record is validated on load (`normalizeChannelFreeze`); a malformed record is
  dropped and the channel plays its instrument. If the asset cannot be restored the record is
  kept and flagged `audioUnavailable` (status **NO AUDIO**), mirroring missing clip audio.
- Backups and the Portable ZIP include the asset through `getAudioIdsForProject`. A ZIP export of
  a project whose frozen audio is missing stops with the existing "audio asset is missing" error;
  freeze the channel again or unfreeze it first.
- Deleting a channel removes its record with it.

## 5. Evidence

Real Chromium, real Web Audio, production engine (`browser-tests/trackFreeze.spec.ts`), 44.1 kHz,
fixture with an insert EQ, aux send to a delay return, bus routing, note-triggered sidechain,
channel-volume automation and mixer-volume automation:

| Measurement | Value |
| --- | --- |
| Mastered export, frozen vs. live (peak difference) | 5.8e-5 |
| Same render of the unfrozen project twice (the engine's own repeatability) | same order (≈6e-5) |
| Frozen asset replaced by silence (proves the frozen audio is what was rendered) | 0.50 |
| Lead muted (proves the lead matters in the mix) | 0.62 |
| WAV export / streamed export / stems, frozen vs. live | 2.5e-5 / 4.0e-5 / 2.6e-5 |
| Mixer edits after the freeze (fader+pan, insert, send, re-route), frozen vs. live | ≤ 3.9e-5, status stays `frozen` |
| Channel mute, solo of another channel, solo of itself, frozen vs. live | ≤ 2.6e-5 |
| Lane bounce of a frozen project vs. unfrozen | 1.0e-6 (instrument rendered both times) |

Real VST3 (mda JX10 in the production native helper, `native-browser-tests/vst3TrackFreeze.spec.ts`):
mastered export frozen vs. plug-in: **0** (bit-identical); helper instances opened during the
frozen export: **0**; audio blocks sent to the plug-in: **0**; live frozen take: **0** instances.

## 6. Limits

- **Live playback is not a null test.** Live notes fall on an arbitrary render-quantum phase on
  every play, so two live plays of the *instrument* already differ sample-for-sample; the frozen
  audio is one fixed rendition. Timing, level and content are the same part.
- **Free-running or random instruments** (a VST3 with unsynchronised LFOs or noise) are frozen as
  one rendition. That is inherent to freezing.
- **Length.** One freeze renders at most 10 minutes (content plus tail). A VST3 channel is limited
  further by the native in-memory render bound: about 3 min 9 s at 44.1 kHz, 2 min 53 s at 48 kHz.
  Longer timelines are refused with a message; nothing is changed.
- **Tail.** 8 seconds are rendered after the last clip. If the instrument is still sounding then,
  the freeze is created with a visible warning (amber state and tooltip), not silently.
- **At the song end** the frozen audio stops with the take, like the instrument's voices.
- **One freeze at a time.** A second freeze cannot start while one is rendering.
- **External-MIDI-only channels** have no internal audio and cannot be frozen.
- **Mixer and Playlist views** show no freeze state; the control and state are in the Channel Rack.
- **Opening the frozen project where the device runs at another sample rate:** live playback
  resamples the frozen audio (as for any audio asset); exports there render the instrument.

## 7. Files

| File | Role |
| --- | --- |
| `src/types/daw.ts` | `ChannelFreeze`, `Channel.freeze` |
| `src/state/trackFreeze.ts` | fingerprint, status, selection, sample-exact rule, record validation, tail analysis |
| `src/audio/channelFreezeWorkflow.ts` | render → durable → one mutation; Unfreeze |
| `src/audio/audioEngine.ts` | selection map, voice gate, frozen source, hand-over, `renderChannelFreeze`, offline rule |
| `src/components/channelFreezeUi.ts`, `ChannelRack.tsx`, `src/App.tsx` | controls, state, messages |
| `src/state/projectPersistence.ts`, `projectState.ts`, `projectStateAudioConsumers.ts` | asset references, hydration flag, load validation, field registry |
| Tests | `src/state/trackFreeze.test.ts`, `src/audio/channelFreezeWorkflow.test.ts`, `src/components/channelFreezeUi.test.ts`, `browser-tests/trackFreeze.spec.ts`, `native-browser-tests/vst3TrackFreeze.spec.ts` |
