import React, { Component, ErrorInfo, ReactNode } from 'react';
import { AlertTriangle, RefreshCw, ShieldCheck } from 'lucide-react';
import { getFriendlyErrorMessage } from '../firebase';
import { safeClearTransientCaches } from '../lib/localVault';

interface Props {
  children: ReactNode;
  resetKey?: string | number;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

function isDynamicImportOrChunkError(error: Error | null): boolean {
  if (!error) return false;
  const msg = (error.message || String(error)).toLowerCase();
  return (
    msg.includes('chunkloaderror') ||
    msg.includes('loading chunk') ||
    msg.includes('dynamically imported module') ||
    msg.includes('failed to fetch module')
  );
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

  public componentDidUpdate(prevProps: Props) {
    if (this.state.hasError && this.props.resetKey !== undefined && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false, error: null, errorInfo: null });
    }
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Uncaught error caught by ErrorBoundary:', error, errorInfo);

    // Auto-recover once if stale Vite module / chunk load error occurs after an update
    if (isDynamicImportOrChunkError(error)) {
      try {
        const lastReload = Number(sessionStorage.getItem('blackworm_chunk_reload_at') || '0');
        if (Date.now() - lastReload > 15000) {
          sessionStorage.setItem('blackworm_chunk_reload_at', String(Date.now()));
          void safeClearTransientCaches().finally(() => {
            window.location.reload();
          });
          return;
        }
      } catch {}
    }

    this.setState({ error, errorInfo });
  }

  private handleTryAgain = () => {
    this.setState({ hasError: false, error: null, errorInfo: null });
  };

  private handleReset = () => {
    this.setState({ hasError: false, error: null, errorInfo: null });
    window.location.reload();
  };

  private handleSafeCacheRepair = async () => {
    try {
      await safeClearTransientCaches();
      // Remove only disposable display caches; NEVER delete blackworm_pending_sync or blackworm_user_profile
      const keysToRemove: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k) continue;
        if (
          k.startsWith('blackworm_report_') ||
          k === 'blackworm_quota_blocked_until' ||
          k === 'blackworm_all_dealers' ||
          k === 'blackworm_cached_travel_sheets'
        ) {
          keysToRemove.push(k);
        }
      }
      keysToRemove.forEach((k) => localStorage.removeItem(k));
    } catch {}
    this.setState({ hasError: false, error: null, errorInfo: null });
    window.location.reload();
  };

  public render() {
    if (this.state.hasError) {
      const friendlyMessage = getFriendlyErrorMessage(
        this.state.error,
        'तात्पुरत्या तांत्रिक कारणामुळे ही स्क्रीन लोड होऊ शकली नाही. तुमचा सर्व डेटा सुरक्षित आहे.'
      );

      return (
        <div className="min-h-[60vh] bg-slate-50 flex items-center justify-center p-4">
          <div className="max-w-md w-full bg-white rounded-2xl border-2 border-amber-200 shadow-xl p-6 text-center space-y-4">
            <div className="w-14 h-14 bg-amber-100 text-amber-600 rounded-2xl flex items-center justify-center mx-auto shadow-inner">
              <AlertTriangle className="w-7 h-7" />
            </div>

            <div className="space-y-1.5">
              <h2 className="text-lg font-black text-slate-900">
                स्क्रीन पुन्हा लोड करा
              </h2>
              <p className="text-xs text-slate-600 leading-relaxed">
                {friendlyMessage}
              </p>
            </div>

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
                onClick={() => void this.handleSafeCacheRepair()}
                className="flex items-center gap-1.5 px-3 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl text-xs font-bold border border-slate-200 transition active:scale-95 cursor-pointer"
              >
                <ShieldCheck className="w-3.5 h-3.5 text-emerald-600" />
                <span>कॅश दुरुस्त करा</span>
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
