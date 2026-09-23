/**
 * Phase 8A — compile-time regression guard for real React type safety.
 *
 * Without `@types/react` / `@types/react-dom` the `react` module silently
 * resolves to `any` (the repository does not enable `noImplicitAny`), which
 * means JSX props, hooks and event handlers are never type-checked. That gap
 * hid several runtime crashes (modals rendered with missing required props).
 *
 * This file is never imported by the application bundle. It is only compiled
 * by `npm run lint` (`tsc --noEmit`): if React types ever degrade to `any`
 * again, the deliberate error below disappears and TypeScript fails the build
 * with "Unused '@ts-expect-error' directive".
 */
import { useState, type FC, type ReactElement } from 'react';

export function assertReactHooksAreTyped(): void {
  // @ts-expect-error useState returns a [state, setState] tuple, never a number.
  const value: number = useState(0);
  void value;
}

interface GuardProps {
  label: string;
}

const GuardComponent: FC<GuardProps> = ({ label }) => <span>{label}</span>;

export function assertJsxPropsAreTyped(): ReactElement {
  // @ts-expect-error `label` is a required prop and must be reported when missing.
  return <GuardComponent />;
}
