# Phase 4.2D — Product Naming Audit

This phase removes third-party product branding from user-facing Apex Studio terminology without changing DSP behavior.

## Scope

- Use Apex Studio-owned names for built-in effects.
- Keep internal effect identifiers stable where changing them would require migration work.
- Do not claim third-party compatibility or affiliation.
- Verify the UI and persisted project data separately before changing serialized identifiers.

## Current confirmed UI references

The mixer currently exposes these names:

- Parametric EQ 2
- Fruity Reverb
- Fruity Compressor
- Master Limiter

These are being treated as naming cleanup targets. DSP behavior is out of scope for this pass.

## Deferred

The repository-wide search endpoint was unavailable during this audit, so unverified references elsewhere are not being guessed or blindly replaced.
