import React, { useState, useEffect, useRef } from 'react';
import { 
  collection, 
  query, 
  onSnapshot, 
  doc, 
  setDoc
} from 'firebase/firestore';
import { db } from '../../firebase';
import { UserProfile, isAdmin } from '../../lib/auth';
import { logAudit } from '../../lib/dataService';
import { Language, translations } from '../../lib/i18n';
import jsPDF from 'jspdf';
import html2canvas from 'html2canvas-pro';
import { 
  Target, 
  ChevronDown,
  User as UserIcon,
  Save,
  CheckCircle2,
  Printer,
  Download,
  Loader2,
  Phone,
  Mail,
  X
} from 'lucide-react';

interface MonthlyData {
  month: string;
  target: number;
  achievement: number;
  collection: number;
  actualCollection: number;
}

interface YearlySheet {
  id: string;
  userId: string;
  fullName: string;
  designation: string;
  center: string;
  year: string;
  lastYearSale: number;
  lastYearCollection: number;
  salesTarget: number;
  lastYearOutstanding: number;
  collectionPercent: number; // Percentage for current year collection target
  months: MonthlyData[];
}

interface Props {
  profile: UserProfile;
  lang: Language;
}

export const TargetSheetView: React.FC<Props> = ({ profile, lang }) => {
  const userIsAdmin = isAdmin(profile);
  const [users, setUsers] = useState<UserProfile[]>([]);
  const [selectedUserId, setSelectedUserId] = useState<string>(profile.uid);
  const [sheet, setYearlySheet] = useState<YearlySheet | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);
  const [isGeneratingPdf, setIsGeneratingPdf] = useState(false);

  // If not admin, lock selectedUserId to logged-in user profile
  useEffect(() => {
    if (!userIsAdmin) {
      setSelectedUserId(profile.uid);
    }
  }, [userIsAdmin, profile.uid]);

  // Branding
  const [logoUrl, setLogoUrl] = useState<string>('');
  const [logoSize, setLogoSize] = useState<number>(80);
  const [selectedUserPhoto, setSelectedUserPhoto] = useState<string>('');

  const printableSheetRef = useRef<HTMLDivElement>(null);

  // User photo listener
  useEffect(() => {
    const user = users.find(u => u.uid === selectedUserId) || profile;
    if (user && (user as any).photoUrl) {
      setSelectedUserPhoto((user as any).photoUrl);
    } else {
      setSelectedUserPhoto('');
    }
  }, [selectedUserId, users, profile]);

  const monthsList = [
    'April', 'May', 'June', 
    'July', 'August', 'September', 
    'October', 'November', 'December', 
    'January', 'February', 'March'
  ];

  // Branding listener
  useEffect(() => {
    const unsubBranding = onSnapshot(doc(db, 'config', 'branding'), (snap) => {
      if (snap.exists()) {
        const data = snap.data();
        setLogoUrl(data.logoUrl || '');
        setLogoSize(data.logoSize || 80);
      }
    });
    return () => unsubBranding();
  }, []);

  // Fetch users for dropdown
  useEffect(() => {
    const q = query(collection(db, 'users'));
    const unsub = onSnapshot(q, (snap) => {
      const list: UserProfile[] = [];
      snap.forEach(d => list.push({ ...d.data() } as UserProfile));
      list.sort((a, b) => (a.fullName || '').localeCompare(b.fullName || ''));
      setUsers(list);
    });
    return () => unsub();
  }, []);

  // Fetch or init sheet for selected user
  useEffect(() => {
    setLoading(true);
    const selectedUser = users.find(u => u.uid === selectedUserId) || profile;
    const isOwner = selectedUser.role === 'owner';

    if (isOwner) {
      // Aggregation logic for owner
      const q = query(collection(db, 'yearly_targets'));
      const unsub = onSnapshot(q, (snap) => {
        const allSheets: YearlySheet[] = [];
        snap.forEach(d => {
          const data = d.data() as YearlySheet;
          // Only aggregate sheets that are NOT owners (to avoid self-recursion or circular summing)
          // We look up the user for this sheet to check role
          const sheetUser = users.find(u => u.uid === data.userId);
          if (sheetUser && sheetUser.role !== 'owner') {
            allSheets.push(data);
          }
        });

        // Sum everything up
        const consolidatedSheet: YearlySheet = {
          id: `consolidated_owner_${selectedUserId}`,
          userId: selectedUserId,
          fullName: selectedUser.fullName || selectedUser.uid,
          designation: 'CONSOLIDATED (TOTAL)',
          center: 'ALL CENTERS',
          year: '2026-27',
          lastYearSale: allSheets.reduce((acc, s) => acc + (s.lastYearSale || 0), 0),
          lastYearCollection: allSheets.reduce((acc, s) => acc + (s.lastYearCollection || 0), 0),
          salesTarget: allSheets.reduce((acc, s) => acc + (s.salesTarget || 0), 0),
          lastYearOutstanding: allSheets.reduce((acc, s) => acc + (s.lastYearOutstanding || 0), 0),
          collectionPercent: 0, // Not applicable for sum
          months: monthsList.map(mName => {
            const mData = {
              month: mName,
              target: 0,
              achievement: 0,
              collection: 0,
              actualCollection: 0
            };
            allSheets.forEach(s => {
              const sm = s.months.find(month => month.month === mName);
              if (sm) {
                mData.target += (sm.target || 0);
                mData.achievement += (sm.achievement || 0);
                mData.collection += (sm.collection || 0);
                mData.actualCollection += (sm.actualCollection || 0);
              }
            });
            return mData;
          })
        };
        setYearlySheet(consolidatedSheet);
        setLoading(false);
      });
      return () => unsub();
    } else {
      // Regular fetching for individual users
      const sheetId = `yearly_${selectedUserId}_2026_27`;
      const unsub = onSnapshot(doc(db, 'yearly_targets', sheetId), (docSnap) => {
        if (docSnap.exists()) {
          setYearlySheet(docSnap.data() as YearlySheet);
        } else {
          const newSheet: YearlySheet = {
            id: sheetId,
            userId: selectedUserId,
            fullName: selectedUser.fullName || selectedUser.uid,
            designation: selectedUser.designation || 'FIELD OFFICER',
            center: selectedUser.center || '',
            year: '2026-27',
            lastYearSale: 0,
            lastYearCollection: 0,
            salesTarget: 0,
            lastYearOutstanding: 0,
            collectionPercent: 40,
            months: monthsList.map(m => ({
              month: m,
              target: 0,
              achievement: 0,
              collection: 0,
              actualCollection: 0
            }))
          };
          setYearlySheet(newSheet);
        }
        setLoading(false);
      });
      return () => unsub();
    }
  }, [selectedUserId, users, profile]);

  const updateSheet = (updates: Partial<YearlySheet>) => {
    if (!sheet) return;
    const selectedUser = users.find(u => u.uid === selectedUserId) || profile;
    if (selectedUser.role === 'owner') return; // Cannot edit consolidated sheet

    let newSheet = { ...sheet, ...updates };
    
    // If collectionPercent updated, update all months' collection targets
    if (updates.hasOwnProperty('collectionPercent')) {
      const perc = Number(updates.collectionPercent) || 0;
      newSheet.months = newSheet.months.map(m => ({
        ...m,
        collection: Number((m.achievement * (perc / 100)).toFixed(2))
      }));
    }
    
    setYearlySheet(newSheet);
  };

  const updateMonth = (index: number, updates: Partial<MonthlyData>) => {
    if (!sheet) return;
    const selectedUser = users.find(u => u.uid === selectedUserId) || profile;
    if (selectedUser.role === 'owner') return; // Cannot edit consolidated sheet

    const newMonths = [...sheet.months];
    let monthUpdate = { ...newMonths[index], ...updates };
    
    // If achievement updated, auto-calculate collection target based on percentage
    if (updates.hasOwnProperty('achievement')) {
      const ach = Number(updates.achievement) || 0;
      const perc = sheet.collectionPercent || 0;
      monthUpdate.collection = Number((ach * (perc / 100)).toFixed(2));
    }
    
    newMonths[index] = monthUpdate;
    setYearlySheet({ ...sheet, months: newMonths });
  };

  const handleSave = async () => {
    if (!sheet) return;
    setSaving(true);
    try {
      await setDoc(doc(db, 'yearly_targets', sheet.id), {
        ...sheet,
        updatedAt: new Date().toISOString()
      }, { merge: true });
      await logAudit('UPDATE', 'yearly_targets', sheet.id, `Updated yearly target sheet for ${sheet.fullName}`, profile);
      setShowSuccess(true);
      setTimeout(() => setShowSuccess(false), 3000);
    } catch (err) {
      console.error('Save failed:', err);
    } finally {
      setSaving(false);
    }
  };

  const handleDownloadPdf = async () => {
    if (!printableSheetRef.current) return;
    try {
      setIsGeneratingPdf(true);
      const element = printableSheetRef.current;
      
      const canvas = await html2canvas(element, {
        scale: 2.5,
        useCORS: true,
        logging: false,
        backgroundColor: '#ffffff',
        windowWidth: 1024,
      });

      const imgData = canvas.toDataURL('image/jpeg', 0.98);
      const pdf = new jsPDF({
        orientation: 'portrait',
        unit: 'mm',
        format: 'a4'
      });

      const pdfWidth = pdf.internal.pageSize.getWidth();
      const pdfHeight = (canvas.height * pdfWidth) / canvas.width;
      
      pdf.addImage(imgData, 'JPEG', 0, 0, pdfWidth, Math.min(pdfHeight, 297));
      const sanitizedName = (sheet?.fullName ? `Target_Sheet_${sheet.fullName}` : 'Target_Sheet_2026_27').replace(/[^a-zA-Z0-9_-]/g, '_');
      pdf.save(`${sanitizedName}.pdf`);
    } catch (err: any) {
      console.error('PDF download error:', err);
      window.print();
    } finally {
      setIsGeneratingPdf(false);
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center p-12">
        <div className="w-8 h-8 border-4 border-red-600 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }
  if (!sheet) return null;

  const calculateQuarter = (mIndexes: number[]) => {
    const qMonths = mIndexes.map(i => sheet.months[i]);
    const target = qMonths.reduce((acc, m) => acc + (m.target || 0), 0);
    const achievement = qMonths.reduce((acc, m) => acc + (m.achievement || 0), 0);
    const collection = qMonths.reduce((acc, m) => acc + (m.collection || 0), 0);
    const actual = qMonths.reduce((acc, m) => acc + (m.actualCollection || 0), 0);
    return { target, achievement, collection, actual };
  };

  const Q1 = calculateQuarter([0, 1, 2]);
  const Q2 = calculateQuarter([3, 4, 5]);
  const Q3 = calculateQuarter([6, 7, 8]);
  const Q4 = calculateQuarter([9, 10, 11]);
  const Total = {
    target: Q1.target + Q2.target + Q3.target + Q4.target,
    achievement: Q1.achievement + Q2.achievement + Q3.achievement + Q4.achievement,
    collection: Q1.collection + Q2.collection + Q3.collection + Q4.collection,
    actual: Q1.actual + Q2.actual + Q3.actual + Q4.actual
  };

  const selectedUser = users.find(u => u.uid === selectedUserId) || profile;
  const isOwnerView = selectedUser.role === 'owner';

  return (
    <div className="space-y-4 font-sans pb-12">
      <style dangerouslySetInnerHTML={{ __html: `
        input[type=number]::-webkit-inner-spin-button,
        input[type=number]::-webkit-outer-spin-button {
          -webkit-appearance: none;
          margin: 0;
        }
        input[type=number] {
          -moz-appearance: textfield;
        }
      ` }} />
      {/* Top Action Toolbar */}
      <div className="bg-white p-3 rounded-2xl border border-slate-200 shadow-md flex flex-col sm:flex-row items-center justify-between gap-3 no-print">
        {/* User Selector: Dropdown for Admin, Locked Badge for Non-Admin */}
        <div className="flex items-center gap-2 w-full sm:w-auto">
          {userIsAdmin ? (
            <div className="relative flex-1 sm:w-72">
              <UserIcon className="w-4 h-4 absolute left-3 top-3 text-slate-400" />
              <select 
                value={selectedUserId}
                onChange={(e) => setSelectedUserId(e.target.value)}
                className="w-full pl-9 pr-8 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs font-black focus:outline-none focus:ring-2 focus:ring-red-500 appearance-none uppercase"
              >
                {users.map(u => (
                  <option key={u.uid} value={u.uid}>{u.fullName || u.uid} ({u.role})</option>
                ))}
              </select>
              <ChevronDown className="w-4 h-4 absolute right-3 top-3 text-slate-400 pointer-events-none" />
            </div>
          ) : (
            <div className="flex items-center gap-2 px-3 py-2 bg-slate-100 border border-slate-200 rounded-xl text-xs font-black uppercase text-slate-800">
              <UserIcon className="w-4 h-4 text-slate-500" />
              <span>{profile.fullName || 'OFFICER'} ({profile.designation || 'OFFICER'})</span>
            </div>
          )}
        </div>

        {/* Action Buttons: Save, Download, Print */}
        <div className="flex items-center gap-2 w-full sm:w-auto justify-end">
          {(() => {
            const selectedUser = users.find(u => u.uid === selectedUserId) || profile;
            if (selectedUser.role !== 'owner') {
              return (
                <button 
                  onClick={handleSave}
                  disabled={saving}
                  className="bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-2 rounded-xl text-xs font-black transition flex items-center gap-1.5 shadow-sm active:scale-95 disabled:opacity-50"
                  title="Save Target Sheet"
                >
                  {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                  <span>Save</span>
                </button>
              );
            }
            return null;
          })()}

          <button
            type="button"
            onClick={handleDownloadPdf}
            disabled={isGeneratingPdf}
            className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-xl text-xs font-black transition flex items-center gap-1.5 shadow-sm active:scale-95 disabled:opacity-50"
            title="Download A4 Sheet"
          >
            {isGeneratingPdf ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
            <span>{isGeneratingPdf ? 'Generating...' : 'Download'}</span>
          </button>

          <button
            type="button"
            onClick={() => window.print()}
            className="p-2 rounded-xl bg-red-600 hover:bg-red-700 text-white flex items-center shadow-sm transition active:scale-95"
            title="Print Target Sheet"
          >
            <Printer className="w-4 h-4" />
          </button>
        </div>
      </div>

      {showSuccess && (
        <div className="bg-emerald-50 border border-emerald-200 p-3 rounded-xl flex items-center justify-between text-emerald-800 text-xs font-bold animate-in fade-in no-print">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
            <span>Target sheet saved successfully!</span>
          </div>
          <button onClick={() => setShowSuccess(false)} className="text-emerald-700">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* ======================= UNIFIED PRINTABLE TARGET SHEET FORM ======================= */}
      <div className="bg-white rounded-2xl border-2 border-slate-300 shadow-xl overflow-x-auto print:border-none print:shadow-none print:m-0 print:p-0">
        <div ref={printableSheetRef} className="border-2 border-black bg-white shadow-sm min-w-[800px] sm:min-w-0">
          
          {/* 1. Header Section - Logo (Left) and Company Details (Center) */}
          <div className="p-4 relative bg-white border-b-2 border-black">
            <div className="flex items-center justify-between gap-4">
              {/* Logo */}
              <div className="w-20 h-20 flex items-center justify-center shrink-0">
                {logoUrl ? (
                  <img 
                    src={logoUrl} 
                    alt="Logo" 
                    style={{ width: `${logoSize}px`, height: `${logoSize}px` }} 
                    className="object-contain" 
                  />
                ) : (
                  <img 
                    src="/logo.jpg" 
                    alt="Logo" 
                    className="w-16 h-16 object-contain" 
                  />
                )}
              </div>

              {/* Company Info */}
              <div className="flex-1 text-center space-y-1">
                <h1 className="text-2xl font-black text-red-600 uppercase tracking-tight leading-none">
                  BLACKWORM AGRITECH PVT LTD
                </h1>
                <div className="text-[8px] text-slate-700 font-bold leading-tight mt-1">
                  <p>CIN : U01409PN2022PTC217246, GST No. 27AALCB3069J1ZC</p>
                  <p>Address - Gat No. 17 Vijaynagar (Mhaisal), Tal - Miraj, Dist - Sangli. 416409.</p>
                  <p className="flex items-center justify-center gap-4 mt-0.5">
                    <span className="flex items-center gap-1 text-red-600"><Phone className="w-2.5 h-2.5" /> +91 7798716201</span>
                    <span className="flex items-center gap-1 text-red-600 underline"><Mail className="w-2.5 h-2.5" /> blackwormagritechpvtltd@gmail.com</span>
                  </p>
                </div>
              </div>

              {/* Target Badge or User Photo */}
              <div className="w-20 h-20 flex flex-col items-center justify-center border-2 border-black bg-white shrink-0 overflow-hidden">
                {selectedUserPhoto ? (
                  <img src={selectedUserPhoto} alt="User" className="w-full h-full object-cover" />
                ) : (
                  <div className="flex flex-col items-center justify-center p-1 bg-red-50 w-full h-full">
                    <Target className="w-6 h-6 text-red-600 mb-0.5" />
                    <span className="text-[9px] font-black text-slate-900 leading-none text-center">ANNUAL TARGET</span>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* 2. Banner: Sales Target Sheet 2026-27 - Fitted strictly in a single line on all mobile screens */}
          <div className="bg-slate-900 text-white font-black px-2 py-2 flex items-center justify-center border-b-2 border-black">
            <span className="text-xs sm:text-sm md:text-base tracking-widest uppercase whitespace-nowrap text-center">
              SALES TARGET SHEET 2026-27
            </span>
          </div>

          {/* 3. Side-by-Side Metadata Section (3-Column Grid for better fit) */}
          <div className="grid grid-cols-3 divide-x-2 divide-black border-b-2 border-black bg-white text-[10px]">
            {/* Column 1: Basic Info */}
            <div className="divide-y-2 divide-black">
              <div className="flex items-center p-0 min-h-[40px] py-0.5">
                <span className="font-black text-black w-24 shrink-0 px-2 uppercase tracking-tighter">Officer -</span>
                <div className="flex-1 border-l-2 border-black min-h-[38px] flex items-center px-1">
                  <input disabled={isOwnerView} 
                    type="text" 
                    value={sheet.fullName} 
                    onChange={e => updateSheet({ fullName: e.target.value.toUpperCase() })} 
                    className="w-full bg-transparent font-black text-black uppercase focus:outline-none text-center" 
                  />
                </div>
              </div>

              <div className="flex items-center p-0 min-h-[40px] py-0.5">
                <span className="font-black text-black w-24 shrink-0 px-2 uppercase tracking-tighter">Designation -</span>
                <div className="flex-1 border-l-2 border-black min-h-[38px] flex items-center px-1">
                  <input disabled={isOwnerView} 
                    type="text" 
                    value={sheet.designation} 
                    onChange={e => updateSheet({ designation: e.target.value.toUpperCase() })} 
                    className="w-full bg-transparent font-black text-black uppercase focus:outline-none text-center text-[9px]" 
                  />
                </div>
              </div>

              <div className="flex items-center p-0 min-h-[40px] py-0.5">
                <span className="font-black text-black w-24 shrink-0 px-2 uppercase tracking-tighter">Center (HQ) -</span>
                <div className="flex-1 border-l-2 border-black min-h-[38px] flex items-center px-1">
                  <input disabled={isOwnerView} 
                    type="text" 
                    value={sheet.center} 
                    onChange={e => updateSheet({ center: e.target.value.toUpperCase() })} 
                    className="w-full bg-transparent font-black text-black uppercase focus:outline-none text-center" 
                  />
                </div>
              </div>
            </div>

            {/* Column 2: Sales Data */}
            <div className="divide-y-2 divide-black">
              <div className="flex items-center p-0 min-h-[40px] py-0.5">
                <span className="font-black text-black w-28 shrink-0 px-2 uppercase tracking-tighter">L.Y. Sale -</span>
                <div className="flex-1 border-l-2 border-black min-h-[38px] flex items-center justify-center px-1">
                  <input disabled={isOwnerView} 
                    type="number" 
                    value={sheet.lastYearSale || ''} 
                    onChange={e => updateSheet({ lastYearSale: Number(e.target.value) })} 
                    className="w-full bg-transparent font-black text-black focus:outline-none font-mono text-center" 
                  />
                  <span className="font-black text-black text-[8px] uppercase ml-0.5 shrink-0">Lakh</span>
                </div>
              </div>

              <div className="flex items-center p-0 min-h-[40px] py-0.5 bg-red-50/50">
                <span className="font-black text-red-600 w-28 shrink-0 px-2 uppercase tracking-tighter">Target -</span>
                <div className="flex-1 border-l-2 border-black min-h-[38px] flex items-center justify-center px-1">
                  <input disabled={isOwnerView} 
                    type="number" 
                    value={sheet.salesTarget || ''} 
                    onChange={e => updateSheet({ salesTarget: Number(e.target.value) })} 
                    className="w-full bg-transparent font-black text-red-600 focus:outline-none font-mono text-center" 
                  />
                  <span className="font-black text-red-600 text-[8px] uppercase ml-0.5 shrink-0">Lakh</span>
                </div>
              </div>

              <div className="flex items-center p-0 min-h-[40px] py-0.5">
                <span className="font-black text-black w-28 shrink-0 px-2 uppercase tracking-tighter">L.Y. Outstd -</span>
                <div className="flex-1 border-l-2 border-black min-h-[38px] flex items-center justify-center px-1">
                  <input disabled={isOwnerView} 
                    type="number" 
                    value={sheet.lastYearOutstanding || ''} 
                    onChange={e => updateSheet({ lastYearOutstanding: Number(e.target.value) })} 
                    className="w-full bg-transparent font-black text-black focus:outline-none font-mono text-center" 
                  />
                  <span className="font-black text-black text-[8px] uppercase ml-0.5 shrink-0">Lakh</span>
                </div>
              </div>
            </div>

            {/* Column 3: Collection Data & Calculations */}
            <div className="divide-y-2 divide-black">
              <div className="flex items-center p-0 min-h-[40px] py-0.5">
                <span className="font-black text-black w-28 shrink-0 px-2 uppercase tracking-tighter">L.Y. Coll. -</span>
                <div className="flex-1 border-l-2 border-black min-h-[38px] flex items-center justify-center px-1">
                  <input disabled={isOwnerView} 
                    type="number" 
                    value={sheet.lastYearCollection || ''} 
                    onChange={e => updateSheet({ lastYearCollection: Number(e.target.value) })} 
                    className="w-full bg-transparent font-black text-black focus:outline-none font-mono text-center" 
                  />
                  <span className="font-black text-black text-[8px] uppercase ml-0.5 shrink-0">Lakh</span>
                </div>
              </div>

              <div className="flex items-center p-0 min-h-[40px] py-0.5 bg-amber-50">
                <span className="font-black text-amber-900 w-28 shrink-0 px-2 uppercase tracking-tighter text-[9px]">Curr. L.Y. Outstd -</span>
                <div className="flex-1 border-l-2 border-black min-h-[38px] flex items-center justify-center px-1">
                  <span className="w-full font-black text-amber-900 font-mono text-center">
                    {(sheet.lastYearOutstanding - sheet.lastYearCollection).toFixed(2)}
                  </span>
                  <span className="font-black text-amber-900 text-[8px] uppercase ml-0.5 shrink-0">Lakh</span>
                </div>
              </div>

              <div className="flex items-center p-0 min-h-[40px] py-0.5 bg-blue-50">
                <span className="font-black text-blue-800 w-28 shrink-0 px-2 uppercase tracking-tighter">Coll. Target -</span>
                <div className="flex-1 border-l-2 border-black min-h-[38px] flex items-center justify-center px-1">
                  <input disabled={isOwnerView} 
                    type="number" 
                    value={sheet.collectionPercent || ''} 
                    onChange={e => updateSheet({ collectionPercent: Number(e.target.value) })} 
                    className="w-full bg-transparent font-black text-blue-800 focus:outline-none font-mono text-center" 
                  />
                  <span className="font-black text-blue-800 text-[8px] uppercase ml-0.5 shrink-0">%</span>
                </div>
              </div>
            </div>
          </div>

          {/* 4. Target Data Table */}
          <div className="overflow-x-auto bg-white">
            <table className="w-full text-left border-collapse text-[11px]">
              <thead>
                <tr className="bg-slate-900 text-white font-black uppercase text-center border-b-2 border-black">
                  <th className="p-2 border-r-2 border-black whitespace-nowrap w-12 text-center">Sr.</th>
                  <th className="p-2 border-r-2 border-black w-28 text-center">Month</th>
                  <th className="p-2 border-r-2 border-black text-center">Target (Lakh)</th>
                  <th className="p-2 border-r-2 border-black text-center">Achieve (Lakh)</th>
                  <th className="p-2 border-r-2 border-black text-center">% Ach.</th>
                  <th className="p-2 border-r-2 border-black text-center">Collection (Lakh)</th>
                  <th className="p-2 border-r-2 border-black text-center">Actual Coll.</th>
                  <th className="p-2 text-center">% Coll.</th>
                </tr>
              </thead>
              <tbody className="divide-y-2 divide-black text-black font-black">
                {sheet.months.map((m, idx) => {
                  const achPercent = (m.target || 0) > 0 ? ((m.achievement || 0) / m.target) * 100 : 0;
                  const collPercent = (m.collection || 0) > 0 ? ((m.actualCollection || 0) / m.collection) * 100 : 0;

                  return (
                    <React.Fragment key={m.month}>
                      <tr className="hover:bg-slate-50 transition-colors">
                        <td className="p-1.5 border-r-2 border-black text-center font-black text-black">{idx + 1}</td>
                        <td className="p-1.5 border-r-2 border-black font-black uppercase text-center">{m.month}</td>
                        <td className="p-1 border-r-2 border-black">
                          <input disabled={isOwnerView} 
                            type="number" 
                            value={m.target || ''} 
                            onChange={e => updateMonth(idx, { target: Number(e.target.value) })}
                            className="w-full px-2 py-1 bg-transparent border-none focus:outline-none focus:bg-amber-50 rounded text-center font-black font-mono"
                            placeholder="0.00"
                          />
                        </td>
                        <td className="p-1 border-r-2 border-black">
                          <input disabled={isOwnerView} 
                            type="number" 
                            value={m.achievement || ''} 
                            onChange={e => updateMonth(idx, { achievement: Number(e.target.value) })}
                            className="w-full px-2 py-1 bg-transparent border-none focus:outline-none focus:bg-blue-50 rounded text-center font-black font-mono text-blue-700"
                            placeholder="0.00"
                          />
                        </td>
                        <td className="p-1.5 border-r-2 border-black text-center font-black font-mono">{achPercent.toFixed(1)}%</td>
                        <td className="p-1 border-r-2 border-black">
                          <input disabled={isOwnerView} 
                            type="number" 
                            value={m.collection || ''} 
                            onChange={e => updateMonth(idx, { collection: Number(e.target.value) })}
                            className="w-full px-2 py-1 bg-transparent border-none focus:outline-none focus:bg-amber-50 rounded text-center font-black font-mono"
                            placeholder="0.00"
                          />
                        </td>
                        <td className="p-1 border-r-2 border-black">
                          <input disabled={isOwnerView} 
                            type="number" 
                            value={m.actualCollection || ''} 
                            onChange={e => updateMonth(idx, { actualCollection: Number(e.target.value) })}
                            className="w-full px-2 py-1 bg-transparent border-none focus:outline-none focus:bg-emerald-50 rounded text-center font-black font-mono text-emerald-700"
                            placeholder="0.00"
                          />
                        </td>
                        <td className="p-1.5 text-center font-black font-mono">{collPercent.toFixed(1)}%</td>
                      </tr>

                      {/* Render Quarter Subtotal Row */}
                      {(idx === 2 || idx === 5 || idx === 8 || idx === 11) && (
                        <tr className="bg-amber-200/90 font-black text-black border-y-2 border-black">
                          <td colSpan={2} className="p-2 border-r-2 border-black text-center uppercase tracking-wider font-black">
                            {idx === 2 ? 'Q1' : idx === 5 ? 'Q2' : idx === 8 ? 'Q3' : 'Q4'} TOTAL
                          </td>
                          {(() => {
                            const q = idx === 2 ? Q1 : idx === 5 ? Q2 : idx === 8 ? Q3 : Q4;
                            return (
                              <>
                                <td className="p-2 border-r-2 border-black text-center font-mono font-black">{q.target.toFixed(2)}</td>
                                <td className="p-2 border-r-2 border-black text-center font-mono text-blue-900 font-black">{q.achievement.toFixed(2)}</td>
                                <td className="p-2 border-r-2 border-black text-center font-mono font-black">{q.target > 0 ? ((q.achievement/q.target)*100).toFixed(1) : '0.0'}%</td>
                                <td className="p-2 border-r-2 border-black text-center font-mono font-black">{q.collection.toFixed(2)}</td>
                                <td className="p-2 border-r-2 border-black text-center font-mono text-emerald-900 font-black">{q.actual.toFixed(2)}</td>
                                <td className="p-2 text-center font-mono font-black">{q.collection > 0 ? ((q.actual/q.collection)*100).toFixed(1) : '0.0'}%</td>
                              </>
                            );
                          })()}
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}

                {/* Annual Grand Total Row */}
                <tr className="bg-red-600 text-white font-black text-xs uppercase border-t-2 border-black">
                  <td colSpan={2} className="p-2.5 text-center tracking-tight border-r-2 border-black font-black">
                    Grand Total 2026-27
                  </td>
                  <td className="p-2.5 text-center border-r-2 border-black font-mono font-black">{Total.target.toFixed(2)}</td>
                  <td className="p-2.5 text-center border-r-2 border-black font-mono font-black">{Total.achievement.toFixed(2)}</td>
                  <td className="p-2.5 text-center border-r-2 border-black font-mono font-black">{Total.target > 0 ? ((Total.achievement/Total.target)*100).toFixed(1) : '0.0'}%</td>
                  <td className="p-2.5 text-center border-r-2 border-black font-mono font-black">{Total.collection.toFixed(2)}</td>
                  <td className="p-2.5 text-center border-r-2 border-black font-mono font-black">{Total.actual.toFixed(2)}</td>
                  <td className="p-2.5 text-center font-mono font-black">{Total.collection > 0 ? ((Total.actual/Total.collection)*100).toFixed(1) : '0.0'}%</td>
                </tr>
              </tbody>
            </table>
          </div>

          {/* Footer Approval Space */}
          <div className="p-4 bg-white border-t-2 border-black flex justify-between items-end">
            <div className="text-center w-56">
              <div className="h-10"></div>
              <div className="border-t-2 border-black pt-1">
                <span className="font-black text-black uppercase text-[10px]">Officer Signature</span>
              </div>
            </div>

            <div className="text-center w-56">
              <div className="h-10"></div>
              <div className="border-t-2 border-black pt-1">
                <span className="font-black text-black uppercase text-[10px]">Authorized Signatory</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
