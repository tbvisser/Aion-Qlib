import { Component, type ReactNode } from 'react'

interface Props {
  children: ReactNode
  fallback?: ReactNode
}

interface State {
  error: Error | null
}

/**
 * Catch render-time errors and print them instead of failing to a blank screen.
 *
 * This is a diagnostic aid: if the app whitescreens, the user sees the file and
 * message rather than nothing, and can paste it into a bug report.
 */
export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  override render() {
    const { error } = this.state
    if (!error) return this.props.children

    if (this.props.fallback) return this.props.fallback

    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4 p-6 text-center">
        <h1 className="text-lg font-medium">Something went wrong</h1>
        <p className="max-w-xl rounded-lg border border-destructive/40 bg-destructive/5 p-4 font-mono text-xs text-destructive">
          {error.name}: {error.message}
        </p>
        {error.stack && (
          <pre className="max-h-96 max-w-2xl overflow-auto rounded-lg border border-border/50 p-3 text-left font-mono text-[10px] text-muted-foreground">
            {error.stack}
          </pre>
        )}
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground"
        >
          Reload page
        </button>
      </div>
    )
  }
}
