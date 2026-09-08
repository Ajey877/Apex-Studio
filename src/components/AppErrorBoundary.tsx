import React, { Component, type ErrorInfo, type ReactNode } from 'react';

interface AppErrorBoundaryProps {
  children: ReactNode;
}

interface AppErrorBoundaryState {
  hasError: boolean;
  errorMessage: string | null;
}

export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = {
    hasError: false,
    errorMessage: null
  };

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
    if (!this.state.hasError) return this.props.children;

    return (
      <main className="min-h-screen bg-black px-6 py-12 text-white">
        <section className="mx-auto max-w-xl rounded-xl border border-white/10 bg-white/5 p-8 shadow-xl">
          <p className="mb-2 text-xs font-semibold uppercase tracking-[0.2em] text-white/50">
            Apex Studio
          </p>
          <h1 className="text-2xl font-semibold">Apex Studio could not load this view.</h1>
          <p className="mt-3 text-sm leading-6 text-white/70">
            The application hit an unexpected error. Your saved project data is kept separate from this screen failure.
          </p>
          {this.state.errorMessage && (
            <details className="mt-5 rounded-lg bg-black/30 p-3 text-xs text-white/50">
              <summary className="cursor-pointer">Technical details</summary>
              <pre className="mt-2 whitespace-pre-wrap break-words">{this.state.errorMessage}</pre>
            </details>
          )}
          <button
            type="button"
            onClick={this.handleReload}
            className="mt-6 rounded-lg bg-white px-4 py-2 text-sm font-semibold text-black transition hover:bg-white/90"
          >
            Reload Apex Studio
          </button>
        </section>
      </main>
    );
  }
}
