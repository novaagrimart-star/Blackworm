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

  private handleTryAgain = () => {
    this.setState({ hasError: false, error: null, errorInfo: null });
  };

  private handleReset = () => {
    this.setState({ hasError: false, error: null, errorInfo: null });
    window.location.reload();
  };

  private handleHardReset = () => {
    try {
      sessionStorage.clear();
      // Keep user login profile so user isn't logged out unnecessarily
      const profile = localStorage.getItem('blackworm_user_profile');
      localStorage.clear();
      if (profile) {
        localStorage.setItem('blackworm_user_profile', profile);
      }
    } catch {}
    this.setState({ hasError: false, error: null, errorInfo: null });
    window.location.reload();
  };

  public render() {
    if (this.state.hasError) {
      const errMsg = this.state.error?.message || String(this.state.error || 'Unknown technical error');
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
                ॲप क्रॅश होण्यापासून सुरक्षित ठेवण्यात आले आहे. खालीलपैकी योग्य पर्याय निवडा:
              </p>
            </div>

            {errMsg && (
              <div className="p-2.5 bg-slate-100 rounded-xl text-left overflow-x-auto max-h-28 text-[11px] font-mono text-slate-700 border border-slate-200 break-words">
                {errMsg}
              </div>
            )}

            <div className="flex flex-wrap items-center justify-center gap-2 pt-2">
              <button
                type="button"
                onClick={this.handleTryAgain}
                className="flex items-center gap-1.5 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-xs font-bold shadow-xs transition active:scale-95 cursor-pointer"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                <span>पुन्हा प्रयत्न करा</span>
              </button>

              <button
                type="button"
                onClick={this.handleReset}
                className="flex items-center gap-1.5 px-3 py-2 bg-slate-800 hover:bg-slate-900 text-white rounded-xl text-xs font-bold shadow-xs transition active:scale-95 cursor-pointer"
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
                <span>कॅश रीसेट करा</span>
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
