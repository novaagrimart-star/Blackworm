import React, { useState, useEffect, useRef } from 'react';
import { getFriendlyErrorMessage } from '../../firebase';
import { UserProfile, isAdmin } from '../../lib/auth';
import {
  exportFullDatabaseBackup,
  restoreDatabaseFromJson,
  forceMultiTierSyncAll,
} from '../../lib/dataService';
import { hydrateAllChannelsFromSecondary } from '../../lib/realtimeStore';
import { safeClearTransientCaches } from '../../lib/localVault';
import {
  applyRemoteAppUpdate,
  checkRemoteAppVersion,
  resolveApiUrl,
} from '../../lib/appVersion';
import { Language, translations } from '../../lib/i18n';
import { CustomDialogModal } from '../CustomDialogModal';
import {
  Settings,
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
  FileJson,
  Image as ImageIcon,
} from 'lucide-react';
import { cn } from '../../lib/utils';
import { useBranding } from '../../lib/branding';

interface Props {
  profile: UserProfile;
  lang: Language;
  onLogout: () => void;
}

export const SettingView: React.FC<Props> = ({ profile, lang }) => {
  const t = translations[lang];
  const userIsAdmin = isAdmin(profile);
  const { logoUrl, logoSize, saveBranding } = useBranding();
  const [activeTab, setActiveTab] = useState<'cache' | 'branding' | 'backup'>('cache');
  const [isSavingLogo, setIsSavingLogo] = useState<boolean>(false);
  const [brandingSavedToast, setBrandingSavedToast] = useState<boolean>(false);
  const [isClearingCache, setIsClearingCache] = useState<boolean>(false);
  const [refreshStatus, setRefreshStatus] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [isExportingBackup, setIsExportingBackup] = useState<boolean>(false);
  const [isCreatingServerBackup, setIsCreatingServerBackup] = useState<boolean>(false);
  const [isRestoringBackup, setIsRestoringBackup] = useState<boolean>(false);
  const [serverBackups, setServerBackups] = useState<
    Array<{ filename: string; sizeBytes: number; modifiedAtMs: number }>
  >([]);
  const [backupStatusMessage, setBackupStatusMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const [localLogoSize, setLocalLogoSize] = useState<number>(logoSize);
  const sizeDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setLocalLogoSize(logoSize);
  }, [logoSize]);

  useEffect(() => {
    return () => {
      if (sizeDebounceRef.current) clearTimeout(sizeDebounceRef.current);
    };
  }, []);

  const loadServerBackups = async () => {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4500);
      const res = await fetch(resolveApiUrl('/api/sync/backups'), { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) return;
      const json = await res.json();
      if (json?.ok && Array.isArray(json.backups)) {
        setServerBackups(json.backups);
      }
    } catch {}
  };

  useEffect(() => {
    if (activeTab === 'backup' && userIsAdmin) {
      void loadServerBackups();
    }
  }, [activeTab, userIsAdmin, profile.uid]);

  const saveLogoConfig = async (newUrl: string, newSize: number) => {
    setIsSavingLogo(true);
    try {
      await saveBranding(newUrl, newSize, profile.uid);
      setBrandingSavedToast(true);
      setTimeout(() => setBrandingSavedToast(false), 3000);
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
          onConfirm: () => setDialogConfig((p) => ({ ...p, isOpen: false })),
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
        onConfirm: () => setDialogConfig((p) => ({ ...p, isOpen: false })),
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

  const handleClearCacheAndSync = async () => {
    if (isClearingCache) return;
    setIsClearingCache(true);
    setRefreshStatus(null);

    try {
      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        setRefreshStatus({
          type: 'error',
          text: 'इंटरनेट कनेक्शन उपलब्ध नाही. ऑफलाइन डेटा सुरक्षित आहे, इंटरनेट सुरू झाल्यावर पुन्हा प्रयत्न करा.',
        });
        return;
      }

      // 1. Bounded multi-tier sync & channel refresh (never hangs)
      const syncResult = await Promise.race([
        (async () => {
          const summary = await forceMultiTierSyncAll(true);
          await hydrateAllChannelsFromSecondary(true);
          return { ok: true as const, summary };
        })(),
        new Promise<{ ok: false; summary: null }>((resolve) =>
          setTimeout(() => resolve({ ok: false, summary: null }), 10000)
        ),
      ]).catch(() => ({ ok: false as const, summary: null }));

      // 2. Check remote build version without forcing blind redirect yet
      const verRes = await checkRemoteAppVersion({
        manual: true,
        forceReloadOnUpdate: false,
      });

      if (verRes.hasUpdate && verRes.remoteBuildId) {
        setRefreshStatus({
          type: 'success',
          text: 'नवीन अपडेट आढळले! नवीन आवृत्ती लागू होत आहे...',
        });
        await applyRemoteAppUpdate(verRes.remoteBuildId, verRes.remote?.version);
        return;
      }

      // 3. Clear only transient HTTP/SW caches when on current build and report crisp outcome
      await Promise.race([
        safeClearTransientCaches(),
        new Promise((r) => setTimeout(r, 2000)),
      ]);

      if (!verRes.checked) {
        setRefreshStatus({
          type: 'error',
          text: syncResult.ok
            ? 'स्थानिक डेटा रिफ्रेश झाला, परंतु सर्व्हर तपासताना अडचण आली. कृपया पुन्हा प्रयत्न करा.'
            : 'सर्व्हरशी संपर्क होऊ शकला नाही. कृपया इंटरनेट तपासून पुन्हा Refresh करा.',
        });
        return;
      }

      const pulled = syncResult.ok && syncResult.summary ? syncResult.summary.deltasPulled : 0;
      const pending = syncResult.ok && syncResult.summary ? syncResult.summary.pendingRemaining : 0;
      setRefreshStatus({
        type: 'success',
        text:
          pending > 0
            ? `रिफ्रेश पूर्ण! ${pulled} नोंदी सिंक झाल्या (${pending} नोंदी रांगेत).`
            : `रिफ्रेश यशस्वी! सर्व डेटा सिंक झाला असून ॲप अद्ययावत आहे.`,
      });
    } catch (err: any) {
      setRefreshStatus({
        type: 'error',
        text: getFriendlyErrorMessage(err, 'रिफ्रेश करताना त्रुटी आली. कृपया पुन्हा प्रयत्न करा.'),
      });
    } finally {
      setIsClearingCache(false);
    }
  };

  const handleDownloadBackup = async () => {
    setIsExportingBackup(true);
    setBackupStatusMessage(null);
    try {
      const res = await exportFullDatabaseBackup(profile);
      setBackupStatusMessage({
        type: 'success',
        text: res.serverBackupFile
          ? `संपूर्ण डेटाबेस बॅकअप यशस्वीरित्या डाउनलोड झाला (${res.filename}) आणि सर्व्हर स्नॅपशॉट सुरक्षित जतन झाला.`
          : `संपूर्ण डेटाबेस बॅकअप यशस्वीरित्या डाउनलोड झाला: ${res.filename}`,
      });
      void loadServerBackups();
    } catch (err: any) {
      console.error('Backup export failed:', err);
      setBackupStatusMessage({
        type: 'error',
        text: getFriendlyErrorMessage(err, 'बॅकअप डाउनलोड करताना त्रुटी आली. कृपया पुन्हा प्रयत्न करा.'),
      });
    } finally {
      setIsExportingBackup(false);
    }
  };

  const handleCreateServerBackup = async () => {
    if (isCreatingServerBackup) return;
    setIsCreatingServerBackup(true);
    setBackupStatusMessage(null);
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(resolveApiUrl('/api/sync/backup'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'manual_permanent_snapshot' }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      const json = await res.json();
      if (!res.ok || !json?.ok) {
        throw new Error(json?.error || 'Server backup failed');
      }
      setBackupStatusMessage({
        type: 'success',
        text: `सर्व्हरवर कायमस्वरूपी स्नॅपशॉट सुरक्षित जतन झाला (${json.recordCount || 0} नोंदी).`,
      });
      await loadServerBackups();
    } catch (err: any) {
      setBackupStatusMessage({
        type: 'error',
        text: getFriendlyErrorMessage(err, 'सर्व्हर बॅकअप तयार करताना त्रुटी आली. कृपया पुन्हा प्रयत्न करा.'),
      });
    } finally {
      setIsCreatingServerBackup(false);
    }
  };

  const handleRestoreBackupFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setDialogConfig({
      isOpen: true,
      type: 'confirm',
      title: 'डेटाबेस रिस्टोर निश्चित करा',
      message: `तुम्ही "${file.name}" या फाईलमधून डेटाबेस रिस्टोर करू इच्छिता का? फाईलमधील सर्व रेकॉर्ड्स सुरक्षितपणे जोडले जातील व नवीन लाइव्ह नोंदी Overwrite केल्या जाणार नाहीत.`,
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
                text: res.message,
              });
            } catch (err: any) {
              setBackupStatusMessage({
                type: 'error',
                text: getFriendlyErrorMessage(err, 'रिस्टोर करताना त्रुटी आली. कृपया वैध बॅकअप JSON फाईल निवडा.'),
              });
            } finally {
              setIsRestoringBackup(false);
            }
          };
          reader.onerror = () => {
            setIsRestoringBackup(false);
            setBackupStatusMessage({
              type: 'error',
              text: 'फाईल वाचताना त्रुटी आली. कृपया पुन्हा प्रयत्न करा.',
            });
          };
          reader.readAsText(file);
        } catch (err: any) {
          setIsRestoringBackup(false);
          setBackupStatusMessage({
            type: 'error',
            text: getFriendlyErrorMessage(err, 'फाईल वाचण्यात त्रुटी आली. कृपया पुन्हा प्रयत्न करा.'),
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
            {isAdmin(profile) ? `${t.setting} & Data Management` : 'Settings'}
          </h2>
          {isAdmin(profile) && (
            <p className="text-xs text-slate-500 mt-0.5">Branding, system update and permanent database backup</p>
          )}
        </div>
      </div>

      <div className="flex gap-2 border-b border-slate-200 pb-2 overflow-x-auto">
        <button
          type="button"
          onClick={() => setActiveTab('cache')}
          className={`flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-bold transition shrink-0 cursor-pointer whitespace-nowrap ${activeTab === 'cache' ? 'bg-slate-900 text-white shadow-xs' : 'bg-white text-slate-600 border border-slate-200 hover:bg-slate-50'}`}
        >
          <RefreshCw className="w-3.5 h-3.5" />
          <span>Refresh Now</span>
        </button>
        {userIsAdmin && (
          <button
            type="button"
            onClick={() => setActiveTab('branding')}
            className={`flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-bold transition shrink-0 cursor-pointer whitespace-nowrap ${activeTab === 'branding' ? 'bg-slate-900 text-white shadow-xs' : 'bg-white text-slate-600 border border-slate-200 hover:bg-slate-50'}`}
          >
            <Globe className="w-3.5 h-3.5" />
            <span>Branding</span>
          </button>
        )}
        {userIsAdmin && (
          <button
            type="button"
            onClick={() => setActiveTab('backup')}
            className={`flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-bold transition shrink-0 cursor-pointer whitespace-nowrap ${activeTab === 'backup' ? 'bg-slate-900 text-white shadow-xs' : 'bg-white text-slate-600 border border-slate-200 hover:bg-slate-50'}`}
          >
            <Database className="w-3.5 h-3.5 text-emerald-500" />
            <span>Permanent Backup</span>
          </button>
        )}
      </div>

      {activeTab === 'cache' && (
        <div className="bg-white rounded-2xl border border-slate-200 p-8 sm:p-10 flex flex-col items-center justify-center gap-4 text-center shadow-2xs">
          {refreshStatus && (
            <div
              className={cn(
                'w-full max-w-md p-3 rounded-xl border text-xs font-bold flex items-center justify-center gap-2',
                refreshStatus.type === 'success'
                  ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                  : 'bg-rose-50 border-rose-200 text-rose-800'
              )}
            >
              {refreshStatus.type === 'success' ? (
                <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
              ) : (
                <AlertCircle className="w-4 h-4 text-rose-600 shrink-0" />
              )}
              <span>{refreshStatus.text}</span>
            </div>
          )}

          <button
            type="button"
            onClick={handleClearCacheAndSync}
            disabled={isClearingCache}
            className="px-7 py-3.5 bg-rose-600 hover:bg-rose-700 disabled:opacity-50 text-white rounded-xl text-xs sm:text-sm font-black transition flex items-center justify-center gap-2.5 shadow-sm active:scale-95 cursor-pointer whitespace-nowrap"
          >
            <RefreshCw className={`w-4 h-4 shrink-0 ${isClearingCache ? 'animate-spin' : ''}`} />
            <span>{isClearingCache ? 'Syncing & Checking Update...' : 'Check Update & Refresh Now'}</span>
          </button>
        </div>
      )}

      {userIsAdmin && activeTab === 'branding' && (
        <div className="bg-white rounded-2xl border border-slate-200 p-5 sm:p-6 space-y-6 text-xs shadow-2xs">
          <div className="flex items-center justify-between gap-3 pb-4 border-b border-slate-100">
            <div>
              <h3 className="text-sm sm:text-base font-bold text-slate-900 tracking-tight">Company Branding</h3>
              <p className="text-xs text-slate-500 mt-0.5">Configure your company logo and display scale for headers &amp; official forms</p>
            </div>
            {brandingSavedToast && (
              <span className="inline-flex items-center gap-1.5 text-emerald-700 font-bold text-xs shrink-0">
                <CheckCircle2 className="w-4 h-4" />
                <span>Saved</span>
              </span>
            )}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-12 gap-6 items-center">
            {/* Modern Studio Logo Showcase */}
            <div className="md:col-span-5 flex flex-col items-center gap-2.5">
              <div
                className="w-52 h-52 rounded-2xl border border-slate-200 bg-slate-50 flex items-center justify-center overflow-hidden p-3 relative"
                style={{
                  backgroundImage:
                    'radial-gradient(#cbd5e1 1px, transparent 1px)',
                  backgroundSize: '14px 14px',
                }}
              >
                {logoUrl ? (
                  <img
                    src={logoUrl}
                    alt="Company Logo"
                    style={{ width: `${localLogoSize}px`, height: `${localLogoSize}px` }}
                    className="object-contain transition-transform duration-150 drop-shadow-xs"
                  />
                ) : (
                  <div className="flex flex-col items-center gap-2 text-slate-400">
                    <ImageIcon className="w-10 h-10 stroke-[1.5]" />
                    <span className="text-[11px] font-medium">No Logo Uploaded</span>
                  </div>
                )}
              </div>
              <p className="text-[11px] font-mono tabular-nums font-semibold text-slate-500">
                Preview: {localLogoSize} × {localLogoSize} px
              </p>
            </div>

            {/* Clean Typography & Scale Controls */}
            <div className="md:col-span-7 space-y-5">
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <label className="text-xs font-bold text-slate-800">Logo Display Size</label>
                  <span className="text-xs font-mono tabular-nums font-bold text-slate-900">
                    {localLogoSize}px
                  </span>
                </div>

                <input
                  type="range"
                  min="40"
                  max="200"
                  value={localLogoSize}
                  onChange={handleSizeChange}
                  className="w-full h-2 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-rose-600"
                />

                <div className="flex items-center gap-2 pt-0.5">
                  {([
                    { label: 'Compact', value: 64 },
                    { label: 'Standard', value: 96 },
                    { label: 'Large', value: 140 },
                  ] as const).map((preset) => {
                    const isPresetActive = Math.abs(localLogoSize - preset.value) <= 4;
                    return (
                      <button
                        key={preset.value}
                        type="button"
                        onClick={() => {
                          setLocalLogoSize(preset.value);
                          void saveLogoConfig(logoUrl, preset.value);
                        }}
                        className={cn(
                          'flex-1 py-1.5 px-2.5 rounded-lg text-[11px] font-semibold transition border cursor-pointer whitespace-nowrap',
                          isPresetActive
                            ? 'bg-slate-900 text-white border-slate-900'
                            : 'bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100'
                        )}
                      >
                        {preset.label} · {preset.value}px
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="pt-4 border-t border-slate-100 space-y-2.5">
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
                  className={cn(
                    'inline-flex items-center justify-center gap-2 px-5 py-3 rounded-xl text-xs font-bold transition w-full cursor-pointer active:scale-95',
                    isSavingLogo
                      ? 'bg-slate-100 text-slate-400 cursor-not-allowed'
                      : 'bg-rose-600 hover:bg-rose-700 text-white shadow-xs'
                  )}
                >
                  {isSavingLogo ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span>Uploading Logo...</span>
                    </>
                  ) : (
                    <>
                      <Upload className="w-4 h-4 shrink-0" />
                      <span>{logoUrl ? 'Change Company Logo' : 'Upload Company Logo'}</span>
                    </>
                  )}
                </label>
                <p className="text-[11px] text-slate-500 text-center">
                  PNG, JPG or SVG · Recommended 1:1 square aspect ratio
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      {isAdmin(profile) && activeTab === 'backup' && (
        <div className="space-y-4 text-xs">
          {/* Guaranteed Data Safety Banner */}
          <div className="p-3.5 bg-emerald-50 border border-emerald-200 rounded-xl flex items-start gap-2.5 text-xs text-emerald-950">
            <ShieldCheck className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <h4 className="font-bold text-xs text-emerald-900">डेटा सुरक्षितता व कायमस्वरूपी बॅकअप हमी (Permanent Data Safety)</h4>
              <p className="text-emerald-800 text-[11px] leading-relaxed font-medium">
                ॲपमधील कोणताही डेटा आपोआप डिलीट किंवा Overwrite होत नाही. खालील बटनावरून संपूर्ण डेटाबेस फाईल डाउनलोड करा किंवा सर्व्हरवर स्नॅपशॉट जतन करा.
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
                <p className="text-[10.5px] text-slate-500 font-medium">Dealers, Orders, Collections, Travel, Targets, Outstanding, Users & Products</p>
              </div>
            </div>

            <div className="p-2.5 bg-slate-50 border border-slate-200 rounded-lg text-xs space-y-0.5 text-slate-700">
              <p className="font-bold flex items-center gap-1.5 text-slate-800 text-[11px]">
                <HardDrive className="w-3.5 h-3.5 text-slate-600" />
                <span>
                  Offline Persistence: Active • Server Snapshots: {serverBackups.length}
                </span>
              </p>
              <p className="text-[10.5px] text-slate-500">
                This JSON backup merges live, secondary, and offline records safely and can be restored anytime.
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
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

              <button
                type="button"
                onClick={handleCreateServerBackup}
                disabled={isCreatingServerBackup}
                className="w-full py-2 bg-slate-800 hover:bg-slate-900 disabled:opacity-50 text-white rounded-lg text-xs font-bold shadow-xs transition flex items-center justify-center gap-2 active:scale-95 cursor-pointer"
              >
                {isCreatingServerBackup ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    <span>Saving Snapshot...</span>
                  </>
                ) : (
                  <>
                    <Database className="w-3.5 h-3.5" />
                    <span>Save Server Snapshot Now</span>
                  </>
                )}
              </button>
            </div>
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
                  <p className="text-[10.5px] text-slate-500 font-medium">Restore safely from a previously exported .JSON backup file (preserves newer live records)</p>
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
