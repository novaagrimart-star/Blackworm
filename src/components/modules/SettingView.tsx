import React, { useState, useEffect, useRef } from 'react';
import { getFriendlyErrorMessage } from '../../firebase';
import { UserProfile, isAdmin } from '../../lib/auth';
import {
  exportFullDatabaseBackup,
  restoreDatabaseFromJson,
  forceMultiTierSyncAll,
  safeFirestoreSet,
  syncWithSheetsFailover,
} from '../../lib/dataService';
import { hydrateAllChannelsFromSecondary } from '../../lib/realtimeStore';
import { safeClearTransientCaches } from '../../lib/localVault';
import {
  applyRemoteAppUpdate,
  checkRemoteAppVersion,
  resolveApiUrl,
} from '../../lib/appVersion';
import {
  GOOGLE_APPS_SCRIPT_TEMPLATE,
  getSheetsFailoverConfig,
  isValidAppsScriptUrl,
  saveSheetsFailoverConfigLocally,
  testSheetsFailoverConnection,
} from '../../lib/sheetsFailover';
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
  Table2,
  Copy,
  Check,
  ChevronDown,
  ChevronUp,
  LayoutGrid,
  Plus,
  Trash2,
  Eye,
  EyeOff,
  RotateCcw,
} from 'lucide-react';
import { cn } from '../../lib/utils';
import { useBranding } from '../../lib/branding';
import {
  useUiConfig,
  CustomDashboardOption,
  GridColumns,
  LayoutDensity,
  ModuleOptionOverride,
} from '../../lib/uiConfig';

interface Props {
  profile: UserProfile;
  lang: Language;
  onLogout: () => void;
}

const BUILTIN_OPTION_META: Array<{ id: string; defaultLabel: string }> = [
  { id: 'target', defaultLabel: 'Target Sheet' },
  { id: 'user', defaultLabel: 'User Form' },
  { id: 'office_staff', defaultLabel: 'Warehouse Incharge' },
  { id: 'order', defaultLabel: 'Orders' },
  { id: 'collection', defaultLabel: 'Collections' },
  { id: 'calculator', defaultLabel: 'Outstanding' },
  { id: 'price', defaultLabel: 'Price List' },
  { id: 'dealer', defaultLabel: 'Dealer' },
  { id: 'location', defaultLabel: 'Location Mapping' },
  { id: 'travel', defaultLabel: 'Traveling' },
  { id: 'scheme', defaultLabel: 'Scheme' },
  { id: 'report', defaultLabel: 'Report' },
  { id: 'setting', defaultLabel: 'Settings' },
];

