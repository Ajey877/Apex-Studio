# Contributing to Apex Studio

Thanks for helping improve Apex Studio.

## Before you start

- Check existing issues and pull requests before starting overlapping work.
- Keep changes focused. Avoid unrelated refactors in feature or bug-fix pull requests.
- Do not add cloud services, AI services, analytics, or new dependencies unless the change is explicitly justified and reviewed.
- Preserve the local-first architecture and existing audio behavior.

## Development

Requirements:

- Node.js 20 or newer
- npm

Install dependencies and run the development build:

```bash
npm install
npm run dev
```

## Validation

Before opening a pull request, run the checks relevant to your change. For audio or project-state changes, run:

```bash
npm run lint
npm run test:audio
npm run test:history
npm run test:lifecycle
npm run verify:desktop
npm run build
```

For Windows packaging changes, also run:

```bash
npm run package:win:dir
```

## Pull requests

Describe:

1. What changed.
2. Why it changed.
3. How it was tested.
4. Any known limitations or follow-up work.

Keep commits and pull requests small enough to review safely. Do not merge changes into `main` without the required CI validation.

## Bug reports

When reporting a bug, include the steps to reproduce it, expected behavior, actual behavior, and the browser/desktop environment where it occurred.
