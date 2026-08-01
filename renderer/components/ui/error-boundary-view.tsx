import { Component, type ReactNode, type ErrorInfo } from "react";
import { AlertCircleIcon } from "lucide-react";

// ── Shared UI ──────────────────────────────────────────────────────────────────

function ErrorDisplay({ error, reset }: { error: Error; reset?: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-4 p-8 text-center">
      <AlertCircleIcon className="size-8 text-red-10" />
      <p className="text-body font-semibold text-fg">Something went wrong</p>
      <p className="text-footnote text-gray-9 max-w-md">{error.message}</p>
      {reset && (
        <button
          onClick={reset}
          className="mt-2 rounded-md px-3 py-1.5 text-footnote bg-fill hover:bg-fill-hover text-fg transition-colors"
        >
          Try again
        </button>
      )}
    </div>
  );
}

// ── Functional component — satisfies TanStack Router's ErrorRouteComponent ────
//
// Used as:  errorComponent={ErrorBoundaryView}
// TanStack Router catches the error and passes { error, reset } as props.

export function ErrorBoundaryView({ error, reset }: { error: Error; reset: () => void }) {
  return <ErrorDisplay error={error} reset={reset} />;
}

// ── Class-based boundary — wraps subtrees to catch render errors ───────────────
//
// Use as:  <ErrorBoundary> <Child /> </ErrorBoundary>

interface ErrorBoundaryProps {
  children?: ReactNode;
  fallback?: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[ErrorBoundary]", error, info);
  }

  render() {
    if (this.state.error) {
      return (
        this.props.fallback ?? (
          <ErrorDisplay
            error={this.state.error}
            reset={() => this.setState({ error: null })}
          />
        )
      );
    }
    return this.props.children ?? null;
  }
}
