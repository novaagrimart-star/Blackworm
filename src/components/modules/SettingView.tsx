import React, { useState, useEffect, useRef } from 'react';
import { collection, query, onSnapshot, doc, deleteDoc, updateDoc, limit } from 'firebase/firestore';
import { db } from '../../firebase';
import { UserProfile, isAdmin } from '../../lib/auth';
import { 
  restoreRecord, 
  DeletedRecordItem, 
  AuditLogItem, 
  exportFullDatabaseBackup, 
  restoreDatabaseFromJson,
  getPendingSyncCount,
  startBackgroundSync,
  toTimestampMs,
  isQuotaBlocked
} from '../../lib/dataService';
import { safeClearTransientCaches } from '../../lib/localVault';
import { Language, translations } from '../../lib/i18n';
import { CustomDialogModal } from '../CustomDialogModal';
import { 
  Settings, 
  Trash2, 
  RotateCcw, 
  ShieldAlert, 
  History, 
  Globe, 
  HardDrive, 
  RefreshCw,
  Database,
  Download,
  Upload,
  ShieldCheck,
  CheckCircle2,
  AlertCircle,
  Loader2,
  FileJson
} from 'lucide-react';
import { cn } from '../../lib/utils';
import { useBranding } from '../../lib/branding';

interface Props {
  profile: UserProfile;
  lang: Language;
  onLogout: () => void;
}

