import { Component, type ErrorInfo, type ReactNode } from 'react';
import { CrashScreen } from '@vibe/ui/components/CrashScreen';

interface AppErrorBoundaryProps {
  children: ReactNode;
}

interface AppErrorBoundaryState {
  error: Error | null;
  componentStack: string | null;
}

export class AppErrorBoundary extends Component<
  AppErrorBoundaryProps,
  AppErrorBoundaryState
> {
  state: AppErrorBoundaryState = {
    error: null,
    componentStack: null,
  };

  static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    return { error, componentStack: null };
  }

  componentDidCatch(_error: Error, errorInfo: ErrorInfo) {
    this.setState({ componentStack: errorInfo.componentStack ?? null });
  }

  render() {
    if (this.state.error) {
      return (
        <CrashScreen
          error={this.state.error}
          componentStack={this.state.componentStack}
        />
      );
    }

    return this.props.children;
  }
}
