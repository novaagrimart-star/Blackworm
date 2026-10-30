import React, { Component, ErrorInfo, ReactNode } from 'react';
import { AlertTriangle, RefreshCw, Home } from 'lucide-react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
    errorInfo: null,
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error, errorInfo: null };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Uncaught error caught by ErrorBoundary:', error, errorInfo);
    this.setState({ error, errorInfo });
  }

  private handleReset = () => {
    this.setState({ hasError: false, error: null, errorInfo: null });
    window.location.reload();
  };

  private handleHardReset = () => {
    try {
      // Clear session storage overrides if corrupt
      sessionStorage.removeItem('blackworm_outstanding_sent');
    } catch {}
    this.setState({ hasError: false, error: null, errorInfo: null });
    window.location.href = '/';
  };

  public render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
          <div className="max-w-md w-full bg-white rounded-2xl border-2 border-red-200 shadow-xl p-6 text-center space-y-4">
            <div className="w-14 h-14 bg-red-100 text-red-600 rounded-2xl flex items-center justify-center mx-auto shadow-inner">
              <AlertTriangle className="w-7 h-7" />
            </div>

            <div className="space-y-1">
              <h2 className="text-lg font-black text-slate-900">
                काहीतरी तांत्रिक अडचण आली
              </h2>
              <p className="text-xs text-slate-500">
                ॲप क्रॅश होण्यापासून सुरक्षित ठेवण्यात आले आहे. खालील बटण दाबून ॲप लगेच पुन्हा सुरू करू शकता.
              </p>
            </div>

            {this.state.error && (
              <div className="p-2.5 bg-slate-100 rounded-xl text-left overflow-x-auto max-h-32 text-[11px] font-mono text-slate-700 border border-slate-200">
                {this.state.error.message || 'Unknown technical error'}
              </div>
            )}

            <div className="flex items-center justify-center gap-2 pt-2">
              <button
                type="button"
                onClick={this.handleReset}
                className="flex items-center gap-1.5 px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-xl text-xs font-bold shadow-xs transition active:scale-95 cursor-pointer"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                <span>ॲप रीलोड करा</span>
              </button>

              <button
                type="button"
                onClick={this.handleHardReset}
                className="flex items-center gap-1.5 px-3 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl text-xs font-bold border border-slate-200 transition active:scale-95 cursor-pointer"
              >
                <Home className="w-3.5 h-3.5" />
                <span>मुख्य पानावर जा</span>
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
