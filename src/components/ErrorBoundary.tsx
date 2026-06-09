import { Component, type ReactNode } from 'react';
import { createLogger, serializeError } from '../lib/logger';

const logger = createLogger('ErrorBoundary');

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    logger.error('React render error captured', {
      componentStack: errorInfo.componentStack,
    }, serializeError(error));
  }

  render() {
    if (this.state.hasError) {
      return (
        this.props.fallback || (
          <div className="flex-1 flex items-center justify-center p-8">
            <div className="text-center max-w-md">
              <h2 className="text-xl font-bold text-red-500 mb-2">渲染错误</h2>
              <p className="text-sm text-muted-foreground mb-4">
                {this.state.error?.message || '未知错误'}
              </p>
              <button
                className="px-4 py-2 bg-primary text-primary-foreground rounded"
                onClick={() => this.setState({ hasError: false, error: null })}
              >
                重试
              </button>
            </div>
          </div>
        )
      );
    }
    return this.props.children;
  }
}
