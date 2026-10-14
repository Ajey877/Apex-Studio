import React, { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * UI-03P: the last full-screen surface that was still painted with literals.
 *
 * The fallback renders when a child throws, which can happen before any modal
 * or panel mounts, so it may not be the *focused* surface — but the palette is
 * already decided on `<html data-theme>` by the pre-paint bootstrap, so every
 * `--apex-*` token resolves and the fallback follows the active theme instead of
 * staying black in Light.
 */
interface AppErrorBoundaryProps {
  children: ReactNode;
}

interface AppErrorBoundaryState {
  hasError: boolean;
  errorMessage: string | null;
}

export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  private readonly children: ReactNode;

  state: AppErrorBoundaryState = {
    hasError: false,
    errorMessage: null
  };

  constructor(props: AppErrorBoundaryProps) {
    super(props);
    this.children = props.children;
  }

  static getDerivedStateFromError(error: unknown): AppErrorBoundaryState {
    return {
      hasError: true,
      errorMessage: error instanceof Error ? error.message : null
    };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error('[Apex Studio] Unhandled application render error.', error, info.componentStack);
  }

  private handleReload = () => {
    window.location.reload();
  };

  render() {
    if (!this.state.hasError) return this.children;

    return (
      <main className="min-h-screen bg-[var(--apex-bg)] px-6 py-12 text-[var(--apex-text)]">
        <section className="mx-auto max-w-xl rounded-xl border border-[var(--apex-border)] bg-[var(--apex-surface)] p-8 shadow-xl">
          <p className="mb-2 text-xs font-semibold uppercase tracking-[0.2em] text-[var(--apex-text-3)]">
            Apex Studio
          </p>
          <h1 className="text-2xl font-semibold">Apex Studio could not load this view.</h1>
          <p className="mt-3 text-sm leading-6 text-[var(--apex-text-2)]">
            The application hit an unexpected error. Reload Apex Studio to try again.
          </p>
          {this.state.errorMessage && (
            <details className="mt-5 rounded-lg bg-[var(--apex-canvas)] p-3 text-xs text-[var(--apex-text-3)]">
              <summary className="cursor-pointer">Technical details</summary>
              <pre className="mt-2 whitespace-pre-wrap break-words">{this.state.errorMessage}</pre>
            </details>
          )}
          <button
            type="button"
            onClick={this.handleReload}
            className="mt-6 rounded-lg bg-[var(--apex-accent)] px-4 py-2 text-sm font-semibold text-[var(--apex-state-playing-fg)] transition hover:bg-[var(--apex-accent-strong)]"
          >
            Reload Apex Studio
          </button>
        </section>
      </main>
    );
  }
}
