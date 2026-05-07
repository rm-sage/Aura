// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Component, type ErrorInfo, type ReactNode } from "react";

// ---------------------------------------------------------------------------
// ErrorBoundary — catches render errors below this point and shows a tiny
// glass diagnostic instead of letting the whole app render an empty screen.
// Errors are also pushed to the DevConsole via the `aura:dev-log` event so
// they're visible without a separate browser inspector.
// ---------------------------------------------------------------------------

interface Props {
  /** Optional name shown in the error card so multi-boundary apps can tell
   *  which subtree failed. */
  scope?: string;
  /** Render-prop fallback (overrides the default card). */
  fallback?: (error: Error, reset: () => void) => ReactNode;
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Push to DevConsole so we don't have to hunt for it in the OS console.
    window.dispatchEvent(
      new CustomEvent("aura:dev-log", {
        detail: {
          level: "error",
          source: "react",
          message: `${this.props.scope ?? "app"}: ${error.message}`,
          stack: `${error.stack ?? ""}\n--- React ---\n${info.componentStack ?? ""}`,
        },
      }),
    );
  }

  reset = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback) return this.props.fallback(error, this.reset);
    return (
      <div className="flex-1 flex items-center justify-center p-8">
        <div className="glass-panel-elevated rounded-2xl px-6 py-5 max-w-md
                        border border-red-400/30">
          <p className="text-red-300/85 text-xs font-semibold tracking-[0.18em] uppercase mb-1.5">
            {this.props.scope ?? "Render error"}
          </p>
          <p className="text-white/80 text-sm font-mono break-all leading-relaxed">
            {error.message}
          </p>
          <button
            onClick={this.reset}
            className="mt-4 px-3 py-1.5 rounded-full text-xs font-medium
                       bg-white/8 hover:bg-white/15 text-white/80 transition-colors"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }
}
