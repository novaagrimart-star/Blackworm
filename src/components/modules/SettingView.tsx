import React, { useState, useEffect } from 'react';
import { collection, query, onSnapshot, doc, deleteDoc, updateDoc, limit } from 'firebase/firestore';
import { db } from '../../firebase';
import { UserProfile, isAdmin } from '../../lib/auth';
import { restoreRecord, DeletedRecordItem, AuditLogItem } from '../../lib/dataService';
import { Language, translations } from '../../lib/i18n';
import { CustomDialogModal } from '../CustomDialogModal';
import { Settings, Trash2, RotateCcw, ShieldAlert, History, Globe, HardDrive } from 'lucide-react';

interface Props {
  profile: UserProfile;
  lang: Language;
  onLogout: () => void;
}

export const SettingView: React.FC<Props> = ({ profile, lang, onLogout }) => {
  const t = translations[lang];
  const [deletedItems, setDeletedItems] = useState<DeletedRecordItem[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLogItem[]>([]);
  const [activeTab, setActiveTab] = useState<'trash' | 'branding'>('trash');
  const [logoUrl, setLogoUrl] = useState<string>('');
  const [logoSize, setLogoSize] = useState<number>(80);
  const [isSavingLogo, setIsSavingLogo] = useState<boolean>(false);

  useEffect(() => {
    // Fetch branding config
    const unsubBranding = onSnapshot(doc(db, 'config', 'branding'), (snap) => {
      if (snap.exists()) {
        const data = snap.data();
        setLogoUrl(data.logoUrl || '');
        setLogoSize(data.logoSize || 80);
      }
    });
    const userIsAdmin = isAdmin(profile);
    const qTrash = query(collection(db, 'deleted_records'), limit(50));
    const unsubTrash = onSnapshot(qTrash, (snap) => {
      let list: DeletedRecordItem[] = [];
      snap.forEach(d => list.push({ id: d.id, ...d.data() } as DeletedRecordItem));
      if (!userIsAdmin) {
        list = list.filter(item => item.deletedByUid === profile.uid || item.deletedByName === profile.fullName);
      }
      setDeletedItems(list);
    });

    const qAudit = query(collection(db, 'audit_logs'), limit(50));
    const unsubAudit = onSnapshot(qAudit, (snap) => {
      let list: AuditLogItem[] = [];
      snap.forEach(d => list.push({ id: d.id, ...d.data() } as AuditLogItem));
      if (!userIsAdmin) {
        list = list.filter(item => item.performedByUid === profile.uid || item.performedByName === profile.fullName);
      }
      setAuditLogs(list.reverse());
    });

    return () => {
      unsubTrash();
      unsubAudit();
      unsubBranding();
    };
  }, []);

  const saveLogoConfig = async (newUrl: string, newSize: number) => {
    setIsSavingLogo(true);
    try {
      await updateDoc(doc(db, 'config', 'branding'), {
        logoUrl: newUrl,
        logoSize: newSize,
        updatedAt: new Date().toISOString(),
        updatedBy: profile.uid
      }).catch(async () => {
        const { setDoc } = await import('firebase/firestore');
        await setDoc(doc(db, 'config', 'branding'), {
          logoUrl: newUrl,
          logoSize: newSize,
          updatedAt: new Date().toISOString(),
          updatedBy: profile.uid
        });
      });
    } catch (err) {
      console.error('Logo config save failed:', err);
    } finally {
      setIsSavingLogo(false);
    }
  };

  const handleLogoUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onloadend = () => {
        const base64 = reader.result as string;
        setLogoUrl(base64);
        saveLogoConfig(base64, logoSize);
      };
      reader.readAsDataURL(file);
    }
  };

  const handleSizeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newSize = parseInt(e.target.value);
    setLogoSize(newSize);
  };

  const handleSizeSave = () => {
    saveLogoConfig(logoUrl, logoSize);
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

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-slate-900 flex items-center gap-2">
            <Settings className="w-6 h-6 text-slate-700" />
            {t.setting} & Data Recovery
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">Recycle bin, audit logs and system settings</p>
        </div>
      </div>

      <div className="flex gap-2 border-b border-slate-200 pb-2 overflow-x-auto">
        <button
          onClick={() => setActiveTab('trash')}
          className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold transition shrink-0 ${activeTab === 'trash' ? 'bg-slate-900 text-white' : 'bg-white text-slate-600 border border-slate-200'}`}
        >
          <Trash2 className="w-4 h-4" />
          <span>Recycle Bin ({deletedItems.length})</span>
        </button>
        <button
          onClick={() => setActiveTab('branding')}
          className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold transition shrink-0 ${activeTab === 'branding' ? 'bg-slate-900 text-white' : 'bg-white text-slate-600 border border-slate-200'}`}
        >
          <Globe className="w-4 h-4" />
          <span>Branding</span>
        </button>
      </div>

      {activeTab === 'trash' && (
        <div className="space-y-4">
          <div className="p-4 bg-amber-50 border border-amber-200 rounded-2xl flex items-center gap-3 text-xs text-amber-900">
            <ShieldAlert className="w-5 h-5 text-amber-600 shrink-0" />
            <span>Any data deleted by mistake is safe here. Click 'Restore' to reactivate it.</span>
          </div>

          {deletedItems.length === 0 ? (
            <div className="bg-white rounded-2xl border border-slate-200 p-12 text-center">
              <Trash2 className="w-12 h-12 text-slate-300 mx-auto mb-3" />
              <p className="text-sm font-semibold text-slate-700">Recycle Bin is empty</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3">
              {deletedItems.map(item => (
                <div key={item.id} className="bg-white rounded-2xl border border-slate-200 p-4 flex items-center justify-between shadow-sm">
                  <div>
                    <span className="text-[10px] font-bold bg-rose-50 text-rose-700 px-2 py-0.5 rounded uppercase">
                      {item.originalCollection}
                    </span>
                    <h4 className="text-sm font-bold text-slate-900 mt-1">
                      {item.data.name || item.data.shopName || item.data.title || item.originalRecordId}
                    </h4>
                    <p className="text-[11px] text-slate-400">Deleted by: {item.deletedByName} ({new Date(item.deletedAt).toLocaleString()})</p>
                  </div>
                  <button
                    onClick={() => handleRestore(item)}
                    className="flex items-center gap-1.5 px-3 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-xs font-bold transition shadow-sm"
                  >
                    <RotateCcw className="w-4 h-4" />
                    <span>Restore</span>
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {activeTab === 'branding' && (
        <div className="bg-white rounded-2xl border border-slate-200 p-6 space-y-6 text-xs">
          <div>
            <h3 className="text-sm font-bold text-slate-900">Company Branding</h3>
            <p className="text-[11px] text-slate-500">Update your company logo for forms and letterheads</p>
          </div>

          <div className="flex flex-col items-center gap-4 p-8 border-2 border-dashed border-slate-200 rounded-2xl bg-slate-50/50">
            <div className="w-48 h-48 bg-white rounded-2xl border border-slate-200 shadow-sm flex items-center justify-center overflow-hidden">
              {logoUrl ? (
                <img src={logoUrl} alt="Company Logo" style={{ width: `${logoSize}px`, height: `${logoSize}px` }} className="object-contain" />
              ) : (
                <Settings className="w-12 h-12 text-slate-200" />
              )}
            </div>
            
            <div className="w-full max-w-xs space-y-4">
              <div className="space-y-2">
                <div className="flex justify-between items-center">
                  <span className="font-bold text-slate-700">Logo Size: {logoSize}px</span>
                  <button 
                    onClick={handleSizeSave}
                    className="text-[10px] bg-slate-100 px-2 py-1 rounded font-bold hover:bg-slate-200"
                  >
                    Save Size
                  </button>
                </div>
                <input
                  type="range"
                  min="40"
                  max="200"
                  value={logoSize}
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
                  className={`inline-flex items-center gap-2 px-6 py-2.5 rounded-xl text-xs font-bold transition shadow-sm cursor-pointer w-full justify-center ${isSavingLogo ? 'bg-slate-100 text-slate-400' : 'bg-rose-600 text-white hover:bg-rose-700'}`}
                >
                  {isSavingLogo ? 'Uploading...' : logoUrl ? 'Change Company Logo' : 'Upload Company Logo'}
                </label>
              </div>
              <p className="text-[10px] text-slate-400 mt-3 uppercase tracking-widest font-bold text-center">Square aspect ratio recommended</p>
            </div>
          </div>
        </div>
      )}

      <CustomDialogModal {...dialogConfig} />
    </div>
  );
};
