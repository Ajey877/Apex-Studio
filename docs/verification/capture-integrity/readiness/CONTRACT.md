# Opt-in readiness contract v2

The processor emits every invocation from its first callback through the end
marker, under a UUID-bearing run ID. No main-thread capture flag, sorting,
deduplication or overwrite acceptance is permitted. Each record carries input and
output layout, actual quantum length, sample rate, processor state, frame before
and after PCM copy, sequential invocation index and PCM checksum. Transferred
buffers are unique and not mutated by the receiver; hashes are rechecked after
end-marker draining and context cleanup.

Readiness requires **32 consecutive contiguous quanta**, computed using each
previous observed output length. At the observed 128/44100 layout this is about
93 ms, longer than the 10 ms output buffering interval and multiple scheduling
ticks; it is a conservative warmup criterion, NOT proof of future continuity.
A discontinuity resets the streak; no earlier record is erased. The main thread
must receive the ready acknowledgement while the context is running before
scheduling a source. Readiness proof is independently recomputed from raw records.

The source is then scheduled with 250 ms lead plus 100 ms checked pre-source
silence; the checked window includes 150 ms after source end. The worklet must
acknowledge arming before the selected start, then emit all records through the
end frame, followed by an explicit end marker containing the invocation count.
Post-ready continuity is checked even during scheduling lead, not only inside
the selected window. All time alignment derives from exact scheduled frames.

Outcomes are independent: startupContinuous, readiness, measurementIntegrity,
and fidelity. Startup discontinuities remain visible even when passed=true for
a valid post-ready measurement. Any post-ready frame gap, overlap, reordered or
missing sequence, stale ID, layout error, mutation, checksum failure, incomplete
end marker or late arm fails that measurement. Contradictory same-timestamp PCM
is reported for the entire stream, not just selected samples.

No unverified near-zero tolerance is accepted: fidelity currently requires exact
Float32 PCM including silent boundaries. Any nonzero sample discrepancy is kept
in the firstPcmError record and fails fidelity pending explanation. This is a
known-source capture experiment, not a bit-identical music-export requirement.

The legacy protocol and its raw 42-run evidence remain intact. Both legacy and
v2 tests are opt-in. Hosted artifacts, not Git, retain new raw PCM. Failure at
any stage does not establish a production audio defect or automation parity.
