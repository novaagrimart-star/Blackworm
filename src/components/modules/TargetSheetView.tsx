import React, { useState, useEffect, useRef } from 'react';
import { 
  collection, 
  query, 
  onSnapshot, 
  doc, 
  setDoc
} from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../../firebase';
import { UserProfile, isAdmin } from '../../lib/auth';
import { logAudit } from '../../lib/dataService';
import { Language } from '../../lib/i18n';
import { cn } from '../../lib/utils';
import { 
  toDecimal2, 
  addDecimal2, 
  subtractDecimal2, 
  multiplyDecimal2, 
  formatAmount, 
  calcPercent 
} from '../../lib/decimal';
import jsPDF from 'jspdf';
import html2canvas from 'html2canvas-pro';
import { 
  Target, 
  ChevronDown,
  Save,
  CheckCircle2,
  Download,
  Loader2,
  Phone,
  Mail
} from 'lucide-react';

export const formatTitleCase = (str: string | undefined | null): string => {
  if (!str) return '';
  return str
    .toLowerCase()
    .split(' ')
    .filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
};

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

/**
 * High-precision editable financial cell component.
 * Displays formatted 2-decimal numbers (e.g. "13.37", "7.24", "0.00").
 * Prevents floating point errors, input jumping, and browser-specific number artifacts.
 */
const CellInput: React.FC<{
  value: number;
  disabled?: boolean;
  isPdfOrPrint?: boolean;
  onChange: (val: number) => void;
  className?: string;
  placeholder?: string;
  colorClass?: string;
}> = ({ value, disabled, isPdfOrPrint, onChange, className, placeholder = "0.00", colorClass = "text-black" }) => {
  const [isEditing, setIsEditing] = useState(false);
  const [text, setText] = useState('');

  useEffect(() => {
    if (!isEditing) {
      setText(formatAmount(value));
    }
  }, [value, isEditing]);

  if (disabled || isPdfOrPrint) {
    return (
      <span className={cn("inline-block w-full text-center font-black font-mono text-xs sm:text-[13px] select-text tracking-tight", colorClass)}>
        {formatAmount(value)}
      </span>
    );
  }

  return (
    <input
      type="text"
      inputMode="decimal"
      value={isEditing ? text : formatAmount(value)}
      onFocus={() => {
        setIsEditing(true);
        setText(value === 0 ? '' : String(value));
      }}
      onChange={(e) => {
        const val = e.target.value;
        // Accept valid positive decimal patterns
        if (/^\d*\.?\d*$/.test(val)) {
          setText(val);
        }
      }}
      onBlur={() => {
        setIsEditing(false);
        const parsed = toDecimal2(text);
        onChange(parsed);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          (e.target as HTMLInputElement).blur();
        }
      }}
      placeholder={placeholder}
      className={cn(
        "w-full px-1 py-1 bg-transparent border-none focus:outline-none focus:bg-amber-100/70 rounded text-center font-black font-mono text-xs sm:text-[13px] tracking-tight transition-colors",
        colorClass,
        className
      )}
    />
  );
};

