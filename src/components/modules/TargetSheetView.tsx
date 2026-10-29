import React, { useState, useEffect, useRef } from 'react';
import { 
  collection, 
  query, 
  onSnapshot, 
  doc, 
  setDoc,
  getDoc
} from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../../firebase';
import { UserProfile, isAdmin } from '../../lib/auth';
import { logAudit } from '../../lib/dataService';
import { Language } from '../../lib/i18n';
import { cn } from '../../lib/utils';
import { useBranding } from '../../lib/branding';
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
  Mail,
  RefreshCw,
  X,
  User as UserIcon
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
}> = ({ value, disabled, isPdfOrPrint, onChange, className, placeholder = "0.00", colorClass = "text-slate-900" }) => {
  const [isEditing, setIsEditing] = useState(false);
  const [text, setText] = useState('');

  useEffect(() => {
    if (!isEditing) {
      setText(formatAmount(value));
    }
  }, [value, isEditing]);

  if (disabled || isPdfOrPrint) {
    return (
      <span className={cn("inline-block w-full text-center font-bold font-mono text-xs sm:text-[13px] select-text tracking-tight", colorClass)}>
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
        "w-full px-1 py-1 bg-transparent border-none focus:outline-none focus:bg-blue-50/80 rounded text-center font-bold font-mono text-xs sm:text-[13px] tracking-tight transition-colors",
        colorClass,
        className
      )}
    />
  );
};

