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
import { logAudit, safeFirestoreSet } from '../../lib/dataService';
import { Language, translations } from '../../lib/i18n';
import { cn } from '../../lib/utils';
import { useBranding } from '../../lib/branding';
import jsPDF from 'jspdf';
import html2canvas from 'html2canvas-pro';
import { 
  Navigation,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  User as UserIcon,
  Save,
  CheckCircle2,
  Download,
  Loader2,
  Phone,
  Mail,
  X,
  Calendar
} from 'lucide-react';

export interface TravelRow {
  dayNumber: number;
  date: string;
  days: string; // Day of week (Mon, Tue, Wed...)
  route: string;
  openingKm: number;
  closingKm: number;
  km: number;
  amount: number;
  otherExpenses: number;
  subtotal: number;
}

export interface TravelSheetData {
  id: string;
  userId: string;
  officerName: string;
  designation: string;
  date: string; // Selected date / month-year
  monthName: string;
  yearNumber: number;
  ratePerKm: number;
  rows: TravelRow[];
  totalKm: number;
  totalAmount: number;
  totalOtherExpenses: number;
  subtotalAmount: number;
  averageCostPerKm: number;
  totalExpensesAmount: number;
  updatedAt?: string;
  createdAt?: string;
}

interface Props {
  profile: UserProfile;
  lang: Language;
}

