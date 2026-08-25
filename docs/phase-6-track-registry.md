# Phase 6 — Track Registry

The track state model is now merged into `main`. This increment adds the deterministic collection boundary used by later mixer, timeline, routing, automation, and persistence layers.

## Contract

- Track IDs are unique within a registry.
- Automatically generated IDs are not reused after removal.
- Track state is returned as copies so callers cannot mutate registry internals.
- Volume and pan updates reuse the validated mixer-channel contract.
- Empty names and missing tracks fail deterministically.
- The registry is UI-agnostic and does not alter audio routing.

## Gate

Do not merge this increment until CI, Audio Validation, and Desktop Validation are green.