export const TargetSheetView: React.FC<Props> = ({ profile }) => {
  const userIsAdmin = isAdmin(profile);
  const [users, setUsers] = useState<UserProfile[]>(() => {
    try {
      const cached = localStorage.getItem('blackworm_cached_users');
      if (cached) {
        const parsed = JSON.parse(cached);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      }
    } catch {}
    return [];
  });
  const [selectedUserId, setSelectedUserId] = useState<string>(profile.uid);
  const [sheet, setYearlySheet] = useState<YearlySheet | null>(() => {
    try {
      const cached = localStorage.getItem(`yearly_target_sheet_${profile.uid}`);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (parsed && Array.isArray(parsed.months) && parsed.months.length > 0) {
          return parsed;
        }
      }
    } catch {}
    return null;
  });
  const [loading, setLoading] = useState(!sheet);
  const [saving, setSaving] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);
  const [isGeneratingPdf, setIsGeneratingPdf] = useState(false);
  const [downloadTimestamp, setDownloadTimestamp] = useState<string>('');
  const [isUserDropdownOpen, setIsUserDropdownOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [syncKey, setSyncKey] = useState(0);
  const lastSyncRef = useRef<number>(Date.now());

  // Failsafe: Never allow full-page loading spinner to stay stuck indefinitely
  useEffect(() => {
    if (loading) {
      const timer = setTimeout(() => {
        setLoading(false);
      }, 2000);
      return () => clearTimeout(timer);
    }
  }, [loading]);

  // Manual refresh that forces instant server pull without wiping UI data
  const handleManualRefresh = async () => {
    try {
      setRefreshing(true);
      lastSyncRef.current = Date.now();
      // Increment syncKey to trigger clean re-fetch from Firestore server
      setSyncKey(prev => prev + 1);
    } catch {
      // ignore
    } finally {
      setTimeout(() => setRefreshing(false), 700);
    }
  };

  // Auto-refresh when app comes to foreground or window gains focus (debounced to avoid loop)
  useEffect(() => {
    const handleFocus = () => {
      if (document.visibilityState === 'visible') {
        const now = Date.now();
        // Only re-sync if at least 15 seconds have passed since last sync to prevent infinite loops
        if (now - lastSyncRef.current > 15000) {
          lastSyncRef.current = now;
          setSyncKey(prev => prev + 1);
        }
      }
    };
    window.addEventListener('focus', handleFocus);
    document.addEventListener('visibilitychange', handleFocus);
    return () => {
      window.removeEventListener('focus', handleFocus);
      document.removeEventListener('visibilitychange', handleFocus);
    };
  }, []);

  // If not admin, lock selectedUserId to logged-in user profile
  useEffect(() => {
    if (!userIsAdmin) {
      setSelectedUserId(profile.uid);
    }
  }, [userIsAdmin, profile.uid]);

  // Shared Singleton Branding Hook (0ms read, no redundant Firestore reads)
  const { logoUrl, logoSize } = useBranding();

  const printableSheetRef = useRef<HTMLDivElement>(null);

  const monthsList = [
    'April', 'May', 'June', 
    'July', 'August', 'September', 
    'October', 'November', 'December', 
    'January', 'February', 'March'
  ];

  // Fetch users for dropdown with cache synchronization
  useEffect(() => {
    const q = query(collection(db, 'users'));
    const unsub = onSnapshot(q, { includeMetadataChanges: true }, (snap) => {
      const list: UserProfile[] = [];
      snap.forEach(d => list.push({ ...d.data(), uid: d.id } as UserProfile));
      list.sort((a, b) => (a.fullName || '').localeCompare(b.fullName || ''));
      setUsers(list);
      try {
        localStorage.setItem('blackworm_cached_users', JSON.stringify(list));
      } catch {}
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, 'users');
    });
    return () => unsub();
  }, [syncKey]);

  // Fetch or init sheet for selected user with 0ms instant cache resolution & live real-time sync
  useEffect(() => {
    const selectedUser = users.find(u => u.uid === selectedUserId) || profile;
    const isOwner = selectedUser.role === 'owner';

    // 1. Instant 0ms read from cache for this specific selected user (eliminates loading wait)
    if (!sheet || sheet.userId !== selectedUserId) {
      if (!isOwner) {
        try {
          const cached = localStorage.getItem(`yearly_target_sheet_${selectedUserId}`);
          if (cached) {
            const parsed = JSON.parse(cached);
            if (parsed && Array.isArray(parsed.months) && parsed.months.length > 0) {
              setYearlySheet(parsed);
              setLoading(false);
            } else {
              setLoading(true);
            }
          } else {
            setLoading(true);
          }
        } catch {
          setLoading(true);
        }
      } else {
        setLoading(true);
      }
    } else {
      // Sheet already in state for selected user - keep it visible without full-screen loading flash
      setLoading(false);
    }

    if (isOwner) {
      // Aggregation logic for owner - strictly decimal/cents precision
      const q = query(collection(db, 'yearly_targets'));
      const unsub = onSnapshot(q, { includeMetadataChanges: true }, (snap) => {
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
        setLoading(false);
        setRefreshing(false);
      });
      return () => unsub();
    } else {
      // Regular fetching for individual users with real-time metadata changes
      const sheetId = `yearly_${selectedUserId}_2026_27`;
      const unsub = onSnapshot(doc(db, 'yearly_targets', sheetId), { includeMetadataChanges: true }, (docSnap) => {
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
          try {
            localStorage.setItem(`yearly_target_sheet_${selectedUserId}`, JSON.stringify(data));
          } catch {}
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
        setRefreshing(false);
      }, (error) => {
        handleFirestoreError(error, OperationType.GET, `yearly_targets/${sheetId}`);
        setLoading(false);
        setRefreshing(false);
      });
      return () => unsub();
    }
  }, [selectedUserId, users, profile, syncKey]);

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

      try {
        localStorage.setItem(`yearly_target_sheet_${cleanedSheet.userId}`, JSON.stringify(cleanedSheet));
        // Permanent automated local backup before Firestore update
        localStorage.setItem(`backup_yearly_target_${cleanedSheet.userId}`, JSON.stringify({
          backupTimestamp: new Date().toISOString(),
          sheet: cleanedSheet
        }));
      } catch {}
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
      const now = new Date();
      const dateStr = now.toLocaleDateString('en-GB'); // DD/MM/YYYY
      const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
      setDownloadTimestamp(`${dateStr} ${timeStr}`);

      // Wait a moment for React to render clean static spans and the timestamp footnote
      await new Promise(r => setTimeout(r, 130));

      const element = printableSheetRef.current;
      
      const canvas = await html2canvas(element, {
        scale: 3, // 3x high resolution for razor-sharp text and clear borders
        useCORS: true,
        logging: false,
        backgroundColor: '#ffffff',
        windowWidth: 1024,
      });

      // Lossless PNG prevents JPEG artifacts and ensures sharp text rendering
      const imgData = canvas.toDataURL('image/png');
      const pdf = new jsPDF({
        orientation: 'portrait',
        unit: 'mm',
        format: 'a4'
      });

      const pageWidth = 210;
      const pageHeight = 297;
      const marginX = 5; // 5mm balanced margin ensures right side is never cut off!
      const marginY = 5;
      const maxContentWidth = pageWidth - (marginX * 2); // 200 mm
      const maxContentHeight = pageHeight - (marginY * 2); // 287 mm

      let finalWidth = maxContentWidth;
      let finalHeight = (canvas.height * finalWidth) / canvas.width;

      if (finalHeight > maxContentHeight) {
        finalHeight = maxContentHeight;
        finalWidth = (canvas.width * finalHeight) / canvas.height;
      }

      const posX = (pageWidth - finalWidth) / 2;
      const posY = marginY;

      pdf.addImage(imgData, 'PNG', posX, posY, finalWidth, finalHeight, undefined, 'FAST');
      const sanitizedName = (sheet?.fullName ? `Target_Sheet_${sheet.fullName}` : 'Target_Sheet_2026_27').replace(/[^a-zA-Z0-9_-]/g, '_');
      pdf.save(`${sanitizedName}.pdf`);
    } catch (err: any) {
      console.error('PDF download error:', err);
      window.print();
    } finally {
      setIsGeneratingPdf(false);
    }
  };

  if (loading && !sheet) {
    return (
      <div className="flex flex-col items-center justify-center p-12 bg-white rounded-2xl border border-slate-200 shadow-xs">
        <div className="w-8 h-8 border-4 border-slate-700 border-t-transparent rounded-full animate-spin mb-3" />
        <p className="text-slate-600 font-bold text-xs sm:text-sm">टार्गेट शीट डेटा लोड होत आहे...</p>
      </div>
    );
  }
  if (!sheet) {
    return (
      <div className="flex flex-col items-center justify-center p-12 bg-white rounded-2xl border border-slate-200 shadow-xs">
        <div className="w-8 h-8 border-4 border-slate-700 border-t-transparent rounded-full animate-spin mb-3" />
        <p className="text-slate-600 font-bold text-xs sm:text-sm">टार्गेट शीट तयार होत आहे...</p>
      </div>
    );
  }

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
      <div className="bg-white p-2 xs:p-2.5 sm:p-4 rounded-xl border border-slate-200 shadow-xs print:hidden space-y-2.5 sm:space-y-0 sm:flex sm:items-center sm:justify-between sm:gap-3">
        {/* Title area */}
        <div className="flex items-center gap-2 xs:gap-2.5 min-w-0">
          <div className="p-1.5 sm:p-2 bg-slate-100 text-slate-700 border border-slate-200 rounded-lg shrink-0">
            <Target className="w-4 h-4 sm:w-5 sm:h-5 text-slate-700" />
          </div>
          <div className="min-w-0">
            <h2 className="text-xs sm:text-base font-bold text-slate-900 truncate">Target & Collection Sheet 2026-27</h2>
            <p className="text-[10px] sm:text-xs text-slate-500 truncate">Yearly Target Sheet &bull; Blackworm Agritech</p>
          </div>
        </div>

        {/* User Selection & Actions: In a single line (flex-nowrap) on mobile, tablet, laptop, and monitor! */}
        <div className="flex items-center gap-1 xs:gap-1.5 sm:gap-2 flex-nowrap w-full sm:w-auto shrink-0 min-w-0">
          {userIsAdmin ? (
            <div className="relative flex-1 min-w-0 sm:w-64 md:w-80">
              <button
                type="button"
                onClick={() => setIsUserDropdownOpen(!isUserDropdownOpen)}
                className="w-full bg-slate-50 border border-slate-300 text-slate-800 py-1.5 px-2 xs:px-2.5 rounded-lg text-left flex items-center justify-between gap-1 xs:gap-1.5 cursor-pointer hover:bg-slate-100 transition shadow-2xs min-w-0"
                title={selectedUser.fullName || selectedUser.uid}
              >
                <div className="min-w-0 flex-1 flex items-center gap-1 xs:gap-1.5">
                  <span className="text-[10px] font-bold text-slate-500 uppercase shrink-0">
                    {selectedUser.role === 'owner' ? 'Owner:' : 'Officer:'}
                  </span>
                  <span className="text-[11px] xs:text-xs sm:text-sm font-bold text-slate-900 leading-tight text-left break-words line-clamp-1 flex-1">
                    {formatTitleCase(selectedUser.fullName || selectedUser.uid)}
                  </span>
                  {selectedUser.role === 'owner' && (
                    <span className="text-[9px] font-bold text-slate-600 uppercase shrink-0 bg-slate-200 px-1 py-0.2 rounded">
                      Total
                    </span>
                  )}
                </div>
                <ChevronDown className="w-3.5 h-3.5 text-slate-400 shrink-0" />
              </button>

              {isUserDropdownOpen && (
                <>
                  {/* Backdrop with dark blur overlay to completely prevent overlap with background data table */}
                  <div 
                    className="fixed inset-0 z-[90] bg-black/40 backdrop-blur-xs transition-opacity" 
                    onClick={() => setIsUserDropdownOpen(false)} 
                  />
                  {/* Responsive Dropdown: on mobile fixed with side margins (left-3 right-3), on desktop absolute under button */}
                  <div className="fixed left-3 right-3 top-24 sm:top-auto sm:left-0 sm:right-auto sm:absolute sm:mt-1 sm:w-80 md:w-96 z-[100] bg-white border border-slate-300 rounded-2xl shadow-2xl overflow-hidden ring-1 ring-black/10">
                    {/* Header: Strictly Officer (<count>) */}
                    <div className="p-3 bg-slate-100 border-b border-slate-200 flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <UserIcon className="w-4 h-4 text-slate-700" />
                        <span className="text-xs font-bold text-slate-800 uppercase tracking-wide">
                          Officer ({users.length})
                        </span>
                      </div>
                      <button 
                        type="button" 
                        onClick={() => setIsUserDropdownOpen(false)} 
                        className="p-1 rounded-lg text-slate-500 hover:text-slate-800 hover:bg-slate-200 cursor-pointer"
                        title="Close"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>

                    {/* Officer list - Only Officer Names */}
                    <div className="max-h-64 sm:max-h-80 overflow-y-auto p-1.5 divide-y divide-slate-100">
                      {users.map((u) => (
                        <div
                          key={u.uid}
                          onClick={() => {
                            setSelectedUserId(u.uid);
                            setIsUserDropdownOpen(false);
                          }}
                          className={cn(
                            "p-2.5 px-3 rounded-xl cursor-pointer transition flex items-center justify-between gap-3 text-xs sm:text-sm",
                            selectedUserId === u.uid 
                              ? "bg-blue-50 text-blue-900 font-bold border border-blue-200" 
                              : "hover:bg-slate-50 text-slate-800 font-medium"
                          )}
                        >
                          <div className="min-w-0 flex-1">
                            <p className="font-bold text-slate-900 whitespace-normal break-words leading-snug">
                              {formatTitleCase(u.fullName || u.uid)}
                            </p>
                          </div>
                          {u.role === 'owner' && (
                            <span className="text-[10px] font-bold text-slate-700 uppercase shrink-0 bg-slate-200 px-2 py-0.5 rounded-md">
                              Owner (Total)
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                </>
              )}
            </div>
          ) : (
            <div className="flex-1 min-w-0 bg-slate-50 border border-slate-300 py-1.5 px-2 xs:px-2.5 rounded-lg flex items-center gap-1.5">
              <span className="text-[10px] font-bold text-slate-500 uppercase shrink-0">Officer:</span>
              <span className="text-[11px] xs:text-xs sm:text-sm font-bold text-slate-900 leading-tight break-words line-clamp-1 flex-1">
                {formatTitleCase(selectedUser.fullName || selectedUser.uid)}
              </span>
            </div>
          )}

          {/* Live Sync / Refresh Live Data Button */}
          <button
            onClick={handleManualRefresh}
            disabled={refreshing}
            className="shrink-0 flex items-center justify-center gap-1 p-1.5 xs:px-2.5 sm:px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-800 border border-slate-300 rounded-lg text-xs font-bold transition shadow-2xs active:scale-95 disabled:opacity-50 cursor-pointer"
            title="Refresh latest live data from server"
          >
            <RefreshCw className={cn("w-3.5 h-3.5 text-slate-700", refreshing && "animate-spin text-blue-600")} />
            <span className="hidden xs:inline">{refreshing ? 'Syncing...' : 'Refresh'}</span>
          </button>

          {!isOwnerView && (
            <button
              onClick={handleSave}
              disabled={saving}
              className="shrink-0 flex items-center justify-center gap-1 p-1.5 xs:px-2.5 sm:px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-bold transition shadow-2xs disabled:opacity-50 cursor-pointer active:scale-95 whitespace-nowrap"
              title="Save Changes"
            >
              {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
              <span className="hidden xs:inline">Save</span>
            </button>
          )}

          {/* PDF Button: GUARANTEED directly next to the Name/Selector on the SAME LINE */}
          <button
            onClick={handleDownloadPdf}
            disabled={isGeneratingPdf}
            className="shrink-0 flex items-center justify-center gap-1 px-2.5 xs:px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-xs font-bold transition shadow-2xs disabled:opacity-50 cursor-pointer active:scale-95 whitespace-nowrap"
            title="Download PDF"
          >
            {isGeneratingPdf ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
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
      <div className="overflow-x-auto p-2 sm:p-4 bg-slate-100/70 rounded-2xl border border-slate-200">
        <div className="min-w-fit px-2 sm:px-4 py-2 inline-block">
          <div 
            ref={printableSheetRef}
            className="w-[880px] min-w-[880px] bg-white p-5 sm:p-6 shadow-sm border-2 border-slate-300 rounded-xl font-sans text-slate-900 relative"
            style={{ minHeight: '1080px' }}
          >
            {/* 1. Header with Company Logo & Details centered & balanced */}
            <div className="border-b-2 border-slate-400 pb-3 pt-1">
              <div className="flex items-center justify-center gap-5 sm:gap-7 max-w-[820px] mx-auto">
                {/* Left Logo - NO BOX, NO BORDER, CLEAN SEAMLESS INTEGRATION */}
                <div className="shrink-0 flex items-center justify-center p-0 bg-transparent border-0 shadow-none">
                  {logoUrl ? (
                    <img 
                      src={logoUrl} 
                      alt="Company Logo" 
                      style={{ 
                        width: `${logoSize || 85}px`, 
                        height: 'auto',
                        imageRendering: '-webkit-optimize-contrast'
                      }}
                      className="object-contain max-h-24 max-w-full drop-shadow-none" 
                    />
                  ) : (
                    <div className="w-16 h-16 bg-slate-800 text-white flex items-center justify-center font-black text-xl rounded-lg shadow-sm">
                      BW
                    </div>
                  )}
                </div>

              {/* Company Info centered right next to the logo */}
              <div className="text-center space-y-1">
                <h1 className="text-xl sm:text-2xl font-black text-slate-900 tracking-wide uppercase leading-tight">
                  BLACKWORM AGRITECH PVT LTD
                </h1>
                <div className="text-[11px] font-bold text-slate-800 tracking-tight flex items-center justify-center gap-2.5">
                  <span>CIN: U01409PN2022PTC217246</span>
                  <span className="text-slate-400 font-normal">&bull;</span>
                  <span>GST No.: 27AALCB3069J1ZC</span>
                </div>
                <p className="text-[11px] font-bold text-slate-800 leading-tight">
                  Address: Gat No. 17, Vijaynagar (Mhaisal), Tal. Miraj, Dist. Sangli – 416409
                </p>
                <div className="flex items-center justify-center gap-4 pt-0.5 text-slate-900 font-bold text-[11px]">
                  <span className="flex items-center gap-1.5">
                    <Phone className="w-3 h-3 text-slate-600" /> +91 7798716201
                  </span>
                  <span className="text-slate-400 font-normal">&bull;</span>
                  <span className="flex items-center gap-1.5">
                    <Mail className="w-3 h-3 text-slate-600" /> blackwormagritechpvtltd@gmail.com
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* 2. Document Title Banner - Clean, Calm, Professional with Ref & FY */}
          <div className="flex items-center justify-between px-3.5 py-1.5 border-b-2 border-slate-400 bg-slate-100 text-xs font-bold">
            <span className="text-[10px] font-bold text-slate-700 tracking-wide uppercase">
              Doc Ref: BW/TS/2026-27
            </span>
            <h2 className="text-xs sm:text-sm font-black uppercase tracking-wider text-slate-900">
              Target &amp; Collection Sheet 2026-27
            </h2>
            <span className="text-[10px] font-black text-slate-800 uppercase bg-white border border-slate-300 px-2.5 py-0.5 rounded shadow-2xs">
              FY 2026-27
            </span>
          </div>

          {/* 3. Officer Profile & Top Statistics Grid */}
          <div className="grid grid-cols-3 border-b-2 border-slate-400 divide-x-2 divide-slate-400 text-xs bg-white">
            {/* Column 1: Officer Information - No designation, single line Title Case */}
            <div className="divide-y-2 divide-slate-300">
              <div className="flex items-center p-0 min-h-[40px] py-0.5">
                <span className="font-extrabold text-slate-800 w-24 shrink-0 px-2.5 tracking-tight whitespace-nowrap">
                  {isOwnerView ? 'Owner -' : 'Officer -'}
                </span>
                <div className="flex-1 border-l-2 border-slate-300 min-h-[38px] flex items-center justify-center px-1.5 py-1">
                  <span className="w-full font-extrabold text-slate-950 text-center block text-[11px] sm:text-[13px] leading-tight break-words">
                    {formatTitleCase(selectedUser.fullName || sheet.fullName)}
                  </span>
                </div>
              </div>

              <div className="flex items-center p-0 min-h-[40px] py-0.5">
                <span className="font-extrabold text-slate-800 w-24 shrink-0 px-2.5 tracking-tight whitespace-nowrap">Center (HQ) -</span>
                <div className="flex-1 border-l-2 border-slate-300 min-h-[38px] flex items-center justify-center px-1.5 py-1">
                  <span className="w-full font-bold text-slate-900 text-center block text-[11px] sm:text-[13px] leading-tight break-words">
                    {isOwnerView ? 'All Centers' : (selectedUser.center || sheet.center || '-')}
                  </span>
                </div>
              </div>

              <div className="flex items-center p-0 min-h-[40px] py-0.5">
                <span className="font-extrabold text-slate-800 w-24 shrink-0 px-2.5 tracking-tight whitespace-nowrap">Year -</span>
                <div className="flex-1 border-l-2 border-slate-300 min-h-[38px] flex items-center px-1">
                  <span className="w-full font-extrabold text-slate-900 text-center block text-xs sm:text-[13px] whitespace-nowrap">
                    2026-27
                  </span>
                </div>
              </div>
            </div>

            {/* Column 2: Sales Data */}
            <div className="divide-y-2 divide-slate-300">
              <div className="flex items-center p-0 min-h-[40px] py-0.5">
                <span className="font-extrabold text-slate-800 w-28 shrink-0 px-2.5 tracking-tight whitespace-nowrap">L.Y. Sale -</span>
                <div className="flex-1 border-l-2 border-slate-300 min-h-[38px] flex items-center justify-center px-1">
                  <CellInput
                    value={sheet.lastYearSale}
                    disabled={isOwnerView}
                    isPdfOrPrint={isGeneratingPdf}
                    onChange={v => updateSheet({ lastYearSale: v })}
                    colorClass="text-slate-900 font-bold"
                  />
                  <span className="font-bold text-slate-700 text-[8.5px] uppercase ml-0.5 shrink-0">Lakh</span>
                </div>
              </div>

              <div className="flex items-center p-0 min-h-[40px] py-0.5 bg-blue-50/50">
                <span className="font-extrabold text-blue-950 w-28 shrink-0 px-2.5 tracking-tight whitespace-nowrap">Target -</span>
                <div className="flex-1 border-l-2 border-slate-300 min-h-[38px] flex items-center justify-center px-1">
                  <CellInput
                    value={sheet.salesTarget}
                    disabled={isOwnerView}
                    isPdfOrPrint={isGeneratingPdf}
                    onChange={v => updateSheet({ salesTarget: v })}
                    colorClass="text-blue-950 font-bold"
                  />
                  <span className="font-bold text-blue-900 text-[8.5px] uppercase ml-0.5 shrink-0">Lakh</span>
                </div>
              </div>

              <div className="flex items-center p-0 min-h-[40px] py-0.5">
                <span className="font-extrabold text-slate-800 w-28 shrink-0 px-2.5 tracking-tight whitespace-nowrap">L.Y. Outstd -</span>
                <div className="flex-1 border-l-2 border-slate-300 min-h-[38px] flex items-center justify-center px-1">
                  <CellInput
                    value={sheet.lastYearOutstanding}
                    disabled={isOwnerView}
                    isPdfOrPrint={isGeneratingPdf}
                    onChange={v => updateSheet({ lastYearOutstanding: v })}
                    colorClass="text-slate-900 font-bold"
                  />
                  <span className="font-bold text-slate-700 text-[8.5px] uppercase ml-0.5 shrink-0">Lakh</span>
                </div>
              </div>
            </div>

            {/* Column 3: Collection Data & Calculations */}
            <div className="divide-y-2 divide-slate-300">
              <div className="flex items-center p-0 min-h-[40px] py-0.5">
                <span className="font-extrabold text-slate-800 w-28 shrink-0 px-2.5 tracking-tight whitespace-nowrap">L.Y. Coll. -</span>
                <div className="flex-1 border-l-2 border-slate-300 min-h-[38px] flex items-center justify-center px-1">
                  <CellInput
                    value={sheet.lastYearCollection}
                    disabled={isOwnerView}
                    isPdfOrPrint={isGeneratingPdf}
                    onChange={v => updateSheet({ lastYearCollection: v })}
                    colorClass="text-slate-900 font-bold"
                  />
                  <span className="font-bold text-slate-700 text-[8.5px] uppercase ml-0.5 shrink-0">Lakh</span>
                </div>
              </div>

              <div className="flex items-center p-0 min-h-[40px] py-0.5 bg-slate-50">
                <span className="font-extrabold text-slate-900 w-28 shrink-0 px-2.5 tracking-tight whitespace-nowrap text-[9.5px]">Curr. Outstd -</span>
                <div className="flex-1 border-l-2 border-slate-300 min-h-[38px] flex items-center justify-center px-1">
                  <span className="w-full font-extrabold text-slate-950 font-mono text-center">
                    {formatAmount(subtractDecimal2(sheet.lastYearOutstanding, sheet.lastYearCollection))}
                  </span>
                  <span className="font-bold text-slate-700 text-[8.5px] uppercase ml-0.5 shrink-0">Lakh</span>
                </div>
              </div>

              <div className="flex items-center p-0 min-h-[40px] py-0.5 bg-blue-50/60">
                <span className="font-extrabold text-blue-950 w-28 shrink-0 px-2.5 tracking-tight whitespace-nowrap">Coll. Target -</span>
                <div className="flex-1 border-l-2 border-slate-300 min-h-[38px] flex items-center justify-center px-1">
                  {isOwnerView || isGeneratingPdf ? (
                    <span className="w-full font-extrabold text-blue-950 font-mono text-center">
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
                      className="w-full bg-transparent font-extrabold text-blue-950 focus:outline-none font-mono text-center" 
                    />
                  )}
                  <span className="font-extrabold text-blue-950 text-[8.5px] uppercase ml-0.5 shrink-0">%</span>
                </div>
              </div>
            </div>
          </div>

          {/* 4. Target Data Table */}
          <div className="overflow-x-auto bg-white border-2 border-slate-400 rounded-lg shadow-2xs">
            <table className="w-full text-left border-collapse text-xs sm:text-[13px] table-fixed min-w-[820px]">
              <thead>
                <tr className="bg-slate-800 text-white font-bold uppercase text-center border-b-2 border-slate-400 text-xs sm:text-[12.5px]">
                  <th className="p-2 border-r border-slate-400 whitespace-nowrap w-[5%] text-center">Sr.</th>
                  <th className="p-2 border-r border-slate-400 whitespace-nowrap w-[15%] text-center">Month</th>
                  <th className="p-2 border-r border-slate-400 whitespace-nowrap w-[13%] text-center">Target (Lakh)</th>
                  <th className="p-2 border-r border-slate-400 whitespace-nowrap w-[13%] text-center">Achieve (Lakh)</th>
                  <th className="p-2 border-r border-slate-400 whitespace-nowrap w-[10%] text-center">% Ach.</th>
                  <th className="p-2 border-r border-slate-400 whitespace-nowrap w-[16%] text-center">Collection (Lakh)</th>
                  <th className="p-2 border-r border-slate-400 whitespace-nowrap w-[14%] text-center">Actual Coll.</th>
                  <th className="p-2 whitespace-nowrap w-[14%] text-center">% Coll.</th>
                </tr>
              </thead>
              <tbody className="text-slate-900 font-medium">
                {sheet.months.map((m, idx) => {
                  const achPercentStr = calcPercent(m.achievement, m.target);
                  const collPercentStr = calcPercent(m.actualCollection, m.collection);
                  return (
                    <React.Fragment key={m.month}>
                      <tr className="hover:bg-slate-50/80 transition-colors">
                        <td className="p-1.5 border-r border-b border-slate-300 text-center font-bold text-slate-800 text-xs sm:text-[13px]">{idx + 1}</td>
                        <td className="p-1.5 border-r border-b border-slate-300 font-bold uppercase text-center text-xs sm:text-[13px] whitespace-nowrap text-slate-900">{m.month}</td>
                        <td className="p-1 border-r border-b border-slate-300">
                          <CellInput
                            value={m.target}
                            disabled={isOwnerView}
                            isPdfOrPrint={isGeneratingPdf}
                            onChange={v => updateMonth(idx, { target: v })}
                            colorClass="text-slate-900 font-bold"
                          />
                        </td>
                        <td className="p-1 border-r border-b border-slate-300">
                          <CellInput
                            value={m.achievement}
                            disabled={isOwnerView}
                            isPdfOrPrint={isGeneratingPdf}
                            onChange={v => updateMonth(idx, { achievement: v })}
                            colorClass="text-blue-900 font-bold"
                          />
                        </td>
                        <td className="p-1.5 border-r border-b border-slate-300 text-center font-bold font-mono text-xs sm:text-[13px] text-slate-900">{achPercentStr}</td>
                        {/* Collection in Lakh: strictly auto-calculated based on Target & Percentage, non-editable */}
                        <td className="p-1.5 border-r border-b border-slate-300 text-center font-mono font-bold text-xs sm:text-[13px] text-slate-900 bg-slate-50/90">
                          {formatAmount(m.collection)}
                        </td>
                        {/* Actual Collection: remains editable */}
                        <td className="p-1 border-r border-b border-slate-300">
                          <CellInput
                            value={m.actualCollection}
                            disabled={isOwnerView}
                            isPdfOrPrint={isGeneratingPdf}
                            onChange={v => updateMonth(idx, { actualCollection: v })}
                            colorClass="text-emerald-900 font-bold"
                          />
                        </td>
                        <td className="p-1.5 border-b border-slate-300 text-center font-bold font-mono text-xs sm:text-[13px] text-slate-900 px-2">{collPercentStr}</td>
                      </tr>
                      {/* Render Quarter Subtotal Row */}
                      {(idx === 2 || idx === 5 || idx === 8 || idx === 11) && (
                        <tr className="bg-slate-100 font-extrabold text-slate-900 border-y-2 border-slate-400 text-xs sm:text-[13px]">
                          <td colSpan={2} className="p-2 border-r border-b border-slate-400 text-center uppercase tracking-wide font-extrabold whitespace-nowrap">
                            {idx === 2 ? 'Q1' : idx === 5 ? 'Q2' : idx === 8 ? 'Q3' : 'Q4'} TOTAL
                          </td>
                          {(() => {
                            const q = idx === 2 ? Q1 : idx === 5 ? Q2 : idx === 8 ? Q3 : Q4;
                            return (
                              <>
                                <td className="p-2 border-r border-b border-slate-400 text-center font-mono font-extrabold text-xs sm:text-[13px]">{formatAmount(q.target)}</td>
                                <td className="p-2 border-r border-b border-slate-400 text-center font-mono text-blue-900 font-extrabold text-xs sm:text-[13px]">{formatAmount(q.achievement)}</td>
                                <td className="p-2 border-r border-b border-slate-400 text-center font-mono font-extrabold text-xs sm:text-[13px]">{calcPercent(q.achievement, q.target)}</td>
                                <td className="p-2 border-r border-b border-slate-400 text-center font-mono font-extrabold text-xs sm:text-[13px]">{formatAmount(q.collection)}</td>
                                <td className="p-2 border-r border-b border-slate-400 text-center font-mono text-emerald-900 font-extrabold text-xs sm:text-[13px]">{formatAmount(q.actual)}</td>
                                <td className="p-2 border-b border-slate-400 text-center font-mono font-extrabold text-xs sm:text-[13px] px-2">{calcPercent(q.actual, q.collection)}</td>
                              </>
                            );
                          })()}
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
                {/* Annual Grand Total Row */}
                <tr className="bg-slate-800 text-white font-extrabold text-xs sm:text-sm uppercase border-t-2 border-slate-700">
                  <td colSpan={2} className="p-2.5 text-center tracking-normal border-r border-slate-600 font-extrabold">
                    Grand Total 2026-27
                  </td>
                  <td className="p-2.5 text-center border-r border-slate-600 font-mono font-extrabold text-xs sm:text-sm">{formatAmount(Total.target)}</td>
                  <td className="p-2.5 text-center border-r border-slate-600 font-mono font-extrabold text-xs sm:text-sm">{formatAmount(Total.achievement)}</td>
                  <td className="p-2.5 text-center border-r border-slate-600 font-mono font-extrabold text-xs sm:text-sm">{calcPercent(Total.achievement, Total.target)}</td>
                  <td className="p-2.5 text-center border-r border-slate-600 font-mono font-extrabold text-xs sm:text-sm">{formatAmount(Total.collection)}</td>
                  <td className="p-2.5 text-center border-r border-slate-600 font-mono font-extrabold text-xs sm:text-sm">{formatAmount(Total.actual)}</td>
                  <td className="p-2.5 text-center font-mono font-extrabold text-xs sm:text-sm px-2">{calcPercent(Total.actual, Total.collection)}</td>
                </tr>
              </tbody>
            </table>
          </div>

          {/* Footer Approval Space with reduced vertical padding */}
          <div className="grid grid-cols-2 border-t-2 border-slate-400 mt-4 pt-3 pb-1 text-xs font-bold uppercase text-slate-800">
            <div className="text-center space-y-6">
              <p>Officer Signature</p>
              <div className="border-t-2 border-dashed border-slate-400 w-48 mx-auto" />
            </div>
            <div className="text-center space-y-6">
              <p>Managing Director / Owner</p>
              <div className="border-t-2 border-dashed border-slate-400 w-48 mx-auto" />
            </div>
          </div>

          {/* Current Date & Time strictly displayed directly above the line */}
          <div className="mt-3 pb-1 text-right text-[11px] font-mono font-bold text-slate-700 select-text">
            Date & Time: {downloadTimestamp || (new Date().toLocaleDateString('en-GB') + ' ' + new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true }))}
          </div>
          <div className="border-t border-slate-300" />
        </div>
      </div>
    </div>
  </div>
);
};