// Generate rows for all days in month strictly (28, 29, 30, or 31 days)
export const generateMonthRows = (
  year: number, 
  monthIdx: number, 
  rate: number = 3.5,
  existingRows: TravelRow[] = []
): TravelRow[] => {
  const totalDays = new Date(year, monthIdx + 1, 0).getDate();
  const rows: TravelRow[] = [];
  const existingMap = new Map<number, TravelRow>();
  existingRows.forEach(r => {
    if (r.dayNumber && r.dayNumber <= totalDays) {
      existingMap.set(r.dayNumber, r);
    }
  });

  for (let d = 1; d <= totalDays; d++) {
    const dayDate = new Date(year, monthIdx, d);
    const dayString = `${year}-${String(monthIdx + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const dayOfWeek = dayDate.toLocaleDateString('en-US', { weekday: 'short' });

    if (existingMap.has(d)) {
      const ext = existingMap.get(d)!;
      const km = ext.closingKm >= ext.openingKm && ext.openingKm > 0 ? ext.closingKm - ext.openingKm : (ext.km || 0);
      const amount = ext.amount !== undefined && ext.amount !== null ? Number(ext.amount) || 0 : 0;
      const otherExpenses = Number(ext.otherExpenses) || 0;
      const subtotal = Math.round((amount + otherExpenses) * 100) / 100;

      rows.push({
        dayNumber: d,
        date: dayString,
        days: dayOfWeek,
        route: ext.route || '',
        openingKm: ext.openingKm || 0,
        closingKm: ext.closingKm || 0,
        km,
        amount,
        otherExpenses,
        subtotal
      });
    } else {
      rows.push({
        dayNumber: d,
        date: dayString,
        days: dayOfWeek,
        route: '',
        openingKm: 0,
        closingKm: 0,
        km: 0,
        amount: 0,
        otherExpenses: 0,
        subtotal: 0
      });
    }
  }
  return rows;
};

export const TravelView: React.FC<Props> = ({ profile, lang }) => {
  const t = translations[lang];
  const userIsAdmin = isAdmin(profile);
  const [users, setUsers] = useState<UserProfile[]>(() => {
    try {
      const cached = localStorage.getItem('blackworm_cached_users');
      if (cached) {
        const parsed = JSON.parse(cached);
        if (Array.isArray(parsed)) {
          return parsed.filter((u: any) => u.role !== 'owner');
        }
      }
    } catch {}
    return [];
  });
  const [selectedUserId, setSelectedUserId] = useState<string>(() => {
    if (profile.role === 'owner') {
      try {
        const cached = localStorage.getItem('blackworm_cached_users');
        if (cached) {
          const parsed = JSON.parse(cached);
          if (Array.isArray(parsed)) {
            const firstOfficer = parsed.find((u: any) => u.role !== 'owner');
            if (firstOfficer) return firstOfficer.uid;
          }
        }
      } catch {}
      return '';
    }
    return profile.uid;
  });
  const [isUserDropdownOpen, setIsUserDropdownOpen] = useState(false);
  
  // Current date by default
  const today = new Date();
  const [selectedDate, setSelectedDate] = useState<string>(() => {
    return today.toISOString().slice(0, 10);
  });

  // For non-admin (officers), strictly lock selectedUserId to logged-in user's uid
  useEffect(() => {
    if (!userIsAdmin && profile.role !== 'owner') {
      setSelectedUserId(profile.uid);
    }
  }, [userIsAdmin, profile.uid, profile.role]);

  // Accurate Year and Month parser from YYYY-MM-DD string
  const parseYearMonth = (dateStr: string) => {
    if (dateStr && dateStr.includes('-')) {
      const parts = dateStr.split('-');
      if (parts.length >= 2) {
        const y = parseInt(parts[0], 10);
        const m = parseInt(parts[1], 10) - 1;
        if (!isNaN(y) && !isNaN(m) && m >= 0 && m <= 11) {
          return { year: y, monthIndex: m };
        }
      }
    }
    const d = new Date();
    return { year: d.getFullYear(), monthIndex: d.getMonth() };
  };

  const { year: selectedYearNumber, monthIndex: selectedMonthIndex } = parseYearMonth(selectedDate);

  const monthNames = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
  ];
  const selectedMonthName = monthNames[selectedMonthIndex];

  const handlePrevMonth = () => {
    const d = new Date(selectedYearNumber, selectedMonthIndex, 1);
    d.setMonth(d.getMonth() - 1);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    setSelectedDate(`${y}-${m}-01`);
  };

  const handleNextMonth = () => {
    const d = new Date(selectedYearNumber, selectedMonthIndex, 1);
    d.setMonth(d.getMonth() + 1);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    setSelectedDate(`${y}-${m}-01`);
  };

  const [ratePerKm, setRatePerKm] = useState<number>(3.5);
  const [loading, setLoading] = useState<boolean>(false);
  const [saving, setSaving] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);
  const [isGeneratingPdf, setIsGeneratingPdf] = useState(false);

  // Instant sheet initialization from localStorage cache or clean default rows (never blank/null for officers)
  const [sheet, setSheet] = useState<TravelSheetData | null>(() => {
    if (profile.role === 'owner' && (!selectedUserId || selectedUserId === profile.uid)) {
      return null;
    }
    const sheetMonthKey = `${selectedYearNumber}_${(selectedMonthIndex + 1).toString().padStart(2, '0')}`;
    const targetUid = selectedUserId || profile.uid;
    const cacheKey = `travel_sheet_${targetUid}_${sheetMonthKey}`;
    try {
      const raw = localStorage.getItem(cacheKey);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.rows) && parsed.rows.length > 0) {
          return parsed;
        }
      }
    } catch {}

    const fullRows = generateMonthRows(selectedYearNumber, selectedMonthIndex, 3.5, []);
    return {
      id: `travel_${targetUid}_${sheetMonthKey}`,
      userId: targetUid,
      officerName: profile.fullName || profile.uid,
      designation: profile.designation || 'FIELD OFFICER',
      date: selectedDate,
      monthName: selectedMonthName,
      yearNumber: selectedYearNumber,
      ratePerKm: 3.5,
      rows: fullRows,
      totalKm: 0,
      totalAmount: 0,
      totalOtherExpenses: 0,
      subtotalAmount: 0,
      averageCostPerKm: 0,
      totalExpensesAmount: 0
    };
  });

  // Selected user photo
  const [selectedUserPhoto, setSelectedUserPhoto] = useState<string>('');

  const printableSheetRef = useRef<HTMLDivElement>(null);
  const suppressedCommaMap = useRef<Record<number, boolean>>({});

  // Village name formatter: First letter Capital, rest lowercase (Title Case)
  const formatRouteVillages = (str: string): string => {
    return str.replace(/\b[a-zA-Z]+/g, (match) => {
      return match.charAt(0).toUpperCase() + match.slice(1).toLowerCase();
    });
  };

  // Route input handler: Auto-inserts comma on space after word, but remembers if comma was deleted
  const handleRouteKeyDown = (idx: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    const input = e.currentTarget;
    const cursorPos = input.selectionStart || 0;
    const val = input.value;

    if (e.key === 'Backspace') {
      const textBefore = val.slice(0, cursorPos);
      // If user deletes a comma or comma-space, suppress auto-comma so subsequent space does not re-add comma
      if (textBefore.endsWith(',') || textBefore.endsWith(', ')) {
        suppressedCommaMap.current[idx] = true;
      }
      return;
    }

    if (e.key === ' ') {
      // If user previously deleted the comma, allow standard space without adding comma
      if (suppressedCommaMap.current[idx]) {
        return;
      }

      // If typed space immediately following a word (letter or digit), auto-insert comma and space
      const textBefore = val.slice(0, cursorPos);
      if (/[A-Za-z0-9]$/.test(textBefore)) {
        e.preventDefault();
        const textAfter = val.slice(cursorPos);
        const formattedBefore = formatRouteVillages(textBefore);
        const newVal = formattedBefore + ', ' + textAfter;
        updateRow(idx, { route: newVal });
        setTimeout(() => {
          input.setSelectionRange(cursorPos + 2, cursorPos + 2);
        }, 0);
        return;
      }
    }

    // Typing a new word character resets suppression for the subsequent word
    if (e.key.length === 1 && /[A-Za-z0-9]/.test(e.key)) {
      suppressedCommaMap.current[idx] = false;
    }
  };

  // User photo listener
  useEffect(() => {
    const user = users.find(u => u.uid === selectedUserId) || profile;
    if (user && (user as any).photoUrl) {
      setSelectedUserPhoto((user as any).photoUrl);
    } else {
      setSelectedUserPhoto('');
    }
  }, [selectedUserId, users, profile]);

  // Branding
  const { logoUrl, logoSize } = useBranding();

  // Fetch users for dropdown - filter out Owner so Owner traveling sheet is never created or selected
  useEffect(() => {
    const q = query(collection(db, 'users'));
    const unsub = onSnapshot(q, (snap) => {
      const list: UserProfile[] = [];
      snap.forEach(d => {
        const userData = d.data() as UserProfile;
        // Strictly exclude owner from traveling sheet users
        if (userData.role !== 'owner') {
          list.push({ ...userData, uid: d.id });
        }
      });
      list.sort((a, b) => (a.fullName || '').localeCompare(b.fullName || ''));
      setUsers(list);

      // Auto-select first officer if current selection is empty or is an owner
      if (list.length > 0) {
        setSelectedUserId(prev => {
          if (!prev || (profile.role === 'owner' && prev === profile.uid)) {
            return list[0].uid;
          }
          const exists = list.some(u => u.uid === prev);
          return exists ? prev : list[0].uid;
        });
      }
    });
    return () => unsub();
  }, [profile.role, profile.uid]);

  // Fetch or initialize sheet with instant cache-first and live sync
  useEffect(() => {
    // Strictly prevent creating or loading travel sheets for Owner
    const isOwnerTarget = (profile.role === 'owner' && (!selectedUserId || selectedUserId === profile.uid)) ||
                          users.some(u => u.uid === selectedUserId && u.role === 'owner');
    if (isOwnerTarget || !selectedUserId) {
      setSheet(null);
      setLoading(false);
      return;
    }

    const targetUid = selectedUserId;
    const sheetMonthKey = `${selectedYearNumber}_${(selectedMonthIndex + 1).toString().padStart(2, '0')}`;
    const sheetId = `travel_${targetUid}_${sheetMonthKey}`;
    const cacheKey = `travel_sheet_${targetUid}_${sheetMonthKey}`;

    // 1. Immediately read from localStorage if present
    try {
      const cached = localStorage.getItem(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (parsed && Array.isArray(parsed.rows) && parsed.rows.length > 0) {
          setSheet(parsed);
          setRatePerKm(parsed.ratePerKm || 3.5);
        }
      }
    } catch {}

    const selectedUser = users.find(u => u.uid === targetUid) || profile;
    const currentRate = 3.5;

    const unsub = onSnapshot(doc(db, 'travel_sheets', sheetId), (docSnap) => {
      if (docSnap.exists()) {
        const data = docSnap.data() as TravelSheetData;
        const rRate = data.ratePerKm || currentRate;
        setRatePerKm(rRate);
        const fullRows = generateMonthRows(
          selectedYearNumber, 
          selectedMonthIndex, 
          rRate, 
          data.rows || []
        );

        const totalKm = fullRows.reduce((acc, r) => acc + (r.km || 0), 0);
        const totalAmount = fullRows.reduce((acc, r) => acc + (r.amount || 0), 0);
        const totalOtherExpenses = fullRows.reduce((acc, r) => acc + (r.otherExpenses || 0), 0);
        const subtotalAmount = Math.round((totalAmount + totalOtherExpenses) * 100) / 100;
        const totalExpensesAmount = subtotalAmount;
        const averageCostPerKm = totalKm > 0 ? Math.round((totalExpensesAmount / totalKm) * 100) / 100 : 0;

        const updatedSheet: TravelSheetData = {
          ...data,
          id: sheetId,
          userId: targetUid,
          officerName: selectedUser.fullName || data.officerName || targetUid,
          designation: selectedUser.designation || data.designation || 'FIELD OFFICER',
          date: selectedDate,
          monthName: selectedMonthName,
          yearNumber: selectedYearNumber,
          ratePerKm: rRate,
          rows: fullRows,
          totalKm,
          totalAmount,
          totalOtherExpenses,
          subtotalAmount,
          averageCostPerKm,
          totalExpensesAmount
        };

        setSheet(updatedSheet);
        try {
          localStorage.setItem(cacheKey, JSON.stringify(updatedSheet));
        } catch {}
      } else {
        // Document doesn't exist yet on server; check if local state already has rows
        setSheet((prevSheet) => {
          if (prevSheet && prevSheet.id === sheetId && prevSheet.rows.some(r => r.openingKm > 0 || r.closingKm > 0 || r.route)) {
            return prevSheet;
          }
          const fullRows = generateMonthRows(
            selectedYearNumber, 
            selectedMonthIndex, 
            currentRate
          );
          const newSheet: TravelSheetData = {
            id: sheetId,
            userId: targetUid,
            officerName: selectedUser.fullName || targetUid,
            designation: selectedUser.designation || 'FIELD OFFICER',
            date: selectedDate,
            monthName: selectedMonthName,
            yearNumber: selectedYearNumber,
            ratePerKm: currentRate,
            rows: fullRows,
            totalKm: 0,
            totalAmount: 0,
            totalOtherExpenses: 0,
            subtotalAmount: 0,
            averageCostPerKm: 0,
            totalExpensesAmount: 0
          };
          try {
            localStorage.setItem(cacheKey, JSON.stringify(newSheet));
          } catch {}
          return newSheet;
        });
      }
      setLoading(false);
    }, (err) => {
      console.warn('Travel sheet snapshot notice:', err);
      setLoading(false);
    });

    return () => unsub();
  }, [selectedUserId, selectedYearNumber, selectedMonthIndex, users, profile.role, profile.uid]);

  const updateRow = (index: number, updates: Partial<TravelRow>) => {
    if (!sheet) return;
    const newRows = [...sheet.rows];
    const currentRow = newRows[index];
    const updated = { ...currentRow, ...updates };

    // Auto-calculate KM (Closing KM - Opening KM)
    if ('openingKm' in updates || 'closingKm' in updates) {
      if (updated.closingKm >= updated.openingKm && updated.openingKm > 0) {
        updated.km = updated.closingKm - updated.openingKm;
      } else if (updated.closingKm === 0 && updated.openingKm === 0) {
        updated.km = 0;
      }
    }

    // Manual Amount: strictly set by user input, not auto-calculated from KM
    if ('amount' in updates) {
      updated.amount = updates.amount !== undefined && updates.amount !== null ? Number(updates.amount) || 0 : 0;
    }

    // Auto-calculate Subtotal (Manual Amount + Other Expenses)
    const amount = Number(updated.amount) || 0;
    const other = Number(updated.otherExpenses) || 0;
    updated.subtotal = Math.round((amount + other) * 100) / 100;

    newRows[index] = updated;

    // Recalculate Totals
    const totalKm = newRows.reduce((acc, r) => acc + (r.km || 0), 0);
    const totalAmount = newRows.reduce((acc, r) => acc + (r.amount || 0), 0);
    const totalOtherExpenses = newRows.reduce((acc, r) => acc + (r.otherExpenses || 0), 0);
    const subtotalAmount = Math.round((totalAmount + totalOtherExpenses) * 100) / 100;
    const totalExpensesAmount = subtotalAmount;
    const averageCostPerKm = totalKm > 0 ? Math.round((totalExpensesAmount / totalKm) * 100) / 100 : 0;

    setSheet({
      ...sheet,
      rows: newRows,
      totalKm,
      totalAmount,
      totalOtherExpenses,
      subtotalAmount,
      averageCostPerKm,
      totalExpensesAmount
    });
  };

  const handleRateChange = (newRate: number) => {
    if (!sheet) return;
    setRatePerKm(newRate);
    // Amount is strictly manual per user instruction - never auto-calculate
    setSheet({
      ...sheet,
      ratePerKm: newRate,
    });
  };

  const handleSave = async () => {
    if (!sheet) return;
    setSaving(true);
    // Instant local caching so data is never lost even if network cuts out or quota limits hit
    const sheetMonthKey = `${sheet.yearNumber}_${(selectedMonthIndex + 1).toString().padStart(2, '0')}`;
    const cacheKey = `travel_sheet_${sheet.userId}_${sheetMonthKey}`;
    try {
      localStorage.setItem(cacheKey, JSON.stringify(sheet));
      localStorage.setItem(`travel_sheet_${sheet.userId}`, JSON.stringify(sheet));
    } catch {}

    try {
      await safeFirestoreSet('travel_sheets', sheet.id, {
        ...sheet,
        updatedAt: new Date().toISOString()
      }, { merge: true });

      try {
        await logAudit(
          'UPDATE', 
          'travel_sheets', 
          sheet.id, 
          `Saved Travelling Sheet for ${sheet.officerName} (${sheet.monthName} ${sheet.yearNumber})`, 
          profile
        );
      } catch {}
      setShowSuccess(true);
      setTimeout(() => setShowSuccess(false), 3000);
    } catch (err) {
      console.warn('Firestore save notice:', err);
      // Since it is saved locally, still notify user that changes are retained safely
      setShowSuccess(true);
      setTimeout(() => setShowSuccess(false), 3000);
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
        scale: 2,
        useCORS: true,
        logging: false,
        backgroundColor: '#ffffff',
        width: 980,
        windowWidth: 1200,
        scrollX: 0,
        scrollY: 0,
        onclone: (clonedDoc) => {
          const clonedSheet = clonedDoc.querySelector('[data-printable-sheet="true"]') as HTMLElement;
          if (clonedSheet) {
            clonedSheet.style.width = '980px';
            clonedSheet.style.minWidth = '980px';
            clonedSheet.style.maxWidth = '980px';
            clonedSheet.style.overflow = 'visible';
            clonedSheet.style.margin = '0';
            clonedSheet.style.boxSizing = 'border-box';
          }

          // Replace inputs in the clone with styled divs so html2canvas renders complete text without input clipping
          const inputs = clonedDoc.querySelectorAll('input');
          inputs.forEach((input) => {
            const textDiv = clonedDoc.createElement('div');
            const val = input.value || input.placeholder || '';
            textDiv.textContent = val;
            textDiv.style.width = '100%';
            textDiv.style.textAlign = 'center';
            textDiv.style.whiteSpace = 'nowrap';
            textDiv.style.overflow = 'visible';
            textDiv.style.display = 'block';
            textDiv.style.fontWeight = '900';
            textDiv.style.textTransform = 'uppercase';
            textDiv.style.color = '#000000';
            textDiv.style.lineHeight = '1.2';
            textDiv.style.padding = '2px 3px';

            const role = input.getAttribute('data-role');
            if (role === 'route') {
              textDiv.style.padding = '2px 3px 2px 6px';
              textDiv.style.textAlign = 'left';
              const len = val.length;
              // Precise font scaling for Route column so even very long village chains fit in a single line!
              const fontSize = len > 50 ? '7.5px' : len > 38 ? '8.5px' : len > 26 ? '9.5px' : '10.5px';
              textDiv.style.fontSize = fontSize;
              textDiv.style.letterSpacing = '-0.02em';
            } else if (role === 'officerName') {
              textDiv.style.fontSize = '12px';
              textDiv.style.textAlign = 'left';
            } else if (role === 'designation') {
              textDiv.style.fontSize = '9.5px';
              textDiv.style.textAlign = 'left';
            } else {
              textDiv.style.fontSize = '10px';
            }

            input.parentNode?.replaceChild(textDiv, input);
          });
        }
      });

      const imgData = canvas.toDataURL('image/jpeg', 0.98);
      const pdf = new jsPDF({
        orientation: 'portrait',
        unit: 'mm',
        format: 'a4',
        compress: true,
      });

      const pageWidth = 210;
      const pageHeight = 297;
      const marginX = 5;
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

      pdf.addImage(imgData, 'JPEG', posX, posY, finalWidth, finalHeight, undefined, 'FAST');
      const sanitizedName = (sheet?.officerName ? `Traveling_Sheet_${sheet.officerName}_${sheet.monthName}` : 'Traveling_Sheet').replace(/[^a-zA-Z0-9_-]/g, '_');
      pdf.save(`${sanitizedName}.pdf`);
    } catch (err: any) {
      console.error('PDF download error:', err);
      window.print();
    } finally {
      setIsGeneratingPdf(false);
    }
  };

  if (!sheet) {
    if (profile.role === 'owner' && users.length === 0) {
      return (
        <div className="bg-white p-8 rounded-2xl border border-slate-200 text-center space-y-2">
          <p className="text-slate-800 font-black text-sm">कोणतेही फील्ड ऑफिसर्स उपलब्ध नाहीत.</p>
          <p className="text-slate-500 text-xs font-medium">ट्रॅव्हलिंग सीट केवळ फील्ड ऑफिसर्ससाठी तयार केली जाते.</p>
        </div>
      );
    }
    return (
      <div className="flex flex-col items-center justify-center p-12 bg-white rounded-2xl border border-slate-200">
        <div className="w-8 h-8 border-4 border-red-600 border-t-transparent rounded-full animate-spin mb-3" />
        <p className="text-slate-600 font-bold text-sm">
          {profile.role === 'owner' ? 'फील्ड ऑफिसर्सची ट्रॅव्हलिंग सीट लोड होत आहे...' : 'ट्रॅव्हलिंग शीट तयार होत आहे...'}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4 font-sans pb-12">
      {/* Top Action Toolbar */}
      <div className="bg-white p-2.5 sm:p-3 rounded-2xl border border-slate-200 shadow-md flex flex-wrap items-center justify-between gap-2.5 no-print">
        
        {/* User & Date / Month Selectors */}
        <div className="flex flex-wrap items-center gap-2">
          {/* User Selector: Dropdown for Admin, Locked Badge for Non-Admin */}
          {userIsAdmin ? (
            <div className="relative flex-1 min-w-[130px] sm:w-60">
              <button
                type="button"
                onClick={() => setIsUserDropdownOpen(!isUserDropdownOpen)}
                className="w-full bg-slate-50 border border-slate-300 text-slate-800 py-1.5 px-2 xs:px-2.5 rounded-lg text-left flex items-center justify-between gap-1.5 cursor-pointer hover:bg-slate-100 transition shadow-2xs min-w-0"
              >
                <div className="min-w-0 flex-1 flex items-center gap-1.5">
                  <UserIcon className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                  <span className="text-[11px] xs:text-xs font-bold text-slate-900 leading-tight break-words line-clamp-1 flex-1">
                    {users.find(u => u.uid === selectedUserId)?.fullName || (profile.role !== 'owner' ? profile.fullName : 'अधिकारी निवडा')}
                  </span>
                </div>
                <ChevronDown className="w-3.5 h-3.5 text-slate-400 shrink-0" />
              </button>

              {isUserDropdownOpen && (
                <>
                  <div 
                    className="fixed inset-0 z-[90] bg-black/40 backdrop-blur-xs transition-opacity" 
                    onClick={() => setIsUserDropdownOpen(false)} 
                  />
                  <div className="fixed left-3 right-3 top-28 sm:top-auto sm:left-0 sm:right-auto sm:absolute sm:mt-1 sm:w-80 md:w-96 z-[100] bg-white border border-slate-300 rounded-2xl shadow-2xl overflow-hidden ring-1 ring-black/10">
                    <div className="p-3 bg-slate-100 border-b border-slate-200 flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <UserIcon className="w-4 h-4 text-slate-700" />
                        <span className="text-xs font-bold text-slate-800 uppercase tracking-wide">
                          अधिकारी निवडा ({users.length})
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
                            <p className="font-bold text-slate-900 whitespace-normal break-words">{u.fullName || u.uid}</p>
                            <p className="text-[10px] text-slate-500 uppercase mt-0.5">
                              {u.designation || u.role || 'FIELD OFFICER'}
                            </p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </>
              )}
            </div>
          ) : (
            <div className="flex items-center gap-1.5 px-2.5 py-1 bg-slate-100 border border-slate-200 rounded-lg text-xs font-black uppercase text-slate-800">
              <UserIcon className="w-3 h-3 text-slate-500 shrink-0" />
              <span className="font-black text-slate-900 truncate">{profile.fullName || 'OFFICER'}</span>
              <span className="text-[9px] font-bold text-slate-500 bg-white border border-slate-200 px-1 py-0.2 rounded shrink-0">
                ({profile.designation || 'OFFICER'})
              </span>
            </div>
          )}

          {/* Unified Month / Date Box with Calendar Icon & Arrows */}
          <div className="flex items-center gap-1.5 bg-slate-50 border border-slate-300 px-2 py-1 rounded-lg">
            <Calendar className="w-3.5 h-3.5 text-red-600 shrink-0" />
            <button
              type="button"
              onClick={handlePrevMonth}
              className="p-0.5 rounded hover:bg-slate-200 text-slate-700 transition active:scale-95 cursor-pointer"
              title="Previous Month"
            >
              <ChevronLeft className="w-3.5 h-3.5 stroke-[2.5]" />
            </button>
            <span className="text-xs font-black text-slate-900 px-1 whitespace-nowrap">
              {selectedMonthName} {selectedYearNumber}
            </span>
            <button
              type="button"
              onClick={handleNextMonth}
              className="p-0.5 rounded hover:bg-slate-200 text-slate-700 transition active:scale-95 cursor-pointer"
              title="Next Month"
            >
              <ChevronRight className="w-3.5 h-3.5 stroke-[2.5]" />
            </button>
          </div>
        </div>

        {/* Action Buttons: Compact Save & PDF, Print Removed */}
        <div className="flex items-center gap-1.5 shrink-0 ml-auto">
          <button 
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="bg-emerald-600 hover:bg-emerald-700 text-white px-2 py-1 rounded-md text-[11px] font-bold transition flex items-center gap-1 shadow-2xs active:scale-95 disabled:opacity-50 cursor-pointer whitespace-nowrap"
            title="Save Travelling Sheet"
          >
            {saving ? <Loader2 className="w-2.5 h-2.5 animate-spin" /> : <Save className="w-2.5 h-2.5" />}
            <span>Save</span>
          </button>

          <button
            type="button"
            onClick={handleDownloadPdf}
            disabled={isGeneratingPdf}
            className="bg-blue-600 hover:bg-blue-700 text-white px-2 py-1 rounded-md text-[11px] font-bold transition flex items-center gap-1 shadow-2xs active:scale-95 disabled:opacity-50 cursor-pointer whitespace-nowrap"
            title="Save PDF"
          >
            {isGeneratingPdf ? <Loader2 className="w-2.5 h-2.5 animate-spin" /> : <Download className="w-2.5 h-2.5" />}
            <span>PDF</span>
          </button>
        </div>
      </div>

      {showSuccess && (
        <div className="bg-emerald-50 border border-emerald-200 p-3 rounded-xl flex items-center justify-between text-emerald-800 text-xs font-bold animate-in fade-in no-print">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
            <span>Traveling sheet saved successfully!</span>
          </div>
          <button onClick={() => setShowSuccess(false)} className="text-emerald-700">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* ======================= STRICT OFFICIAL TRAVELLING SHEET FORM ======================= */}
      <div className="bg-white rounded-2xl border-2 border-slate-300 shadow-xl overflow-x-auto print:border-none print:shadow-none print:m-0 print:p-0">
        <div ref={printableSheetRef} data-printable-sheet="true" className="border-2 border-black bg-white shadow-sm w-[980px] min-w-[980px]">
          
          {/* 1. Header Section - Logo (Left) and Company Details (Center) */}
          <div className="p-3 relative bg-white border-b-2 border-black">
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

              {/* Travel Allowance Badge or User Photo */}
              <div className="w-20 h-20 flex flex-col items-center justify-center border-2 border-black bg-white shrink-0 overflow-hidden">
                {selectedUserPhoto ? (
                  <img src={selectedUserPhoto} alt="User" className="w-full h-full object-cover" />
                ) : (
                  <div className="flex flex-col items-center justify-center p-1 bg-red-50 w-full h-full">
                    <Navigation className="w-6 h-6 text-red-600 mb-0.5" />
                    <span className="text-[8px] font-black text-slate-900 leading-tight text-center uppercase">TRAVEL STATEMENT</span>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* 2. Banner: Month & Year Full Statement */}
          <div className="bg-slate-900 text-white font-black px-2 py-2 flex items-center justify-center border-b-2 border-black">
            <span className="text-xs sm:text-sm tracking-widest uppercase whitespace-nowrap text-center">
              MONTHLY TRAVEL EXPENSE STATEMENT - {sheet.monthName.toUpperCase()} {sheet.yearNumber}
            </span>
          </div>

          {/* 3. Header Fields: Officer Name, Designation, Date */}
          <div className="grid grid-cols-[1.9fr_0.85fr_0.75fr] divide-x-2 divide-black border-b-2 border-black bg-white text-[11px] font-black">
            
            {/* Officer Name - Fully visible with expanded width */}
            <div className="flex items-center p-0 min-h-10">
              <span className="font-black text-black shrink-0 px-2 uppercase tracking-tighter text-xs">Officer Name -</span>
              <div className="flex-1 border-l-2 border-black min-h-10 flex items-center px-2 min-w-0">
                <input 
                  type="text" 
                  data-role="officerName"
                  value={sheet.officerName} 
                  onChange={e => setSheet({ ...sheet, officerName: e.target.value.toUpperCase() })} 
                  placeholder="OFFICER NAME"
                  className="w-full bg-transparent font-black text-black uppercase focus:outline-none text-left text-xs sm:text-[12.5px] tracking-tight" 
                />
              </div>
            </div>

            {/* Designation - Compressed and compact */}
            <div className="flex items-center p-0 min-h-10 bg-slate-50/40">
              <span className="font-black text-slate-800 shrink-0 px-2 uppercase tracking-tighter whitespace-nowrap text-[9px] sm:text-[9.5px]">Designation -</span>
              <div className="flex-1 border-l-2 border-black min-h-10 flex items-center px-2 min-w-0">
                <input 
                  type="text" 
                  data-role="designation"
                  value={sheet.designation} 
                  onChange={e => setSheet({ ...sheet, designation: e.target.value.toUpperCase() })} 
                  placeholder="DESIGNATION"
                  className="w-full bg-transparent font-black text-slate-800 uppercase focus:outline-none text-left text-[9px] sm:text-[9.5px] tracking-tight" 
                />
              </div>
            </div>

            {/* Date */}
            <div className="flex items-center p-0 min-h-10 bg-slate-50">
              <span className="font-black text-black shrink-0 px-2 uppercase tracking-tighter whitespace-nowrap">Date -</span>
              <div className="flex-1 border-l-2 border-black min-h-10 flex items-center justify-center px-2 min-w-0">
                <span className="font-black text-black text-center uppercase whitespace-nowrap">
                  {sheet.monthName} {sheet.yearNumber}
                </span>
              </div>
            </div>
          </div>

          {/* 4. Strict Table Columns: Date, Days, Route, Opening KM, Closing KM, KM, Amount, Other Expenses, Subtotal */}
          <div className="overflow-x-auto bg-white">
            <table className="w-full text-left border-collapse text-[10.5px]">
              <thead>
                <tr className="bg-slate-900 text-white font-black uppercase text-center border-b-2 border-black">
                  <th className="p-1.5 border-r-2 border-black w-16 text-center whitespace-nowrap">Date</th>
                  <th className="p-1.5 border-r-2 border-black w-12 text-center whitespace-nowrap">Days</th>
                  <th className="p-1.5 pl-3 border-r-2 border-black w-[410px] min-w-[390px] text-left whitespace-nowrap">Route</th>
                  <th className="p-1.5 border-r-2 border-black w-16 text-center whitespace-nowrap">Opening KM</th>
                  <th className="p-1.5 border-r-2 border-black w-16 text-center whitespace-nowrap">Closing KM</th>
                  <th className="p-1.5 border-r-2 border-black w-14 text-center whitespace-nowrap">KM</th>
                  <th className="p-1.5 border-r-2 border-black w-16 text-center whitespace-nowrap">Amount</th>
                  <th className="p-1.5 border-r-2 border-black w-20 text-center whitespace-nowrap">Other Expenses</th>
                  <th className="p-1.5 text-center w-20 bg-slate-800 whitespace-nowrap">Subtotal</th>
                </tr>
              </thead>
              <tbody className="divide-y-2 divide-black text-black font-black">
                {sheet.rows.map((row, idx) => {
                  const isSunday = row.days === 'Sun';
                  const routeLen = (row.route || '').length;
                  return (
                    <tr 
                      key={row.dayNumber} 
                      className={`transition-colors ${isSunday ? 'bg-rose-50/70 font-black' : 'hover:bg-amber-50/40'}`}
                    >
                      {/* Date */}
                      <td className="p-1 border-r-2 border-black text-center font-black align-middle">
                        <span className="font-mono text-[10px] whitespace-nowrap">
                          {row.date.slice(8, 10)}/{row.date.slice(5, 7)}/{row.date.slice(0, 4)}
                        </span>
                      </td>

                      {/* Days */}
                      <td className="p-1 border-r-2 border-black text-center font-black align-middle">
                        <span className={isSunday ? 'text-red-700' : 'text-slate-800'}>
                          {row.days}
                        </span>
                      </td>

                      {/* Route (Strictly single line, all village names clearly visible without cutting off) */}
                      <td className="p-0 pl-2 pr-1 border-r-2 border-black align-middle w-[410px] min-w-[390px]">
                        <input 
                          type="text" 
                          data-role="route"
                          value={row.route} 
                          title={row.route}
                          onKeyDown={e => handleRouteKeyDown(idx, e)}
                          onChange={e => updateRow(idx, { route: formatRouteVillages(e.target.value) })}
                          placeholder={isSunday ? "SUNDAY / OFF" : ""}
                          className={`w-full p-0 m-0 pl-1 pr-0.5 py-0.5 bg-transparent border-none focus:outline-none font-black text-left block leading-tight whitespace-nowrap tracking-tight ${
                            routeLen > 48
                              ? 'text-[7.5px]'
                              : routeLen > 36
                                ? 'text-[8.5px]'
                                : routeLen > 24
                                  ? 'text-[9.5px]'
                                  : 'text-[10.5px]'
                          }`}
                        />
                      </td>

                      {/* Opening KM */}
                      <td className="p-0.5 border-r-2 border-black align-middle">
                        <input 
                          type="number" 
                          value={row.openingKm || ''} 
                          onChange={e => updateRow(idx, { openingKm: Number(e.target.value) })} 
                          placeholder="0"
                          className="w-full px-1 py-0.5 bg-transparent border-none focus:outline-none font-black font-mono text-center text-[10.5px] [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none m-0" 
                        />
                      </td>

                      {/* Closing KM */}
                      <td className="p-0.5 border-r-2 border-black align-middle">
                        <input 
                          type="number" 
                          value={row.closingKm || ''} 
                          onChange={e => updateRow(idx, { closingKm: Number(e.target.value) })} 
                          placeholder="0"
                          className="w-full px-1 py-0.5 bg-transparent border-none focus:outline-none font-black font-mono text-center text-[10.5px] [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none m-0" 
                        />
                      </td>

                      {/* KM (Auto calculated: Closing KM - Opening KM) */}
                      <td className="p-1 border-r-2 border-black text-center font-mono font-black text-blue-800 bg-slate-50/70 align-middle">
                        {row.km || 0}
                      </td>

                      {/* Amount (Manual Input - No arrows) */}
                      <td className="p-0.5 border-r-2 border-black align-middle">
                        <input 
                          type="number" 
                          value={row.amount || ''} 
                          onChange={e => updateRow(idx, { amount: e.target.value === '' ? 0 : Number(e.target.value) })} 
                          placeholder="0"
                          className="w-full px-1 py-0.5 bg-transparent border-none focus:outline-none font-black font-mono text-center text-[10.5px] [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none m-0" 
                        />
                      </td>

                      {/* Other Expenses (No arrows) */}
                      <td className="p-0.5 border-r-2 border-black align-middle">
                        <input 
                          type="number" 
                          value={row.otherExpenses || ''} 
                          onChange={e => updateRow(idx, { otherExpenses: Number(e.target.value) })} 
                          placeholder="0"
                          className="w-full px-1 py-0.5 bg-transparent border-none focus:outline-none font-black font-mono text-center text-[10.5px] [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none m-0" 
                        />
                      </td>

                      {/* Subtotal (Amount + Other Expenses) */}
                      <td className="p-1 text-center font-mono font-black text-emerald-800 bg-emerald-50/50 align-middle whitespace-nowrap">
                        <span className="inline-flex items-center justify-center gap-0.5 whitespace-nowrap tabular-nums">
                          ₹ {row.subtotal ? row.subtotal.toFixed(2) : '0.00'}
                        </span>
                      </td>
                    </tr>
                  );
                })}

                {/* Table Total Summary Row */}
                <tr className="bg-slate-900 text-white font-black text-xs uppercase border-t-2 border-black">
                  <td colSpan={3} className="p-2 text-center tracking-tight border-r-2 border-black font-black whitespace-nowrap">
                    TOTAL
                  </td>
                  <td className="p-2 text-center border-r-2 border-black font-mono font-black whitespace-nowrap">-</td>
                  <td className="p-2 text-center border-r-2 border-black font-mono font-black whitespace-nowrap">-</td>
                  <td className="p-2 text-center border-r-2 border-black font-mono font-black whitespace-nowrap">{sheet.totalKm}</td>
                  <td className="p-2 text-center border-r-2 border-black font-mono font-black whitespace-nowrap">
                    <span className="inline-flex items-center justify-center gap-0.5 whitespace-nowrap tabular-nums">
                      ₹ {sheet.totalAmount.toFixed(2)}
                    </span>
                  </td>
                  <td className="p-2 text-center border-r-2 border-black font-mono font-black whitespace-nowrap">
                    <span className="inline-flex items-center justify-center gap-0.5 whitespace-nowrap tabular-nums">
                      ₹ {sheet.totalOtherExpenses.toFixed(2)}
                    </span>
                  </td>
                  <td className="p-2 text-center font-mono font-black bg-red-600 text-white whitespace-nowrap">
                    <span className="inline-flex items-center justify-center gap-0.5 whitespace-nowrap tabular-nums">
                      ₹ {sheet.subtotalAmount.toFixed(2)}
                    </span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          {/* 5. Bottom Calculation & Summary Section (Exact options: Subtotal, Total Expenses Amount) */}
          <div className="border-t-2 border-black bg-white grid grid-cols-2 divide-x-2 divide-black text-[12px] font-black">
            
            {/* Subtotal */}
            <div className="p-3 bg-slate-50 flex flex-col items-center justify-center text-center">
              <span className="text-[10px] text-slate-700 uppercase tracking-tight">Subtotal</span>
              <span className="text-base font-mono text-slate-900 font-black mt-0.5 whitespace-nowrap inline-flex items-center justify-center gap-1 tabular-nums">
                <span>₹</span>
                <span>{sheet.subtotalAmount.toFixed(2)}</span>
              </span>
            </div>

            {/* Total Expenses Amount */}
            <div className="p-3 bg-red-50 flex flex-col items-center justify-center text-center">
              <span className="text-[10px] text-red-700 uppercase tracking-tight">Total Expenses Amount</span>
              <span className="text-lg font-mono text-red-700 font-black mt-0.5 whitespace-nowrap inline-flex items-center justify-center gap-1 tabular-nums">
                <span>₹</span>
                <span>{sheet.totalExpensesAmount.toFixed(2)}</span>
              </span>
            </div>
          </div>

          {/* 6. Signatures Footer */}
          <div className="p-4 bg-white border-t-2 border-black flex justify-between items-end">
            <div className="text-center w-64 max-w-[48%]">
              <div className="min-h-[40px] flex items-center justify-center p-1">
                <span className="text-[11px] font-black text-slate-800 uppercase break-words leading-tight text-center">
                  {sheet.officerName}
                </span>
              </div>
              <div className="border-t-2 border-black pt-1">
                <span className="font-black text-black uppercase text-[10px]">Officer Signature</span>
              </div>
            </div>

            <div className="text-center w-64 max-w-[48%]">
              <div className="min-h-[40px] flex items-center justify-center p-1">
                <span className="text-[11px] font-black text-slate-800 uppercase">DIRECTOR / MD</span>
              </div>
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