export const SettingView: React.FC<Props> = ({ profile, lang, onLogout }) => {
  const t = translations[lang];
  const { logoUrl, logoSize, saveBranding } = useBranding();
  const [auditLogs, setAuditLogs] = useState<AuditLogItem[]>([]);
  const [activeTab, setActiveTab] = useState<'branding' | 'cache' | 'backup'>(isAdmin(profile) ? 'branding' : 'cache');
  const [isSavingLogo, setIsSavingLogo] = useState<boolean>(false);
  const [isClearingCache, setIsClearingCache] = useState<boolean>(false);
  const [isExportingBackup, setIsExportingBackup] = useState<boolean>(false);
  const [isRestoringBackup, setIsRestoringBackup] = useState<boolean>(false);
  const [backupStatusMessage, setBackupStatusMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [pendingSyncCount, setPendingSyncCount] = useState<number>(0);
  const [isSyncingNow, setIsSyncingNow] = useState<boolean>(false);
  const [localLogoSize, setLocalLogoSize] = useState<number>(logoSize);
  const sizeDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setLocalLogoSize(logoSize);
  }, [logoSize]);

  useEffect(() => {
    const userIsAdmin = isAdmin(profile);
    let unsubAudit: (() => void) | null = null;
    if (!isQuotaBlocked()) {
      const qAudit = query(collection(db, 'audit_logs'), limit(50));
      unsubAudit = onSnapshot(qAudit, (snap) => {
        let list: AuditLogItem[] = [];
        snap.forEach(d => list.push({ id: d.id, ...d.data() } as AuditLogItem));
        if (!userIsAdmin) {
          list = list.filter(item => item.performedByUid === profile.uid || item.performedByName === profile.fullName);
        }
        list.sort((a: any, b: any) => toTimestampMs(b.timestamp || b.createdAt) - toTimestampMs(a.timestamp || a.createdAt));
        setAuditLogs(list);
      }, (err) => {
        console.warn('SettingView audit logs sync notice:', err);
      });
    }

    const updateCount = () => setPendingSyncCount(getPendingSyncCount());
    updateCount();
    window.addEventListener('blackworm_sync_status', updateCount as EventListener);
    window.addEventListener('storage', updateCount);
    window.addEventListener('online', updateCount);

    return () => {
      if (unsubAudit) unsubAudit();
      window.removeEventListener('blackworm_sync_status', updateCount as EventListener);
      window.removeEventListener('storage', updateCount);
      window.removeEventListener('online', updateCount);
      if (sizeDebounceRef.current) clearTimeout(sizeDebounceRef.current);
    };
  }, [profile.uid, profile.role, profile.fullName]);

  const saveLogoConfig = async (newUrl: string, newSize: number) => {
    setIsSavingLogo(true);
    try {
      await saveBranding(newUrl, newSize, profile.uid);
    } catch (err) {
      console.error('Logo config save failed:', err);
    } finally {
      setIsSavingLogo(false);
    }
  };

  const handleLogoUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onloadend = () => {
      const base64 = reader.result as string;
      if (!base64) return;
      if (base64.length <= 450000) {
        saveLogoConfig(base64, localLogoSize);
        return;
      }
      const img = new Image();
      img.onload = () => {
        const maxDim = 512;
        let w = img.width;
        let h = img.height;
        if (w > maxDim || h > maxDim) {
          if (w > h) {
            h = Math.round((h * maxDim) / w);
            w = maxDim;
          } else {
            w = Math.round((w * maxDim) / h);
            h = maxDim;
          }
        }
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(img, 0, 0, w, h);
          const outputMime = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
          let resized = canvas.toDataURL(outputMime, 0.85);
          if (resized.length > 650000) {
            resized = canvas.toDataURL('image/jpeg', 0.8);
          }
          saveLogoConfig(resized, localLogoSize);
        } else {
          saveLogoConfig(base64, localLogoSize);
        }
      };
      img.onerror = () => {
        setDialogConfig({
          isOpen: true,
          type: 'alert',
          title: 'लोगो त्रुटी',
          message: 'निवडलेली इमेज वाचता आली नाही. कृपया वैध PNG किंवा JPG लोगो निवडा.',
          onConfirm: () => setDialogConfig(p => ({ ...p, isOpen: false })),
        });
      };
      img.src = base64;
    };
    reader.onerror = () => {
      setDialogConfig({
        isOpen: true,
        type: 'alert',
        title: 'लोगो त्रुटी',
        message: 'लोगो फाईल वाचताना त्रुटी आली.',
        onConfirm: () => setDialogConfig(p => ({ ...p, isOpen: false })),
      });
    };
    reader.readAsDataURL(file);
  };

  const handleSizeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newSize = parseInt(e.target.value, 10) || 80;
    setLocalLogoSize(newSize);
    if (sizeDebounceRef.current) clearTimeout(sizeDebounceRef.current);
    sizeDebounceRef.current = setTimeout(() => {
      saveLogoConfig(logoUrl, newSize);
    }, 350);
  };

  const [dialogConfig, setDialogConfig] = useState<{
    isOpen: boolean;
    type?: 'confirm' | 'alert' | 'success';
    title?: string;
    message: string;
    confirmText?: string;
    cancelText?: string;
    onConfirm: () => void;
    onCancel?: () => void;
  }>({
    isOpen: false,
    message: '',
    onConfirm: () => {},
  });

  const handleRestore = async (item: DeletedRecordItem) => {
    setDialogConfig({
      isOpen: true,
      type: 'confirm',
      title: 'Restore Confirmation',
      message: 'Are you sure you want to restore this record?',
      confirmText: 'Restore',
      cancelText: 'Cancel',
      onConfirm: async () => {
        setDialogConfig(prev => ({ ...prev, isOpen: false }));
        await restoreRecord(item, profile);
      },
      onCancel: () => setDialogConfig(prev => ({ ...prev, isOpen: false })),
    });
  };

  const handleClearCacheAndSync = async () => {
    setIsClearingCache(true);
    try {
      // 1. Flush any pending offline / dual-DB sync items before clearing HTTP/SW cache
      try {
        await startBackgroundSync();
      } catch (_) {}

      // 2. Safely clear only browser Cache API & Service Workers;
      //    never call localStorage.clear() so unsynced records & local vault remain 100% intact.
      await safeClearTransientCaches();

      // 3. Force reload without stale cache to fetch fresh code/data
      window.location.href = window.location.origin + window.location.pathname + '?fresh=' + Date.now();
    } catch (e) {
      window.location.reload();
    }
  };

  const handleManualSync = async () => {
    if (isSyncingNow) return;
    setIsSyncingNow(true);
    try {
      await startBackgroundSync();
      setPendingSyncCount(getPendingSyncCount());
      if (getPendingSyncCount() === 0) {
        setBackupStatusMessage({ type: 'success', text: 'सर्व डेटाबेस सिंक झाला आहे!' });
      } else {
        setBackupStatusMessage({ type: 'error', text: 'काही डेटा सिंक होऊ शकला नाही. इंटरनेट तपासा.' });
      }
    } catch (e) {
      console.error('Manual sync failed:', e);
    } finally {
      setIsSyncingNow(false);
      setTimeout(() => setBackupStatusMessage(null), 3000);
    }
  };

  const handleDownloadBackup = async () => {
    setIsExportingBackup(true);
    setBackupStatusMessage(null);
    try {
      const res = await exportFullDatabaseBackup(profile);
      setBackupStatusMessage({
        type: 'success',
        text: `संपूर्ण डेटाबेस बॅकअप यशस्वीरित्या डाउनलोड झाला: ${res.filename}`
      });
    } catch (err: any) {
      console.error('Backup export failed:', err);
      setBackupStatusMessage({
        type: 'error',
        text: `बॅकअप डाउनलोड करताना त्रुटी आली: ${err.message || err}`
      });
    } finally {
      setIsExportingBackup(false);
    }
  };

  const handleRestoreBackupFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setDialogConfig({
      isOpen: true,
      type: 'confirm',
      title: 'डेटाबेस रिस्टोर निश्चित करा',
      message: `तुम्ही "${file.name}" या फाईलमधून डेटाबेस रिस्टोर करू इच्छिता का? फाईलमधील सर्व रेकॉर्ड्स डेटाबेसमध्ये अपडेट/रिस्टोर केले जातील.`,
      confirmText: 'होय, रिस्टोर करा',
      cancelText: 'रद्द करा',
      onConfirm: async () => {
        setDialogConfig(prev => ({ ...prev, isOpen: false }));
        setIsRestoringBackup(true);
        setBackupStatusMessage(null);
        try {
          const reader = new FileReader();
          reader.onload = async (event) => {
            try {
              const content = event.target?.result as string;
              const res = await restoreDatabaseFromJson(content, profile);
              setBackupStatusMessage({
                type: 'success',
                text: res.message
              });
            } catch (err: any) {
              setBackupStatusMessage({
                type: 'error',
                text: `रिस्टोर अयशस्वी: ${err.message || err}`
              });
            } finally {
              setIsRestoringBackup(false);
            }
          };
          reader.onerror = () => {
            setIsRestoringBackup(false);
            setBackupStatusMessage({
              type: 'error',
              text: 'फाईल वाचताना त्रुटी आली. कृपया पुन्हा प्रयत्न करा.'
            });
          };
          reader.readAsText(file);
        } catch (err: any) {
          setIsRestoringBackup(false);
          setBackupStatusMessage({
            type: 'error',
            text: `फाईल वाचण्यात त्रुटी आली: ${err.message || err}`
          });
        }
      },
      onCancel: () => setDialogConfig(prev => ({ ...prev, isOpen: false })),
    });
    e.target.value = '';
  };

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-slate-900 flex items-center gap-2">
            <Settings className="w-6 h-6 text-slate-700" />
            {t.setting} & Data Management
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">Branding, system update and permanent database backup</p>
        </div>
      </div>

      <div className="flex gap-2 border-b border-slate-200 pb-2 overflow-x-auto">
        {isAdmin(profile) && (
          <button
            onClick={() => setActiveTab('branding')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition shrink-0 cursor-pointer ${activeTab === 'branding' ? 'bg-slate-900 text-white shadow-xs' : 'bg-white text-slate-600 border border-slate-200 hover:bg-slate-50'}`}
          >
            <Globe className="w-3.5 h-3.5" />
            <span>Branding</span>
          </button>
        )}
        <button
          onClick={() => setActiveTab('cache')}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition shrink-0 cursor-pointer ${activeTab === 'cache' ? 'bg-slate-900 text-white shadow-xs' : 'bg-white text-slate-600 border border-slate-200 hover:bg-slate-50'}`}
        >
          <RefreshCw className="w-3.5 h-3.5" />
          <span>Refresh Now</span>
        </button>
        <button
          onClick={() => setActiveTab('backup')}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition shrink-0 cursor-pointer ${activeTab === 'backup' ? 'bg-slate-900 text-white shadow-xs' : 'bg-white text-slate-600 border border-slate-200 hover:bg-slate-50'}`}
        >
          <Database className="w-3.5 h-3.5 text-emerald-500" />
          <span>Permanent Backup</span>
        </button>
      </div>

      {isAdmin(profile) && activeTab === 'branding' && (
        <div className="bg-white rounded-2xl border border-slate-200 p-6 space-y-6 text-xs">
          <div>
            <h3 className="text-sm font-bold text-slate-900">Company Branding</h3>
            <p className="text-[11px] text-slate-500">Update your company logo for forms and letterheads</p>
          </div>

          <div className="flex flex-col items-center gap-4 p-8 border-2 border-dashed border-slate-200 rounded-2xl bg-slate-50/50">
            <div className="w-48 h-48 bg-white rounded-2xl border border-slate-200 shadow-sm flex items-center justify-center overflow-hidden">
              {logoUrl ? (
                <img src={logoUrl} alt="Company Logo" style={{ width: `${localLogoSize}px`, height: `${localLogoSize}px` }} className="object-contain" />
              ) : (
                <Settings className="w-12 h-12 text-slate-200" />
              )}
            </div>
            
            <div className="w-full max-w-xs space-y-4">
              <div className="space-y-2">
                <div className="flex justify-between items-center">
                  <span className="font-bold text-slate-700">Logo Size: {localLogoSize}px</span>
                </div>
                <input
                  type="range"
                  min="40"
                  max="200"
                  value={localLogoSize}
                  onChange={handleSizeChange}
                  className="w-full h-2 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-rose-600"
                />
              </div>

              <div className="text-center">
                <input
                  type="file"
                  id="logo-upload"
                  className="hidden"
                  accept="image/*"
                  onChange={handleLogoUpload}
                  disabled={isSavingLogo}
                />
                <label
                  htmlFor="logo-upload"
                  className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-bold transition shadow-2xs cursor-pointer w-full justify-center active:scale-95 ${isSavingLogo ? 'bg-slate-100 text-slate-400' : 'bg-rose-600 text-white hover:bg-rose-700'}`}
                >
                  {isSavingLogo ? 'Uploading...' : logoUrl ? 'Change Company Logo' : 'Upload Company Logo'}
                </label>
              </div>
              <p className="text-[10px] text-slate-400 mt-2 uppercase tracking-widest font-bold text-center">Square aspect ratio recommended</p>
            </div>
          </div>
        </div>
      )}

      {activeTab === 'cache' && (
        <div className="bg-white rounded-2xl border border-slate-200 p-5 space-y-4 text-xs">
          <div>
            <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
              <RefreshCw className="w-4 h-4 text-rose-600" />
              <span>App Update & Data Sync</span>
            </h3>
            <p className="text-[11px] text-slate-500 mt-1">
              नवीन डेटा किंवा अपडेट्स त्वरित लोड करण्यासाठी खालील 'Refresh Now' बटण दाबा. सर्व डेटा तात्काळ सर्व्हरवरून रीफ्रेश केला जाईल.
            </p>
          </div>

          <div className="p-5 bg-slate-50 border border-slate-200 rounded-xl space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <h4 className="font-bold text-slate-800 text-sm">Real-Time Data Refresh</h4>
                <p className="text-[11px] text-slate-500 mt-0.5">
                  सर्व्हरवरून थेट डेटा अपडेट आणि ॲप स्टेट तात्काळ रिफ्रेश करा.
                </p>
              </div>

              <button
                type="button"
                onClick={handleClearCacheAndSync}
                disabled={isClearingCache}
                className="px-6 py-2.5 bg-rose-600 hover:bg-rose-700 disabled:opacity-50 text-white rounded-xl text-xs font-black transition flex items-center justify-center gap-2 shadow-sm active:scale-95 cursor-pointer shrink-0"
              >
                <RefreshCw className={`w-4 h-4 ${isClearingCache ? 'animate-spin' : ''}`} />
                <span>{isClearingCache ? 'Refreshing...' : 'Refresh Now'}</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {activeTab === 'backup' && (
        <div className="space-y-4 text-xs">
          {/* Guaranteed Data Safety Banner */}
          <div className="p-3.5 bg-emerald-50 border border-emerald-200 rounded-xl flex items-start gap-2.5 text-xs text-emerald-950">
            <ShieldCheck className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <h4 className="font-bold text-xs text-emerald-900">डेटा सुरक्षितता व कायमस्वरूपी बॅकअप हमी (Permanent Data Safety)</h4>
              <p className="text-emerald-800 text-[11px] leading-relaxed font-medium">
                ॲपमधील कोणताही सिंगल डेटा मॅन्युअल डिलीट केल्याशिवाय कधीही आपोआप डिलीट होत नाही. भविष्यात कोणत्याही परिस्थितीत ॲप इतर साइटवर किंवा नवीन सर्व्हरवर रन करण्यासाठी खालील बटनावर क्लिक करून संपूर्ण डेटाबेस फाईल डाउनलोड करा.
              </p>
            </div>
          </div>

          {backupStatusMessage && (
            <div className={cn(
              "p-3 rounded-xl border text-xs font-bold flex items-center gap-2 animate-in fade-in",
              backupStatusMessage.type === 'success' ? "bg-emerald-50 border-emerald-200 text-emerald-800" : "bg-rose-50 border-rose-200 text-rose-800"
            )}>
              {backupStatusMessage.type === 'success' ? (
                <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
              ) : (
                <AlertCircle className="w-4 h-4 text-rose-600 shrink-0" />
              )}
              <span>{backupStatusMessage.text}</span>
            </div>
          )}

          {/* 1. Full Database Export Card */}
          <div className="bg-white rounded-xl border border-slate-200 p-4 space-y-3 shadow-xs">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-lg bg-purple-100 text-purple-700 flex items-center justify-center shrink-0">
                <FileJson className="w-4 h-4" />
              </div>
              <div>
                <h3 className="text-xs sm:text-sm font-bold text-slate-900">Download Full Database Backup (.JSON)</h3>
                <p className="text-[10.5px] text-slate-500 font-medium">Dealers, Orders, Collections, Travel, Targets, Users & Products</p>
              </div>
            </div>

            <div className="p-2.5 bg-slate-50 border border-slate-200 rounded-lg text-xs space-y-0.5 text-slate-700">
              <p className="font-bold flex items-center gap-1.5 text-slate-800 text-[11px]">
                <HardDrive className="w-3.5 h-3.5 text-slate-600" />
                <span>Offline Persistence: Active</span>
              </p>
              <p className="text-[10.5px] text-slate-500">
                This JSON backup can be restored on any device or site.
              </p>
            </div>

            <button
              type="button"
              onClick={handleDownloadBackup}
              disabled={isExportingBackup}
              className="w-full py-2 bg-purple-600 hover:bg-purple-700 disabled:opacity-50 text-white rounded-lg text-xs font-bold shadow-xs transition flex items-center justify-center gap-2 active:scale-95 cursor-pointer"
            >
              {isExportingBackup ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>Exporting data...</span>
                </>
              ) : (
                <>
                  <Download className="w-3.5 h-3.5 stroke-[2.5]" />
                  <span>Download Full Backup (.JSON)</span>
                </>
              )}
            </button>
          </div>

          {/* 2. Database Restore Card (For Admin/Owner) */}
          {isAdmin(profile) && (
            <div className="bg-white rounded-xl border border-slate-200 p-4 space-y-3 shadow-xs">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-lg bg-blue-100 text-blue-700 flex items-center justify-center shrink-0">
                  <Upload className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="text-xs sm:text-sm font-bold text-slate-900">Restore / Import Database</h3>
                  <p className="text-[10.5px] text-slate-500 font-medium">Restore all collections from a previously exported .JSON backup file</p>
                </div>
              </div>

              <div className="relative">
                <input
                  type="file"
                  accept=".json,application/json"
                  onChange={handleRestoreBackupFile}
                  disabled={isRestoringBackup}
                  id="backup-file-upload"
                  className="hidden"
                />
                <label
                  htmlFor="backup-file-upload"
                  className={cn(
                    "w-full py-2 border border-dashed border-blue-300 hover:border-blue-500 bg-blue-50/50 hover:bg-blue-50 text-blue-800 rounded-lg text-xs font-bold transition flex items-center justify-center gap-2 active:scale-95 cursor-pointer",
                    isRestoringBackup && "opacity-50 cursor-not-allowed"
                  )}
                >
                  {isRestoringBackup ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin text-blue-700" />
                      <span>Restoring database...</span>
                    </>
                  ) : (
                    <>
                      <Upload className="w-3.5 h-3.5 text-blue-700 stroke-[2.5]" />
                      <span>Select JSON Backup & Restore Database</span>
                    </>
                  )}
                </label>
              </div>
            </div>
          )}
        </div>
      )}

      <CustomDialogModal {...dialogConfig} />
    </div>
  );
};
