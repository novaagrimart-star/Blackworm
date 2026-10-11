import React from 'react';
import { AlertTriangle, Info, CheckCircle2, X } from 'lucide-react';

export interface DialogProps {
  isOpen: boolean;
  type?: 'confirm' | 'alert' | 'success';
  title?: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  onConfirm: () => void;
  onCancel?: () => void;
}

export function CustomDialogModal({
  isOpen,
  type = 'confirm',
  title,
  message,
  confirmText = 'Delete',
  cancelText = 'Cancel',
  onConfirm,
  onCancel,
}: DialogProps) {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs animate-fadeIn">
      <div 
        className="bg-white rounded-2xl shadow-2xl border border-slate-100 max-w-md w-full p-6 transform transition-all animate-scaleUp max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-4">
          <div className={`w-12 h-12 rounded-2xl flex items-center justify-center shrink-0 ${
            type === 'confirm' ? 'bg-rose-50 text-rose-600' :
            type === 'success' ? 'bg-emerald-50 text-emerald-600' : 'bg-blue-50 text-blue-600'
          }`}>
            {type === 'confirm' ? <AlertTriangle className="w-6 h-6" /> :
             type === 'success' ? <CheckCircle2 className="w-6 h-6" /> : <Info className="w-6 h-6" />}
          </div>

          <div className="flex-1 min-w-0">
            <h3 className="text-lg font-bold text-slate-900">
              {title || (type === 'confirm' ? 'Are you sure?' : type === 'success' ? 'Success' : 'Notice')}
            </h3>
            <p className="text-sm text-slate-600 mt-1.5 whitespace-pre-line leading-relaxed">
              {message}
            </p>
          </div>

          {onCancel && (
            <button 
              onClick={onCancel}
              className="text-slate-400 hover:text-slate-600 p-1 rounded-lg transition"
            >
              <X className="w-5 h-5" />
            </button>
          )}
        </div>

        <div className="mt-6 flex items-center justify-end gap-3">
          {onCancel && (
            <button
              type="button"
              onClick={onCancel}
              className="px-4 py-2.5 text-sm font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-xl transition active:scale-95"
            >
              {cancelText}
            </button>
          )}
          <button
            type="button"
            onClick={onConfirm}
            className={`px-5 py-2.5 text-sm font-semibold text-white rounded-xl shadow-md transition active:scale-95 ${
              type === 'confirm' ? 'bg-rose-600 hover:bg-rose-700 shadow-rose-200' : 'bg-slate-900 hover:bg-slate-800'
            }`}
          >
            {type === 'confirm' ? confirmText : 'OK'}
          </button>
        </div>
      </div>
    </div>
  );
}