export const TargetSheetView: React.FC<Props> = ({ profile }) => {
  const userIsAdmin = isAdmin(profile);
  const [users, setUsers] = useState<UserProfile[]>([]);
  const [selectedUserId, setSelectedUserId] = useState<string>(profile.uid);
  const [sheet, setYearlySheet] = useState<YearlySheet | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);
  const [isGeneratingPdf, setIsGeneratingPdf] = useState(false);
  const [isUserDropdownOpen, setIsUserDropdownOpen] = useState(false);

  // If not admin, lock selectedUserId to logged-in user profile
  useEffect(() => {
    if (!userIsAdmin) {
      setSelectedUserId(profile.uid);
    }
  }, [userIsAdmin, profile.uid]);

  // Branding
  const [logoUrl, setLogoUrl] = useState<string>('');
  const [logoSize, setLogoSize] = useState<number>(80);

  const printableSheetRef = useRef<HTMLDivElement>(null);

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
    }, (err) => {
      console.warn('TargetSheet branding sync notice:', err);
    });
    return () => unsubBranding();
  }, []);

  // Fetch users for dropdown
  useEffect(() => {
    const q = query(collection(db, 'users'));
    const unsub = onSnapshot(q, (snap) => {
      const list: UserProfile[] = [];
      snap.forEach(d => list.push({ ...d.data(), uid: d.id } as UserProfile));
      list.sort((a, b) => (a.fullName || '').localeCompare(b.fullName || ''));
      setUsers(list);
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, 'users');
    });
    return () => unsub();
  }, []);

  // Fetch or init sheet for selected user
  useEffect(() => {
    setLoading(true);
    const selectedUser = users.find(u => u.uid === selectedUserId) || profile;
    const isOwner = selectedUser.role === 'owner';

    if (isOwner) {
      // Aggregation logic for owner - strictly decimal/cents precision
      const q = query(collection(db, 'yearly_targets'));
      const unsub = onSnapshot(q, (snap) => {
        const allSheets: YearlySheet[] = [];
        snap.forEach(d => {
          const data = d.data() as YearlySheet;
          const sheetUser = users.find(u => u.uid === data.userId);
          if (sheetUser && sheetUser.role !== 'owner') {
            allSheets.push(data);
          }
        });

        // Exact financial addition without floating point inaccuracies
        const consolidatedSheet: YearlySheet = {
          id: `consolidated_owner_${selectedUserId}`,
          userId: selectedUserId,
          fullName: selectedUser.fullName || selectedUser.uid,
          designation: 'CONSOLIDATED (TOTAL)',
          center: 'ALL CENTERS',
          year: '2026-27',
          lastYearSale: addDecimal2(...allSheets.map(s => s.lastYearSale)),
          lastYearCollection: addDecimal2(...allSheets.map(s => s.lastYearCollection)),
          salesTarget: addDecimal2(...allSheets.map(s => s.salesTarget)),
          lastYearOutstanding: addDecimal2(...allSheets.map(s => s.lastYearOutstanding)),
          collectionPercent: 0,
          months: monthsList.map(mName => {
            let t = 0;
            let a = 0;
            let c = 0;
            let ac = 0;
            allSheets.forEach(s => {
              const sm = s.months?.find(month => month.month === mName);
              if (sm) {
                t = addDecimal2(t, sm.target);
                a = addDecimal2(a, sm.achievement);
                c = addDecimal2(c, sm.collection);
                ac = addDecimal2(ac, sm.actualCollection);
              }
            });
            return {
              month: mName,
              target: t,
              achievement: a,
              collection: c,
              actualCollection: ac
            };
          })
        };
        setYearlySheet(consolidatedSheet);
        setLoading(false);
      }, (error) => {
        handleFirestoreError(error, OperationType.LIST, 'yearly_targets');
      });
      return () => unsub();
    } else {
      // Regular fetching for individual users
      const sheetId = `yearly_${selectedUserId}_2026_27`;
      const unsub = onSnapshot(doc(db, 'yearly_targets', sheetId), (docSnap) => {
        if (docSnap.exists()) {
          const data = docSnap.data() as YearlySheet;
          // Normalize and clean all numbers to 2 decimal places using toDecimal2
          if (data.months) {
            const perc = Number(data.collectionPercent) || 0;
            data.months = data.months.map(m => {
              const target = toDecimal2(m.target);
              const achievement = toDecimal2(m.achievement);
              const collection = perc > 0 ? multiplyDecimal2(target > 0 ? target : achievement, perc) : toDecimal2(m.collection);
              return {
                ...m,
                target,
                achievement,
                collection,
                actualCollection: toDecimal2(m.actualCollection),
              };
            });
          }
          data.lastYearSale = toDecimal2(data.lastYearSale);
          data.lastYearCollection = toDecimal2(data.lastYearCollection);
          data.salesTarget = toDecimal2(data.salesTarget);
          data.lastYearOutstanding = toDecimal2(data.lastYearOutstanding);
          data.collectionPercent = Number(data.collectionPercent) || 0;
          // Synchronize from authoritative users collection
          data.fullName = selectedUser.fullName || data.fullName || selectedUser.uid;
          data.designation = selectedUser.designation || data.designation || 'FIELD OFFICER';
          data.center = selectedUser.center || data.center || '';
          setYearlySheet(data);
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
      }, (error) => {
        handleFirestoreError(error, OperationType.GET, `yearly_targets/${sheetId}`);
      });
      return () => unsub();
    }
  }, [selectedUserId, users, profile]);

  const updateSheet = (updates: Partial<YearlySheet>) => {
    if (!sheet) return;
    const selectedUser = users.find(u => u.uid === selectedUserId) || profile;
    if (selectedUser.role === 'owner') return;

    let newSheet = { ...sheet, ...updates };

    if (updates.hasOwnProperty('lastYearSale')) newSheet.lastYearSale = toDecimal2(updates.lastYearSale);
    if (updates.hasOwnProperty('salesTarget')) newSheet.salesTarget = toDecimal2(updates.salesTarget);
    if (updates.hasOwnProperty('lastYearOutstanding')) newSheet.lastYearOutstanding = toDecimal2(updates.lastYearOutstanding);
    if (updates.hasOwnProperty('lastYearCollection')) newSheet.lastYearCollection = toDecimal2(updates.lastYearCollection);

    // If collectionPercent updated, auto-update all months' collection in lakh using exact decimal arithmetic
    if (updates.hasOwnProperty('collectionPercent')) {
      const perc = Number(updates.collectionPercent) || 0;
      newSheet.collectionPercent = perc;
      newSheet.months = newSheet.months.map(m => ({
        ...m,
        collection: multiplyDecimal2(m.target > 0 ? m.target : m.achievement, perc)
      }));
    }
    
    setYearlySheet(newSheet);
  };

  const updateMonth = (index: number, updates: Partial<MonthlyData>) => {
    if (!sheet) return;
    const selectedUser = users.find(u => u.uid === selectedUserId) || profile;
    if (selectedUser.role === 'owner') return;

    const newMonths = [...sheet.months];
    let monthUpdate = { ...newMonths[index], ...updates };
    
    // Target update: automatically updates Collection in Lakh based on collection percentage
    if (updates.hasOwnProperty('target')) {
      const tgt = toDecimal2(updates.target);
      monthUpdate.target = tgt;
      const perc = sheet.collectionPercent || 0;
      monthUpdate.collection = multiplyDecimal2(tgt > 0 ? tgt : monthUpdate.achievement, perc);
    }
    // If achievement updated and target is 0, recalculate collection target
    if (updates.hasOwnProperty('achievement')) {
      const ach = toDecimal2(updates.achievement);
      monthUpdate.achievement = ach;
      const perc = sheet.collectionPercent || 0;
      if (!monthUpdate.target || monthUpdate.target === 0) {
        monthUpdate.collection = multiplyDecimal2(ach, perc);
      }
    }
    // Actual Collection remains manually editable per requirement
    if (updates.hasOwnProperty('actualCollection')) {
      monthUpdate.actualCollection = toDecimal2(updates.actualCollection);
    }
    
    newMonths[index] = monthUpdate;
    setYearlySheet({ ...sheet, months: newMonths });
  };

  const handleSave = async () => {
    if (!sheet) return;
    setSaving(true);
    try {
      // Ensure all numbers in sheet are clean decimal 2 numbers before persisting
      const cleanedSheet: YearlySheet = {
        ...sheet,
        fullName: selectedUser.fullName || sheet.fullName || selectedUser.uid,
        designation: selectedUser.designation || sheet.designation || 'FIELD OFFICER',
        center: selectedUser.center || sheet.center || '',
        lastYearSale: toDecimal2(sheet.lastYearSale),
        lastYearCollection: toDecimal2(sheet.lastYearCollection),
        salesTarget: toDecimal2(sheet.salesTarget),
        lastYearOutstanding: toDecimal2(sheet.lastYearOutstanding),
        collectionPercent: Math.round(Number(sheet.collectionPercent) || 0),
        months: sheet.months.map(m => ({
          ...m,
          target: toDecimal2(m.target),
          achievement: toDecimal2(m.achievement),
          collection: toDecimal2(m.collection),
          actualCollection: toDecimal2(m.actualCollection),
        }))
      };

      await setDoc(doc(db, 'yearly_targets', sheet.id), {
        ...cleanedSheet,
        updatedAt: new Date().toISOString()
      }, { merge: true });
      await logAudit('UPDATE', 'yearly_targets', sheet.id, `Updated yearly target sheet for ${sheet.fullName}`, profile);
      setYearlySheet(cleanedSheet);
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
      // Wait a moment for React to render clean static spans instead of inputs
      await new Promise(r => setTimeout(r, 100));

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
    const qMonths = mIndexes.map(i => sheet.months[i] || { target: 0, achievement: 0, collection: 0, actualCollection: 0 });
    const target = addDecimal2(...qMonths.map(m => m.target));
    const achievement = addDecimal2(...qMonths.map(m => m.achievement));
    const collection = addDecimal2(...qMonths.map(m => m.collection));
    const actual = addDecimal2(...qMonths.map(m => m.actualCollection));
    return { target, achievement, collection, actual };
  };

  const Q1 = calculateQuarter([0, 1, 2]);
  const Q2 = calculateQuarter([3, 4, 5]);
  const Q3 = calculateQuarter([6, 7, 8]);
  const Q4 = calculateQuarter([9, 10, 11]);
  const Total = {
    target: addDecimal2(Q1.target, Q2.target, Q3.target, Q4.target),
    achievement: addDecimal2(Q1.achievement, Q2.achievement, Q3.achievement, Q4.achievement),
    collection: addDecimal2(Q1.collection, Q2.collection, Q3.collection, Q4.collection),
    actual: addDecimal2(Q1.actual, Q2.actual, Q3.actual, Q4.actual)
  };

  const selectedUser = users.find(u => u.uid === selectedUserId) || profile;
  const isOwnerView = selectedUser.role === 'owner';

  return (
    <div className="space-y-4 font-sans pb-12">
      {/* Top Action Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3 bg-white p-4 rounded-xl border border-slate-200 shadow-sm print:hidden">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-red-50 text-red-600 rounded-lg">
            <Target className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-base font-bold text-slate-800">Target & Collection Sheet 2026-27</h2>
            <p className="text-xs text-slate-500">Yearly Target Sheet</p>
          </div>
        </div>

        {/* User Selection & Actions */}
        <div className="flex flex-wrap items-center gap-2">
          {userIsAdmin && (
            <div className="relative min-w-[210px] sm:min-w-[260px]">
              <button
                type="button"
                onClick={() => setIsUserDropdownOpen(!isUserDropdownOpen)}
                className="w-full bg-slate-50 border border-slate-300 text-slate-800 py-1 px-2.5 rounded-lg text-left flex items-center justify-between gap-1.5 cursor-pointer hover:bg-slate-100 transition shadow-2xs"
              >
                <div className="min-w-0 flex-1 flex items-baseline gap-1.5 truncate">
                  <span className="text-xs font-black text-slate-900 truncate">
                    {formatTitleCase(selectedUser.fullName || selectedUser.uid)}
                  </span>
                  {selectedUser.role === 'owner' ? (
                    <span className="text-[10px] font-bold text-red-600 uppercase shrink-0">
                      (Total)
                    </span>
                  ) : null}
                </div>
                <ChevronDown className="w-3.5 h-3.5 text-slate-400 shrink-0" />
              </button>

              {isUserDropdownOpen && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setIsUserDropdownOpen(false)} />
                  <div className="absolute left-0 mt-1 w-full sm:w-80 bg-white border border-slate-200 rounded-xl shadow-xl z-50 max-h-60 overflow-y-auto p-1 divide-y divide-slate-100">
                    {users.map((u) => (
                      <div
                        key={u.uid}
                        onClick={() => {
                          setSelectedUserId(u.uid);
                          setIsUserDropdownOpen(false);
                        }}
                        className={cn(
                          "p-2 px-2.5 rounded-lg cursor-pointer transition flex items-center justify-between gap-2 whitespace-nowrap",
                          selectedUserId === u.uid ? "bg-red-50 text-red-900 font-black" : "hover:bg-slate-50 text-slate-800 font-bold"
                        )}
                      >
                        <span className="text-xs truncate">
                          {formatTitleCase(u.fullName || u.uid)}
                        </span>
                        {u.role === 'owner' && (
                          <span className="text-[10px] font-black text-red-600 uppercase shrink-0 bg-red-100 px-1.5 py-0.5 rounded">
                            Owner (Total)
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}

          {!isOwnerView && (
            <button
              onClick={handleSave}
              disabled={saving}
              className="flex items-center gap-1 px-2 py-0.5 bg-red-600 hover:bg-red-700 text-white rounded text-[10px] font-bold transition shadow-2xs disabled:opacity-50 cursor-pointer active:scale-95"
            >
              {saving ? <Loader2 className="w-2.5 h-2.5 animate-spin" /> : <Save className="w-2.5 h-2.5" />}
              <span>{saving ? 'Saving...' : 'Save Changes'}</span>
            </button>
          )}

          <button
            onClick={handleDownloadPdf}
            disabled={isGeneratingPdf}
            className="flex items-center gap-1 px-2 py-0.5 bg-slate-800 hover:bg-slate-900 text-white rounded text-[10px] font-bold transition shadow-2xs disabled:opacity-50 cursor-pointer active:scale-95"
            title="Download PDF"
          >
            {isGeneratingPdf ? <Loader2 className="w-2.5 h-2.5 animate-spin" /> : <Download className="w-2.5 h-2.5" />}
            <span>PDF</span>
          </button>
        </div>
      </div>

      {showSuccess && (
        <div className="flex items-center gap-2 p-3 bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs rounded-xl shadow-sm animate-fade-in print:hidden">
          <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
          <span className="font-semibold">Target Sheet successfully updated and saved to server!</span>
        </div>
      )}

      {/* Main Printable Document Layout */}
      <div className="overflow-x-auto p-1 sm:p-2 bg-slate-100 rounded-xl">
        <div 
          ref={printableSheetRef}
          className="min-w-[840px] max-w-[940px] mx-auto bg-white p-5 sm:p-6 shadow-md border-2 border-black font-sans text-black relative"
          style={{ minHeight: '1080px' }}
        >
          {/* 1. Header with Company Logo & Details */}
          <div className="flex items-center justify-between border-b-2 border-black pb-3">
            <div className="flex items-center gap-3">
              {logoUrl ? (
                <img 
                  src={logoUrl} 
                  alt="Company Logo" 
                  style={{ width: `${logoSize}px`, height: 'auto' }}
                  className="object-contain max-h-24"
                />
              ) : (
                <div className="w-16 h-16 bg-red-600 text-white flex items-center justify-center font-black text-xl rounded-lg shadow-sm">
                  BW
                </div>
              )}
              <div>
                <h1 className="text-xl sm:text-2xl font-black text-red-600 tracking-tight leading-none uppercase">
                  BLACKWORM AGRITECH PVT LTD
                </h1>
                <div className="text-[8px] sm:text-[8.5px] font-bold text-slate-800 leading-tight mt-1 space-y-0.5">
                  <p>CIN: U01409PN2022PTC217246, GST No.: 27AALCB3069J1ZC</p>
                  <p>Address: Gat No. 17, Vijaynagar (Mhaisal), Tal. Miraj, Dist. Sangli – 416409</p>
                  <p className="flex items-center gap-4 mt-0.5">
                    <span className="flex items-center gap-1 text-red-600 font-bold"><Phone className="w-2.5 h-2.5" /> +91 7798716201</span>
                    <span className="flex items-center gap-1 text-red-600 font-bold underline"><Mail className="w-2.5 h-2.5" /> blackwormagritechpvtltd@gmail.com</span>
                  </p>
                </div>
              </div>
            </div>

            <div className="text-right">
              <span className="inline-block border-2 border-black px-2.5 py-1 text-xs font-black uppercase tracking-wider bg-slate-50">
                FY 2026-27
              </span>
              <p className="text-[9px] font-black text-black mt-1 uppercase">Doc Ref: BW/TS/26-27</p>
            </div>
          </div>

          {/* 2. Document Title Banner */}
          <div className="text-center py-2 border-b-2 border-black bg-amber-400">
            <h2 className="text-base sm:text-lg font-black uppercase tracking-wider text-slate-950">
              Target & Collection Sheet 2026-27
            </h2>
          </div>

          {/* 3. Officer Profile & Top Statistics Grid */}
          <div className="grid grid-cols-3 border-b-2 border-black divide-x-2 divide-black text-xs">
            {/* Column 1: Officer Information - Designation removed, names on single line in Title Case */}
            <div className="divide-y-2 divide-black">
              <div className="flex items-center p-0 min-h-[40px] py-0.5">
                <span className="font-black text-black w-24 shrink-0 px-2 tracking-tight whitespace-nowrap">
                  {isOwnerView ? 'Owner -' : 'Officer -'}
                </span>
                <div className="flex-1 border-l-2 border-black min-h-[38px] flex items-center px-1">
                  <span className="w-full font-black text-black text-center block text-xs sm:text-[13px] whitespace-nowrap overflow-hidden text-ellipsis">
                    {formatTitleCase(selectedUser.fullName || sheet.fullName)}
                  </span>
                </div>
              </div>

              <div className="flex items-center p-0 min-h-[40px] py-0.5">
                <span className="font-black text-black w-24 shrink-0 px-2 tracking-tight whitespace-nowrap">Center (HQ) -</span>
                <div className="flex-1 border-l-2 border-black min-h-[38px] flex items-center px-1">
                  <span className="w-full font-black text-black text-center block text-xs sm:text-[13px] whitespace-nowrap overflow-hidden text-ellipsis">
                    {isOwnerView ? 'All Centers' : (selectedUser.center || sheet.center || '-')}
                  </span>
                </div>
              </div>

              <div className="flex items-center p-0 min-h-[40px] py-0.5">
                <span className="font-black text-black w-24 shrink-0 px-2 tracking-tight whitespace-nowrap">Year -</span>
                <div className="flex-1 border-l-2 border-black min-h-[38px] flex items-center px-1">
                  <span className="w-full font-black text-black text-center block text-xs sm:text-[13px] whitespace-nowrap">
                    2026-27
                  </span>
                </div>
              </div>
            </div>

            {/* Column 2: Sales Data */}
            <div className="divide-y-2 divide-black">
              <div className="flex items-center p-0 min-h-[40px] py-0.5">
                <span className="font-black text-black w-28 shrink-0 px-2 tracking-tight whitespace-nowrap">L.Y. Sale -</span>
                <div className="flex-1 border-l-2 border-black min-h-[38px] flex items-center justify-center px-1">
                  <CellInput
                    value={sheet.lastYearSale}
                    disabled={isOwnerView}
                    isPdfOrPrint={isGeneratingPdf}
                    onChange={v => updateSheet({ lastYearSale: v })}
                    colorClass="text-black"
                  />
                  <span className="font-black text-black text-[8px] uppercase ml-0.5 shrink-0">Lakh</span>
                </div>
              </div>

              <div className="flex items-center p-0 min-h-[40px] py-0.5 bg-red-50/50">
                <span className="font-black text-red-600 w-28 shrink-0 px-2 tracking-tight whitespace-nowrap">Target -</span>
                <div className="flex-1 border-l-2 border-black min-h-[38px] flex items-center justify-center px-1">
                  <CellInput
                    value={sheet.salesTarget}
                    disabled={isOwnerView}
                    isPdfOrPrint={isGeneratingPdf}
                    onChange={v => updateSheet({ salesTarget: v })}
                    colorClass="text-red-600"
                  />
                  <span className="font-black text-red-600 text-[8px] uppercase ml-0.5 shrink-0">Lakh</span>
                </div>
              </div>

              <div className="flex items-center p-0 min-h-[40px] py-0.5">
                <span className="font-black text-black w-28 shrink-0 px-2 tracking-tight whitespace-nowrap">L.Y. Outstd -</span>
                <div className="flex-1 border-l-2 border-black min-h-[38px] flex items-center justify-center px-1">
                  <CellInput
                    value={sheet.lastYearOutstanding}
                    disabled={isOwnerView}
                    isPdfOrPrint={isGeneratingPdf}
                    onChange={v => updateSheet({ lastYearOutstanding: v })}
                    colorClass="text-black"
                  />
                  <span className="font-black text-black text-[8px] uppercase ml-0.5 shrink-0">Lakh</span>
                </div>
              </div>
            </div>

            {/* Column 3: Collection Data & Calculations */}
            <div className="divide-y-2 divide-black">
              <div className="flex items-center p-0 min-h-[40px] py-0.5">
                <span className="font-black text-black w-28 shrink-0 px-2 tracking-tight whitespace-nowrap">L.Y. Coll. -</span>
                <div className="flex-1 border-l-2 border-black min-h-[38px] flex items-center justify-center px-1">
                  <CellInput
                    value={sheet.lastYearCollection}
                    disabled={isOwnerView}
                    isPdfOrPrint={isGeneratingPdf}
                    onChange={v => updateSheet({ lastYearCollection: v })}
                    colorClass="text-black"
                  />
                  <span className="font-black text-black text-[8px] uppercase ml-0.5 shrink-0">Lakh</span>
                </div>
              </div>

              <div className="flex items-center p-0 min-h-[40px] py-0.5 bg-amber-50">
                <span className="font-black text-amber-950 w-28 shrink-0 px-2 tracking-tight whitespace-nowrap text-[9.5px]">Curr. Outstd -</span>
                <div className="flex-1 border-l-2 border-black min-h-[38px] flex items-center justify-center px-1">
                  <span className="w-full font-black text-amber-950 font-mono text-center">
                    {formatAmount(subtractDecimal2(sheet.lastYearOutstanding, sheet.lastYearCollection))}
                  </span>
                  <span className="font-black text-amber-950 text-[8px] uppercase ml-0.5 shrink-0">Lakh</span>
                </div>
              </div>

              <div className="flex items-center p-0 min-h-[40px] py-0.5 bg-blue-50/80">
                <span className="font-black text-blue-900 w-28 shrink-0 px-2 tracking-tight whitespace-nowrap">Coll. Target -</span>
                <div className="flex-1 border-l-2 border-black min-h-[38px] flex items-center justify-center px-1">
                  {isOwnerView || isGeneratingPdf ? (
                    <span className="w-full font-black text-blue-900 font-mono text-center">
                      {sheet.collectionPercent || 0}%
                    </span>
                  ) : (
                    <input 
                      type="text" 
                      inputMode="decimal"
                      value={sheet.collectionPercent === 0 ? '' : sheet.collectionPercent} 
                      onChange={e => {
                        const val = e.target.value;
                        if (/^\d*\.?\d*$/.test(val)) {
                          updateSheet({ collectionPercent: val === '' ? 0 : Number(val) || 0 });
                        }
                      }} 
                      placeholder="0"
                      className="w-full bg-transparent font-black text-blue-900 focus:outline-none font-mono text-center" 
                    />
                  )}
                  <span className="font-black text-blue-900 text-[8px] uppercase ml-0.5 shrink-0">%</span>
                </div>
              </div>
            </div>
          </div>

          {/* 4. Target Data Table */}
          <div className="overflow-x-auto bg-white">
            <table className="w-full text-left border-collapse text-xs sm:text-[13px]">
              <thead>
                <tr className="bg-slate-900 text-white font-black uppercase text-center border-b-2 border-black text-xs sm:text-[12.5px]">
                  <th className="p-2 border-r-2 border-black whitespace-nowrap w-12 text-center">Sr.</th>
                  <th className="p-2 border-r-2 border-black whitespace-nowrap w-28 text-center">Month</th>
                  <th className="p-2 border-r-2 border-black whitespace-nowrap text-center">Target (Lakh)</th>
                  <th className="p-2 border-r-2 border-black whitespace-nowrap text-center">Achieve (Lakh)</th>
                  <th className="p-2 border-r-2 border-black whitespace-nowrap text-center">% Ach.</th>
                  <th className="p-2 border-r-2 border-black whitespace-nowrap text-center">Collection (Lakh)</th>
                  <th className="p-2 border-r-2 border-black whitespace-nowrap text-center">Actual Coll.</th>
                  <th className="p-2 whitespace-nowrap text-center">% Coll.</th>
                </tr>
              </thead>
              <tbody className="divide-y-2 divide-black text-black font-black">
                {sheet.months.map((m, idx) => {
                  const achPercentStr = calcPercent(m.achievement, m.target);
                  const collPercentStr = calcPercent(m.actualCollection, m.collection);
                  return (
                    <React.Fragment key={m.month}>
                      <tr className="hover:bg-slate-50 transition-colors">
                        <td className="p-1.5 border-r-2 border-black text-center font-black text-black text-xs sm:text-[13px]">{idx + 1}</td>
                        <td className="p-1.5 border-r-2 border-black font-black uppercase text-center text-xs sm:text-[13px] whitespace-nowrap">{m.month}</td>
                        <td className="p-1 border-r-2 border-black">
                          <CellInput
                            value={m.target}
                            disabled={isOwnerView}
                            isPdfOrPrint={isGeneratingPdf}
                            onChange={v => updateMonth(idx, { target: v })}
                            colorClass="text-black"
                          />
                        </td>
                        <td className="p-1 border-r-2 border-black">
                          <CellInput
                            value={m.achievement}
                            disabled={isOwnerView}
                            isPdfOrPrint={isGeneratingPdf}
                            onChange={v => updateMonth(idx, { achievement: v })}
                            colorClass="text-blue-800"
                          />
                        </td>
                        <td className="p-1.5 border-r-2 border-black text-center font-black font-mono text-xs sm:text-[13px] text-slate-900">{achPercentStr}</td>
                        {/* Collection in Lakh: strictly auto-calculated based on Target & Percentage, non-editable */}
                        <td className="p-1.5 border-r-2 border-black text-center font-mono font-black text-xs sm:text-[13px] text-slate-950 bg-slate-50/60">
                          {formatAmount(m.collection)}
                        </td>
                        {/* Actual Collection: remains editable */}
                        <td className="p-1 border-r-2 border-black">
                          <CellInput
                            value={m.actualCollection}
                            disabled={isOwnerView}
                            isPdfOrPrint={isGeneratingPdf}
                            onChange={v => updateMonth(idx, { actualCollection: v })}
                            colorClass="text-emerald-800"
                          />
                        </td>
                        <td className="p-1.5 text-center font-black font-mono text-xs sm:text-[13px] text-slate-900">{collPercentStr}</td>
                      </tr>
                      {/* Render Quarter Subtotal Row */}
                      {(idx === 2 || idx === 5 || idx === 8 || idx === 11) && (
                        <tr className="bg-amber-100 font-black text-slate-950 border-y-2 border-black text-xs sm:text-[13px]">
                          <td colSpan={2} className="p-2 border-r-2 border-black text-center uppercase tracking-wider font-black whitespace-nowrap">
                            {idx === 2 ? 'Q1' : idx === 5 ? 'Q2' : idx === 8 ? 'Q3' : 'Q4'} TOTAL
                          </td>
                          {(() => {
                            const q = idx === 2 ? Q1 : idx === 5 ? Q2 : idx === 8 ? Q3 : Q4;
                            return (
                              <>
                                <td className="p-2 border-r-2 border-black text-center font-mono font-black text-xs sm:text-[13px]">{formatAmount(q.target)}</td>
                                <td className="p-2 border-r-2 border-black text-center font-mono text-blue-950 font-black text-xs sm:text-[13px]">{formatAmount(q.achievement)}</td>
                                <td className="p-2 border-r-2 border-black text-center font-mono font-black text-xs sm:text-[13px]">{calcPercent(q.achievement, q.target)}</td>
                                <td className="p-2 border-r-2 border-black text-center font-mono font-black text-xs sm:text-[13px]">{formatAmount(q.collection)}</td>
                                <td className="p-2 border-r-2 border-black text-center font-mono text-emerald-950 font-black text-xs sm:text-[13px]">{formatAmount(q.actual)}</td>
                                <td className="p-2 text-center font-mono font-black text-xs sm:text-[13px]">{calcPercent(q.actual, q.collection)}</td>
                              </>
                            );
                          })()}
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
                {/* Annual Grand Total Row */}
                <tr className="bg-red-600 text-white font-black text-xs sm:text-sm uppercase border-t-2 border-black">
                  <td colSpan={2} className="p-2.5 text-center tracking-tight border-r-2 border-black font-black">
                    Grand Total 2026-27
                  </td>
                  <td className="p-2.5 text-center border-r-2 border-black font-mono font-black text-xs sm:text-sm">{formatAmount(Total.target)}</td>
                  <td className="p-2.5 text-center border-r-2 border-black font-mono font-black text-xs sm:text-sm">{formatAmount(Total.achievement)}</td>
                  <td className="p-2.5 text-center border-r-2 border-black font-mono font-black text-xs sm:text-sm">{calcPercent(Total.achievement, Total.target)}</td>
                  <td className="p-2.5 text-center border-r-2 border-black font-mono font-black text-xs sm:text-sm">{formatAmount(Total.collection)}</td>
                  <td className="p-2.5 text-center border-r-2 border-black font-mono font-black text-xs sm:text-sm">{formatAmount(Total.actual)}</td>
                  <td className="p-2.5 text-center font-mono font-black text-xs sm:text-sm">{calcPercent(Total.actual, Total.collection)}</td>
                </tr>
              </tbody>
            </table>
          </div>

          {/* Footer Approval Space */}
          <div className="grid grid-cols-2 border-t-2 border-black mt-8 pt-6 pb-2 text-xs font-black uppercase">
            <div className="text-center space-y-8">
              <p>Officer Signature</p>
              <div className="border-t border-dashed border-black w-48 mx-auto" />
            </div>
            <div className="text-center space-y-8">
              <p>Managing Director / Owner</p>
              <div className="border-t border-dashed border-black w-48 mx-auto" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
