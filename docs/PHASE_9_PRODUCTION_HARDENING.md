# Phase 9 — Production Hardening

## Objective

Move Apex Studio from a feature-complete development baseline toward a release-ready application by reducing failure impact, tightening regression coverage, and correcting release-facing inconsistencies without changing the audio architecture or adding new product scope.

## Phase 9 rules

- Work only from current `main`.
- One small, independently verifiable slice at a time.
- No AI, cloud/auth, collaboration, new instruments, new effects, advanced warp, or audio-engine rewrite.
- Do not enable TypeScript `strict` globally as part of hardening.
- Do not merge the abandoned Phase 7 branch.
- Every code change must pass the repository's existing validation workflows before merge.

## Phase 9A — Runtime failure containment

Implemented on `phase-9-production-hardening`:

- Add a root React error boundary so an unexpected render/component failure produces a recoverable UI instead of a blank application surface.
- Log the captured error and component stack through the existing application console path.
- Provide an explicit reload action.
- Keep the boundary isolated from project persistence and audio state.

## Next hardening slices

1. Verify Phase 9A through CI and review the failure path.
2. Audit release-facing documentation against implemented behavior and correct only confirmed inconsistencies.
3. Expand regression coverage around persistence/history and destructive playlist operations where gaps are confirmed.
4. Audit desktop packaging/security and release workflow assumptions.
5. Run a final release regression pass before tagging a production candidate.
