# Automated Change Validation Checklist

This checklist is for small, reviewable contributions, including changes prepared by automated assistants.

## Before editing

- Confirm the target branch and base commit.
- Keep the change within the explicitly approved paths.
- Do not change dependencies, lockfiles, release workflows, secrets, or deployment settings as part of a documentation task.
- Never run candidate repository code during a docs-only validation.

## Documentation-only changes

- Confirm the candidate commit is based on the approved base commit.
- Confirm the changed paths and line counts match the reviewed plan.
- Run `git diff --check BASE..HEAD` to catch whitespace errors.
- Confirm the working tree is clean after validation.
- Record the exact commit SHA and validation result in the pull request.

## Code or audio changes

Run the checks relevant to the change. For audio or project-state work, the project contribution guide calls for:

```bash
npm run lint
npm run test:audio
npm run test:history
npm run test:lifecycle
npm run verify:desktop
npm run build
```

For Windows packaging changes, also run `npm run package:win:dir`. Browser and offline-rendering checks must run in the supported CI environment when required.

## Review and merge

- Explain what changed, why it changed, and exactly which checks passed.
- Record known limitations and any follow-up work.
- Keep changes on an isolated branch until required CI checks and human review are complete.
- Never treat a successful docs-only check as evidence that application code is safe to execute.
- Do not merge or release solely because an automated assistant reports success.