export const SettingView: React.FC<Props> = ({ profile, lang }) => {
  const t = translations[lang];
  const userIsAdmin = isAdmin(profile);
  const { logoUrl, logoSize, saveBranding } = useBranding();
  const { uiConfig, saveUiConfig, resetUiConfig } = useUiConfig();
  const [activeTab, setActiveTab] = useState<'cache' | 'ui_config' | 'branding' | 'backup'>('cache');
  const [draftTitle, setDraftTitle] = useState<string>(uiConfig.appTitle);
  const [draftColumns, setDraftColumns] = useState<GridColumns>(uiConfig.gridColumns);
  const [draftDensity, setDraftDensity] = useState<LayoutDensity>(uiConfig.layoutDensity);
  const [draftOverrides, setDraftOverrides] = useState<Record<string, ModuleOptionOverride>>(
    uiConfig.moduleOverrides || {}
  );
  const [draftCustomOptions, setDraftCustomOptions] = useState<CustomDashboardOption[]>(
    uiConfig.customOptions || []
  );
  const [newOptionLabel, setNewOptionLabel] = useState<string>('');
  const [newOptionSubtitle, setNewOptionSubtitle] = useState<string>('');
  const [newOptionDescription, setNewOptionDescription] = useState<string>('');
  const [newOptionUrl, setNewOptionUrl] = useState<string>('');
  const [isSavingUiConfig, setIsSavingUiConfig] = useState<boolean>(false);
  const [uiConfigStatus, setUiConfigStatus] = useState<string>('');
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
  const [sheetsUrl, setSheetsUrl] = useState<string>(() => getSheetsFailoverConfig().webhookUrl);
  const [sheetsEnabled, setSheetsEnabled] = useState<boolean>(() => getSheetsFailoverConfig().enabled);
  const [isSavingSheets, setIsSavingSheets] = useState<boolean>(false);
  const [isTestingSheets, setIsTestingSheets] = useState<boolean>(false);
  const [isSyncingSheets, setIsSyncingSheets] = useState<boolean>(false);
  const [showAppsScriptCode, setShowAppsScriptCode] = useState<boolean>(false);
  const [copiedScript, setCopiedScript] = useState<boolean>(false);
  const [sheetsStatusMsg, setSheetsStatusMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const [localLogoSize, setLocalLogoSize] = useState<number>(logoSize);
  const sizeDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setLocalLogoSize(logoSize);
  }, [logoSize]);

  useEffect(() => {
    setDraftTitle(uiConfig.appTitle);
    setDraftColumns(uiConfig.gridColumns);
    setDraftDensity(uiConfig.layoutDensity);
    setDraftOverrides(uiConfig.moduleOverrides || {});
    setDraftCustomOptions(uiConfig.customOptions || []);
  }, [uiConfig]);

  useEffect(() => {
    return () => {
      if (sizeDebounceRef.current) clearTimeout(sizeDebounceRef.current);
    };
  }, []);

  const loadServerBackups = async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(resolveApiUrl('/api/sync/backups'), { signal: controller.signal });
      if (!res.ok) return;
      const json = await res.json();
      if (json?.ok && Array.isArray(json.backups)) {
        setServerBackups(json.backups);
      }
    } catch {
      // Non-blocking fallback when offline or standalone APK
    } finally {
      clearTimeout(timer);
    }
  };

  useEffect(() => {
    if (activeTab === 'backup' && userIsAdmin) {
      void loadServerBackups();
      const cfg = getSheetsFailoverConfig();
      if (cfg.webhookUrl) {
        setSheetsUrl(cfg.webhookUrl);
        setSheetsEnabled(cfg.enabled);
      }
    }
  }, [activeTab, userIsAdmin, profile.uid]);

  const handleSaveSheetsFailover = async () => {
    const cleanUrl = sheetsUrl.trim();
    if (cleanUrl && !isValidAppsScriptUrl(cleanUrl)) {
      setSheetsStatusMsg({ type: 'error', text: 'कृपया वैध HTTPS Google Apps Script Web App URL प्रविष्ट करा.' });
      return;
    }
    setIsSavingSheets(true);
    setSheetsStatusMsg(null);
    try {
      const enabledFlag = Boolean(sheetsEnabled && isValidAppsScriptUrl(cleanUrl));
      const payload = {
        webhookUrl: cleanUrl,
        enabled: enabledFlag,
        updatedAt: new Date().toISOString(),
        updatedBy: profile.uid,
        updatedByName: profile.fullName || 'Admin',
      };
      saveSheetsFailoverConfigLocally(payload);
      await safeFirestoreSet('config', 'sheets_failover', payload, { merge: true });
      setSheetsEnabled(enabledFlag);
      setSheetsStatusMsg({
        type: 'success',
        text: cleanUrl
          ? 'Google Sheets Failover URL सर्व डिव्हाइसेससाठी सुरक्षित जतन झाला!'
          : 'Google Sheets Failover बंद करण्यात आले.',
      });
    } catch (err: any) {
      setSheetsStatusMsg({
        type: 'error',
        text: getFriendlyErrorMessage(err, 'सेटिंग जतन करताना त्रुटी आली.'),
      });
    } finally {
      setIsSavingSheets(false);
    }
  };

  const handleTestSheetsFailover = async () => {
    setIsTestingSheets(true);
    setSheetsStatusMsg(null);
    try {
      const res = await testSheetsFailoverConnection(sheetsUrl);
      if (res.ok) {
        setSheetsStatusMsg({
          type: 'success',
          text: `कनेक्शन यशस्वी! Google Sheet "${res.sheetName || 'Connected'}" फेलओव्हरसाठी तयार आहे.`,
        });
      } else {
        setSheetsStatusMsg({
          type: 'error',
          text: res.error || 'Google Sheet शी संपर्क होऊ शकला नाही.',
        });
      }
    } finally {
      setIsTestingSheets(false);
    }
  };

  const handleSyncSheetsNow = async () => {
    setIsSyncingSheets(true);
    setSheetsStatusMsg(null);
    try {
      const res = await syncWithSheetsFailover({ pushLocal: true, pullRemote: true });
      if (res.ok) {
        setSheetsStatusMsg({
          type: 'success',
          text: `Google Sheet सिंक पूर्ण! (${res.pushed} नोंदी पाठवल्या, ${res.pulled} नोंदी तपासल्या)`,
        });
      } else {
        setSheetsStatusMsg({
          type: 'error',
          text: res.error || 'Google Sheet सिंक करता आले नाही.',
        });
      }
    } finally {
      setIsSyncingSheets(false);
    }
  };

  const handleCopyAppsScript = async () => {
    try {
      await navigator.clipboard.writeText(GOOGLE_APPS_SCRIPT_TEMPLATE);
      setCopiedScript(true);
      setTimeout(() => setCopiedScript(false), 2500);
    } catch {}
  };

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

      // 1. Run lightweight version check FIRST/concurrently so parallel sync fetches cannot starve it
      const [verRes, syncResult] = await Promise.all([
        checkRemoteAppVersion({
          manual: true,
          forceReloadOnUpdate: false,
        }),
        Promise.race([
          (async () => {
            const summary = await forceMultiTierSyncAll(true);
            return { ok: true as const, summary };
          })(),
          new Promise<{ ok: false; summary: null }>((resolve) =>
            setTimeout(() => resolve({ ok: false, summary: null }), 12000)
          ),
        ]).catch(() => ({ ok: false as const, summary: null })),
      ]);

      if (verRes.hasUpdate && verRes.remoteBuildId) {
        setRefreshStatus({
          type: 'success',
          text: 'नवीन अपडेट आढळले! नवीन आवृत्ती लागू होत आहे...',
        });
        await applyRemoteAppUpdate(verRes.remoteBuildId, verRes.remote?.version);
        return;
      }

      // 2. Refresh active channel state if secondary server is reachable, then clean volatile HTTP caches
      if (verRes.checked || (syncResult.ok && syncResult.summary?.secondaryReachable)) {
        await Promise.race([
          hydrateAllChannelsFromSecondary(true),
          new Promise((r) => setTimeout(r, 5000)),
        ]).catch(() => {});
      }

      await Promise.race([
        safeClearTransientCaches({ includeServiceWorker: false }),
        new Promise((r) => setTimeout(r, 2000)),
      ]);
      try {
        if ('serviceWorker' in navigator) {
          const reg = await navigator.serviceWorker.getRegistration();
          if (reg) await Promise.race([reg.update(), new Promise((r) => setTimeout(r, 1500))]);
        }
      } catch {}

      const serverOnline = Boolean(verRes.checked || (syncResult.ok && syncResult.summary?.secondaryReachable));
      const cloudOnline = Boolean(syncResult.ok && syncResult.summary?.firebaseReachable);
      const pulled = syncResult.ok && syncResult.summary ? syncResult.summary.deltasPulled : 0;
      const pending = syncResult.ok && syncResult.summary ? syncResult.summary.pendingRemaining : 0;

      if (serverOnline) {
        setRefreshStatus({
          type: 'success',
          text:
            pending > 0
              ? `रिफ्रेश पूर्ण! ${pulled} नोंदी सिंक झाल्या (${pending} नोंदी रांगेत).`
              : `रिफ्रेश यशस्वी! सर्व डेटा सिंक झाला असून ॲप अद्ययावत आहे.`,
        });
        return;
      }

      if (cloudOnline) {
        setRefreshStatus({
          type: 'success',
          text:
            pending > 0
              ? `मुख्य क्लाउड डेटाबेस सिंक पूर्ण झाले (${pending} नोंदी रांगेत, ऑफलाइन डेटा सुरक्षित आहे).`
              : `मुख्य क्लाउड डेटाबेस सिंक यशस्वी! सर्व नोंदी अद्ययावत व सुरक्षित आहेत.`,
        });
        return;
      }

      setRefreshStatus({
        type: 'error',
        text: 'सर्व्हरशी संपर्क होऊ शकला नाही. स्थानिक डेटा सुरक्षित आहे, कृपया इंटरनेट तपासून पुन्हा Refresh करा.',
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
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch(resolveApiUrl('/api/sync/backup'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'manual_permanent_snapshot' }),
        signal: controller.signal,
      });
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
      clearTimeout(timer);
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
            onClick={() => setActiveTab('ui_config')}
            className={`flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-bold transition shrink-0 cursor-pointer whitespace-nowrap ${activeTab === 'ui_config' ? 'bg-slate-900 text-white shadow-xs' : 'bg-white text-slate-600 border border-slate-200 hover:bg-slate-50'}`}
          >
            <LayoutGrid className="w-3.5 h-3.5 text-rose-500" />
            <span>UI &amp; Options</span>
          </button>
        )}
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

      {userIsAdmin && activeTab === 'ui_config' && (
        <div className="bg-white rounded-2xl border border-slate-200 p-5 sm:p-6 space-y-6 text-xs shadow-2xs">
          <div className="flex flex-wrap items-center justify-between gap-3 pb-4 border-b border-slate-100">
            <div>
              <h3 className="text-sm sm:text-base font-bold text-slate-900 tracking-tight">
                Live UI Design, Layout &amp; Dashboard Options
              </h3>
              <p className="text-xs text-slate-500 mt-0.5">
                येथील कोणताही बदल (Add / Edit / Delete / Layout) सर्व डिव्हाइसेसवर रिफ्रेश किंवा APK अपडेटशिवाय लगेच लागू होतो
              </p>
            </div>
            {uiConfigStatus && (
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-800 font-bold text-xs">
                <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                <span>{uiConfigStatus}</span>
              </span>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="sm:col-span-3 space-y-1.5">
              <label className="block font-bold text-slate-700">Company Header Title</label>
              <input
                type="text"
                value={draftTitle}
                onChange={(e) => setDraftTitle(e.target.value)}
                className="w-full px-3 py-2 rounded-xl border border-slate-200 text-xs font-bold text-slate-900 focus:outline-none focus:border-rose-500"
                placeholder="BLACKWORM AGRITECH PVT LTD"
              />
            </div>

            <div className="space-y-1.5">
              <label className="block font-bold text-slate-700">Dashboard Grid Columns</label>
              <div className="grid grid-cols-3 gap-1.5">
                {([2, 3, 4] as GridColumns[]).map((cols) => (
                  <button
                    key={cols}
                    type="button"
                    onClick={() => setDraftColumns(cols)}
                    className={cn(
                      'py-2 rounded-lg font-bold border transition cursor-pointer',
                      draftColumns === cols
                        ? 'bg-slate-900 text-white border-slate-900'
                        : 'bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100'
                    )}
                  >
                    {cols} Cols
                  </button>
                ))}
              </div>
            </div>

            <div className="sm:col-span-2 space-y-1.5">
              <label className="block font-bold text-slate-700">Card Spacing &amp; Layout Density</label>
              <div className="grid grid-cols-3 gap-1.5">
                {(['compact', 'standard', 'spacious'] as LayoutDensity[]).map((density) => (
                  <button
                    key={density}
                    type="button"
                    onClick={() => setDraftDensity(density)}
                    className={cn(
                      'py-2 rounded-lg font-bold border capitalize transition cursor-pointer',
                      draftDensity === density
                        ? 'bg-slate-900 text-white border-slate-900'
                        : 'bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100'
                    )}
                  >
                    {density}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Built-in Dashboard Options Manager (Rename / Hide / Reorder) */}
          <div className="space-y-2.5 pt-2 border-t border-slate-100">
            <h4 className="font-bold text-slate-800">Built-in Dashboard Options (Modify Name / Show-Hide / Order)</h4>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {BUILTIN_OPTION_META.map((item, idx) => {
                const ov = draftOverrides[item.id] || {};
                const isHidden = Boolean(ov.hidden && item.id !== 'setting');
                return (
                  <div
                    key={item.id}
                    className={cn(
                      'flex items-center gap-2 p-2 rounded-xl border transition',
                      isHidden ? 'bg-slate-50 border-slate-200 opacity-65' : 'bg-white border-slate-200'
                    )}
                  >
                    <input
                      type="text"
                      value={ov.label ?? item.defaultLabel}
                      onChange={(e) =>
                        setDraftOverrides((prev) => ({
                          ...prev,
                          [item.id]: {
                            ...prev[item.id],
                            label: e.target.value,
                          },
                        }))
                      }
                      className="flex-1 min-w-0 px-2.5 py-1.5 rounded-lg border border-slate-200 text-xs font-semibold text-slate-800 focus:outline-none focus:border-rose-500"
                    />
                    <input
                      type="number"
                      value={typeof ov.order === 'number' ? ov.order : idx}
                      onChange={(e) =>
                        setDraftOverrides((prev) => ({
                          ...prev,
                          [item.id]: {
                            ...prev[item.id],
                            order: Number(e.target.value) || 0,
                          },
                        }))
                      }
                      className="w-14 px-2 py-1.5 rounded-lg border border-slate-200 text-xs font-mono text-center text-slate-700"
                      title="Display Order"
                    />
                    {item.id !== 'setting' && (
                      <button
                        type="button"
                        onClick={() =>
                          setDraftOverrides((prev) => ({
                            ...prev,
                            [item.id]: {
                              ...prev[item.id],
                              hidden: !prev[item.id]?.hidden,
                            },
                          }))
                        }
                        className={cn(
                          'p-1.5 rounded-lg border cursor-pointer transition',
                          isHidden
                            ? 'bg-rose-50 border-rose-200 text-rose-600'
                            : 'bg-emerald-50 border-emerald-200 text-emerald-700'
                        )}
                        title={isHidden ? 'Option Hidden — Click to Show' : 'Option Visible — Click to Hide'}
                      >
                        {isHidden ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Custom Dashboard Options (Add / Edit / Delete) */}
          <div className="space-y-3 pt-3 border-t border-slate-100">
            <h4 className="font-bold text-slate-800">Custom Dashboard Options (नवीन ऑप्शन Add / Edit / Delete करा)</h4>

            {draftCustomOptions.length > 0 && (
              <div className="space-y-2">
                {draftCustomOptions.map((opt) => (
                  <div
                    key={opt.id}
                    className="flex flex-wrap sm:flex-nowrap items-center gap-2 p-2.5 rounded-xl border border-slate-200 bg-slate-50"
                  >
                    <input
                      type="text"
                      value={opt.label}
                      onChange={(e) =>
                        setDraftCustomOptions((prev) =>
                          prev.map((x) => (x.id === opt.id ? { ...x, label: e.target.value } : x))
                        )
                      }
                      className="flex-1 min-w-[140px] px-2.5 py-1.5 rounded-lg border border-slate-200 bg-white text-xs font-bold text-slate-800"
                      placeholder="Option Name"
                    />
                    <input
                      type="text"
                      value={opt.subtitle || ''}
                      onChange={(e) =>
                        setDraftCustomOptions((prev) =>
                          prev.map((x) => (x.id === opt.id ? { ...x, subtitle: e.target.value } : x))
                        )
                      }
                      className="flex-1 min-w-[120px] px-2.5 py-1.5 rounded-lg border border-slate-200 bg-white text-xs text-slate-700"
                      placeholder="Subtitle (Optional)"
                    />
                    <button
                      type="button"
                      onClick={() =>
                        setDraftCustomOptions((prev) => prev.filter((x) => x.id !== opt.id))
                      }
                      className="p-1.5 rounded-lg bg-rose-50 hover:bg-rose-100 border border-rose-200 text-rose-600 cursor-pointer"
                      title="Delete Option"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div className="p-3 rounded-xl border border-dashed border-slate-300 bg-slate-50/70 space-y-2">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <input
                  type="text"
                  value={newOptionLabel}
                  onChange={(e) => setNewOptionLabel(e.target.value)}
                  placeholder="नवीन ऑप्शनचे नाव (उदा. Circular / New Offer)"
                  className="px-3 py-2 rounded-lg border border-slate-200 bg-white text-xs font-semibold text-slate-800"
                />
                <input
                  type="text"
                  value={newOptionSubtitle}
                  onChange={(e) => setNewOptionSubtitle(e.target.value)}
                  placeholder="लहान उपशीर्षक (Optional)"
                  className="px-3 py-2 rounded-lg border border-slate-200 bg-white text-xs text-slate-700"
                />
                <input
                  type="text"
                  value={newOptionUrl}
                  onChange={(e) => setNewOptionUrl(e.target.value)}
                  placeholder="लिंक URL (Optional, उदा. https://...)"
                  className="px-3 py-2 rounded-lg border border-slate-200 bg-white text-xs text-slate-700"
                />
                <input
                  type="text"
                  value={newOptionDescription}
                  onChange={(e) => setNewOptionDescription(e.target.value)}
                  placeholder="सविस्तर सूचना किंवा माहिती (Optional)"
                  className="px-3 py-2 rounded-lg border border-slate-200 bg-white text-xs text-slate-700"
                />
              </div>
              <button
                type="button"
                onClick={() => {
                  const lbl = newOptionLabel.trim();
                  if (!lbl) return;
                  const nextOpt: CustomDashboardOption = {
                    id: `custom_${Date.now()}`,
                    label: lbl,
                    subtitle: newOptionSubtitle.trim(),
                    description: newOptionDescription.trim(),
                    url: newOptionUrl.trim(),
                    color: 'text-indigo-600',
                    bg: 'bg-indigo-50',
                    enabled: true,
                    order: 100 + draftCustomOptions.length,
                  };
                  setDraftCustomOptions((prev) => [...prev, nextOpt]);
                  setNewOptionLabel('');
                  setNewOptionSubtitle('');
                  setNewOptionDescription('');
                  setNewOptionUrl('');
                }}
                disabled={!newOptionLabel.trim()}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-slate-800 hover:bg-slate-900 disabled:opacity-40 text-white font-bold text-xs cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Add Option to List</span>
              </button>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 pt-3 border-t border-slate-100">
            <button
              type="button"
              onClick={async () => {
                setIsSavingUiConfig(true);
                setUiConfigStatus('');
                try {
                  await resetUiConfig(profile.uid);
                  setUiConfigStatus('डीफॉल्ट लेआउट सर्व डिव्हाइसेसवर लागू झाले!');
                } finally {
                  setIsSavingUiConfig(false);
                }
              }}
              disabled={isSavingUiConfig}
              className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl border border-slate-200 bg-slate-50 hover:bg-slate-100 text-slate-700 font-bold text-xs cursor-pointer"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>Reset Default Layout</span>
            </button>

            <button
              type="button"
              onClick={async () => {
                setIsSavingUiConfig(true);
                setUiConfigStatus('');
                try {
                  await saveUiConfig(
                    {
                      appTitle: draftTitle,
                      gridColumns: draftColumns,
                      layoutDensity: draftDensity,
                      moduleOverrides: draftOverrides,
                      customOptions: draftCustomOptions,
                    },
                    profile.uid
                  );
                  setUiConfigStatus('सर्व 20-25 डिव्हाइसेसवर बदल लगेच सिंक झाले!');
                } finally {
                  setIsSavingUiConfig(false);
                }
              }}
              disabled={isSavingUiConfig}
              className="inline-flex items-center gap-2 px-6 py-2.5 rounded-xl bg-rose-600 hover:bg-rose-700 disabled:opacity-50 text-white font-black text-xs shadow-xs cursor-pointer"
            >
              {isSavingUiConfig ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
              <span>Save &amp; Push Live to All Devices</span>
            </button>
          </div>
        </div>
      )}

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

          {/* 3. Free Google Sheets Failover Continuity Card (Quota Exhaustion Backup) */}
          {isAdmin(profile) && (
            <div className="bg-white rounded-xl border border-slate-200 p-4 space-y-3 shadow-xs">
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2">
                  <div className="w-8 h-8 rounded-lg bg-emerald-100 text-emerald-700 flex items-center justify-center shrink-0">
                    <Table2 className="w-4 h-4" />
                  </div>
                  <div>
                    <h3 className="text-xs sm:text-sm font-bold text-slate-900">
                      Free Google Sheets Failover (Quota Backup Sync)
                    </h3>
                    <p className="text-[10.5px] text-slate-500 font-medium">
                      Firebase मोफत कोटा संपल्यास ऑर्डर, डीलर, कलेक्शन व रूट डेटा Google Sheet द्वारे मोफत सिंक होतो
                    </p>
                  </div>
                </div>
                <span
                  className={cn(
                    'px-2 py-0.5 rounded text-[10px] font-bold shrink-0',
                    sheetsEnabled && isValidAppsScriptUrl(sheetsUrl)
                      ? 'bg-emerald-100 text-emerald-800'
                      : 'bg-slate-100 text-slate-600'
                  )}
                >
                  {sheetsEnabled && isValidAppsScriptUrl(sheetsUrl) ? 'Active' : 'Optional'}
                </span>
              </div>

              {sheetsStatusMsg && (
                <div
                  className={cn(
                    'p-2.5 rounded-lg border text-[11px] font-bold flex items-center gap-2',
                    sheetsStatusMsg.type === 'success'
                      ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                      : 'bg-rose-50 border-rose-200 text-rose-800'
                  )}
                >
                  {sheetsStatusMsg.type === 'success' ? (
                    <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                  ) : (
                    <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                  )}
                  <span>{sheetsStatusMsg.text}</span>
                </div>
              )}

              <div className="space-y-2">
                <label className="block text-[11px] font-bold text-slate-700">
                  Google Apps Script Web App URL
                </label>
                <div className="flex flex-col sm:flex-row gap-2">
                  <input
                    type="url"
                    value={sheetsUrl}
                    onChange={(e) => {
                      const val = e.target.value;
                      setSheetsUrl(val);
                      if (isValidAppsScriptUrl(val)) setSheetsEnabled(true);
                    }}
                    placeholder="https://script.google.com/macros/s/.../exec"
                    className="flex-1 px-3 py-2 rounded-lg border border-slate-200 text-xs font-mono text-slate-800 focus:outline-none focus:border-emerald-500"
                  />
                  <label className="inline-flex items-center gap-1.5 px-2.5 py-2 rounded-lg border border-slate-200 bg-slate-50 text-[11px] font-bold text-slate-700 cursor-pointer shrink-0">
                    <input
                      type="checkbox"
                      checked={sheetsEnabled}
                      onChange={(e) => setSheetsEnabled(e.target.checked)}
                      className="rounded accent-emerald-600"
                    />
                    <span>Enable Failover</span>
                  </label>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <button
                  type="button"
                  onClick={handleSaveSheetsFailover}
                  disabled={isSavingSheets}
                  className="py-2 px-3 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white rounded-lg text-xs font-bold transition flex items-center justify-center gap-1.5 cursor-pointer"
                >
                  {isSavingSheets ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
                  <span>Save Across Devices</span>
                </button>
                <button
                  type="button"
                  onClick={handleTestSheetsFailover}
                  disabled={isTestingSheets || !sheetsUrl.trim()}
                  className="py-2 px-3 bg-slate-100 hover:bg-slate-200 disabled:opacity-50 text-slate-800 rounded-lg text-xs font-bold border border-slate-200 transition flex items-center justify-center gap-1.5 cursor-pointer"
                >
                  {isTestingSheets ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                  <span>Test Sheet URL</span>
                </button>
                <button
                  type="button"
                  onClick={handleSyncSheetsNow}
                  disabled={isSyncingSheets || !sheetsEnabled || !isValidAppsScriptUrl(sheetsUrl)}
                  className="py-2 px-3 bg-slate-800 hover:bg-slate-900 disabled:opacity-50 text-white rounded-lg text-xs font-bold transition flex items-center justify-center gap-1.5 cursor-pointer"
                >
                  {isSyncingSheets ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
                  <span>Sync Sheet Now</span>
                </button>
              </div>

              <div className="border-t border-slate-100 pt-2">
                <button
                  type="button"
                  onClick={() => setShowAppsScriptCode((prev) => !prev)}
                  className="inline-flex items-center gap-1.5 text-[11px] font-bold text-slate-600 hover:text-slate-900 cursor-pointer"
                >
                  {showAppsScriptCode ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                  <span>Free Google Apps Script Code व सेटअप पद्धत पहा</span>
                </button>

                {showAppsScriptCode && (
                  <div className="mt-2 p-3 bg-slate-50 border border-slate-200 rounded-lg space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-[11px] font-bold text-slate-700">
                        1) Google Sheet मधून Extensions → Apps Script उघडा • 2) खालील कोड पेस्ट करा • 3) Deploy → Web app (Anyone) निवडा
                      </p>
                      <button
                        type="button"
                        onClick={handleCopyAppsScript}
                        className="inline-flex items-center gap-1 px-2.5 py-1 bg-slate-900 text-white rounded text-[11px] font-bold shrink-0 cursor-pointer"
                      >
                        {copiedScript ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                        <span>{copiedScript ? 'Copied' : 'Copy Code'}</span>
                      </button>
                    </div>
                    <pre className="max-h-48 overflow-auto p-2 bg-white border border-slate-200 rounded text-[10px] font-mono text-slate-700 leading-relaxed">
                      {GOOGLE_APPS_SCRIPT_TEMPLATE}
                    </pre>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      <CustomDialogModal {...dialogConfig} />
    </div>
  );
};
