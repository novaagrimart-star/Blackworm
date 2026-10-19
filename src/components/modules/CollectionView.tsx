import React, { useState, useEffect, useMemo, useRef } from 'react';
import { 
  collection, 
  query, 
  onSnapshot, 
  doc, 
  setDoc,
  updateDoc
} from 'firebase/firestore';
import { db } from '../../firebase';
import { UserProfile, isAdmin, isUserRecord } from '../../lib/auth';
import { logAudit } from '../../lib/dataService';
import { Language, translations } from '../../lib/i18n';
import { cn } from '../../lib/utils';
import { 
  IndianRupee, 
  Search, 
  Plus, 
  CheckCircle, 
  Clock, 
  Trash2, 
  X,
  CreditCard,
  History,
  Printer,
  Building2,
  User,
  Calendar,
  FileText,
  CheckCircle2,
  ChevronRight,
  ArrowUpDown,
  Filter,
  AlertCircle,
  Loader2,
  Phone,
  Mail
} from 'lucide-react';

interface OrderItem {
  id: string;
  orderNumber: string;
  dealerId?: string;
  dealerName: string;
  dealerCode?: string;
  farmerName?: string;
  totalAmount: number;
  paidAmount: number;
  balanceAmount: number;
  paymentMode: string;
  status: 'pending' | 'confirmed' | 'delivered' | 'collected' | 'pending_approval';
  ownerId?: string;
  userId?: string;
  loginId?: string;
  createdByName?: string;
  createdAt: string;
  isArchived?: boolean;
}

interface SavedDealer {
  id: string;
  firmName: string;
  proprietorName?: string;
  dealerCode?: string;
  contactNumber?: string;
  village?: string;
  district?: string;
  isArchived?: boolean;
}

interface CollectionRecord {
  id: string;
  orderId?: string;
  orderNumber?: string;
  dealerId?: string;
  dealerName: string;
  dealerCode?: string;
  amount: number;
  paymentMode: string;
  referenceNo?: string;
  bankName?: string;
  date: string;
  notes?: string;
  collectedByUid?: string;
  collectedByName?: string;
  createdAt: string;
}

interface DealerStandingItem {
  id: string;
  firmName: string;
  dealerCode: string;
  village: string;
  proprietorName: string;
  contactNumber: string;
  totalBilled: number;
  totalPaid: number;
  standingAmount: number;
  ordersCount: number;
  orders: OrderItem[];
}

interface Props {
  profile: UserProfile;
  lang: Language;
}

export const CollectionView: React.FC<Props> = ({ profile, lang }) => {
  const t = translations[lang];
  const [orders, setOrders] = useState<OrderItem[]>([]);
  const [dealers, setDealers] = useState<SavedDealer[]>([]);
  const [collectionEntries, setCollectionEntries] = useState<CollectionRecord[]>([]);
  const [search, setSearch] = useState('');
  const [activeTab, setActiveTab] = useState<'sheet' | 'receipts' | 'orders'>('sheet');
  const [sortBy, setSortBy] = useState<'standing_desc' | 'standing_asc' | 'name_asc'>('standing_desc');
  const [filterStandingOnly, setFilterStandingOnly] = useState<boolean>(true);

  // Receive Payment Modal States
  const [showReceivePaymentModal, setShowReceivePaymentModal] = useState<boolean>(false);
  const [selectedDealerId, setSelectedDealerId] = useState<string>('');
  const [paymentMode, setPaymentMode] = useState<string>('Cash');
  const [paymentAmount, setPaymentAmount] = useState<string>('');
  const [referenceNo, setReferenceNo] = useState<string>('');
  const [bankName, setBankName] = useState<string>('');
  const [paymentDate, setPaymentDate] = useState<string>(new Date().toISOString().slice(0, 10));
  const [remarks, setRemarks] = useState<string>('');
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [successToast, setSuccessToast] = useState<string>('');

  const printableSheetRef = useRef<HTMLDivElement>(null);

  // Mobile back button integration
  useEffect(() => {
    if (showReceivePaymentModal) {
      window.history.pushState({ tab: 'collection', modalOpen: true }, '');
      const handlePopState = () => {
        setShowReceivePaymentModal(false);
      };
      window.addEventListener('popstate', handlePopState);
      return () => {
        window.removeEventListener('popstate', handlePopState);
      };
    }
  }, [showReceivePaymentModal]);

  // Real-time listener for Orders
  useEffect(() => {
    const q = query(collection(db, 'orders'));
    const unsub = onSnapshot(q, (snap) => {
      const list: OrderItem[] = [];
      snap.forEach((d) => {
        const data = d.data() as OrderItem;
        if (!data.isArchived) {
          list.push({ ...data, id: d.id });
        }
      });
      setOrders(list);
    });
    return () => unsub();
  }, []);

  // Real-time listener for Dealers Application
  useEffect(() => {
    const q = query(collection(db, 'dealers_application'));
    const unsub = onSnapshot(q, (snap) => {
      const list: SavedDealer[] = [];
      snap.forEach((d) => {
        const data = d.data() as any;
        if (!data.isArchived) {
          list.push({
            id: d.id,
            firmName: data.firmName || 'Unnamed Firm',
            proprietorName: data.proprietorName || '',
            dealerCode: data.dealerCode || '',
            contactNumber: data.contactNumber || '',
            village: data.village || data.center || '',
            district: data.district || '',
            isArchived: data.isArchived || false
          });
        }
      });
      setDealers(list);
    });
    return () => unsub();
  }, []);

  // Real-time listener for Collection Entries
  useEffect(() => {
    const q = query(collection(db, 'collection_entries'));
    const unsub = onSnapshot(q, (snap) => {
      const list: CollectionRecord[] = [];
      snap.forEach((d) => {
        const data = d.data() as CollectionRecord;
        list.push({ ...data, id: d.id });
      });
      list.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
      setCollectionEntries(list);
    });
    return () => unsub();
  }, []);

  // Calculate Standing Amounts per Dealer
  const dealersStandingList: DealerStandingItem[] = useMemo(() => {
    // Map of dealer firmName (or id) -> DealerStandingItem
    const map = new Map<string, DealerStandingItem>();

    // 1. Initialize from all registered dealers
    dealers.forEach((dlr) => {
      const key = (dlr.firmName || '').trim().toUpperCase();
      if (!key) return;
      map.set(key, {
        id: dlr.id,
        firmName: dlr.firmName,
        dealerCode: dlr.dealerCode || '',
        village: dlr.village || '',
        proprietorName: dlr.proprietorName || '',
        contactNumber: dlr.contactNumber || '',
        totalBilled: 0,
        totalPaid: 0,
        standingAmount: 0,
        ordersCount: 0,
        orders: []
      });
    });

    // 2. Aggregate orders
    orders.forEach((ord) => {
      // Permission check: Non-admin only aggregates their own records
      if (!isUserRecord(ord, profile)) return;

      const dealerNameClean = (ord.dealerName || '').trim();
      const key = dealerNameClean.toUpperCase();
      if (!key) return;

      let item = map.get(key);
      if (!item) {
        // Dealer not yet in map (e.g. historical order without separate dealer application doc)
        item = {
          id: ord.dealerId || `dealer_${key}`,
          firmName: ord.dealerName,
          dealerCode: ord.dealerCode || '',
          village: (ord as any).dealerVillage || '',
          proprietorName: ord.farmerName || '',
          contactNumber: (ord as any).dealerContact || '',
          totalBilled: 0,
          totalPaid: 0,
          standingAmount: 0,
          ordersCount: 0,
          orders: []
        };
        map.set(key, item);
      }

      item.totalBilled += Number(ord.totalAmount) || 0;
      item.totalPaid += Number(ord.paidAmount) || 0;
      item.standingAmount += Number(ord.balanceAmount) || 0;
      item.ordersCount += 1;
      item.orders.push(ord);

      if (!item.dealerCode && ord.dealerCode) {
        item.dealerCode = ord.dealerCode;
      }
    });

    let result = Array.from(map.values());

    // Filter standing only if requested
    if (filterStandingOnly) {
      result = result.filter(d => d.standingAmount > 0);
    }

    // Search filter
    if (search.trim()) {
      const q = search.toLowerCase().trim();
      result = result.filter(d => 
        d.firmName.toLowerCase().includes(q) ||
        d.dealerCode.toLowerCase().includes(q) ||
        d.village.toLowerCase().includes(q) ||
        d.proprietorName.toLowerCase().includes(q)
      );
    }

    // Sorting
    result.sort((a, b) => {
      if (sortBy === 'standing_desc') {
        return b.standingAmount - a.standingAmount || a.firmName.localeCompare(b.firmName);
      }
      if (sortBy === 'standing_asc') {
        return a.standingAmount - b.standingAmount || a.firmName.localeCompare(b.firmName);
      }
      return a.firmName.localeCompare(b.firmName);
    });

    return result;
  }, [dealers, orders, profile, filterStandingOnly, search, sortBy]);

  // Overall Totals
  const { totalStanding, totalCollected, totalBilled } = useMemo(() => {
    let standing = 0;
    let paid = 0;
    let billed = 0;

    orders.forEach((o) => {
      if (!isUserRecord(o, profile)) return;
      standing += Number(o.balanceAmount) || 0;
      paid += Number(o.paidAmount) || 0;
      billed += Number(o.totalAmount) || 0;
    });

    return { totalStanding: standing, totalCollected: paid, totalBilled: billed };
  }, [orders, profile]);

  // Get Selected Dealer details for Receive Payment Modal
  const currentSelectedDealer = useMemo(() => {
    if (!selectedDealerId) return null;
    return dealersStandingList.find(d => d.id === selectedDealerId || d.firmName === selectedDealerId) || null;
  }, [selectedDealerId, dealersStandingList]);

  // Handle open receive payment modal
  const handleOpenReceivePayment = (dealerId?: string) => {
    if (dealerId) {
      setSelectedDealerId(dealerId);
      const target = dealersStandingList.find(d => d.id === dealerId || d.firmName === dealerId);
      if (target && target.standingAmount > 0) {
        setPaymentAmount(String(target.standingAmount));
      } else {
        setPaymentAmount('');
      }
    } else {
      setSelectedDealerId(dealersStandingList[0]?.id || '');
      if (dealersStandingList[0]?.standingAmount > 0) {
        setPaymentAmount(String(dealersStandingList[0].standingAmount));
      } else {
        setPaymentAmount('');
      }
    }
    setPaymentMode('Cash');
    setReferenceNo('');
    setBankName('');
    setRemarks('');
    setPaymentDate(new Date().toISOString().slice(0, 10));
    setShowReceivePaymentModal(true);
  };

  // When dealer dropdown changes in modal
  const handleSelectDealerInModal = (dealerKey: string) => {
    setSelectedDealerId(dealerKey);
    const target = dealersStandingList.find(d => d.id === dealerKey || d.firmName === dealerKey);
    if (target && target.standingAmount > 0) {
      setPaymentAmount(String(target.standingAmount));
    } else {
      setPaymentAmount('');
    }
  };

  // Submit Receive Payment
  const handleSubmitPayment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;

    const payVal = Number(paymentAmount) || 0;
    if (payVal <= 0) {
      alert('कृपया वैध रक्कम टाका (Please enter a valid amount)');
      return;
    }

    if (!selectedDealerId) {
      alert('कृपया पार्टी / डीलर निवडा (Please select a party/dealer)');
      return;
    }

    const dealerObj = currentSelectedDealer || dealersStandingList.find(d => d.id === selectedDealerId || d.firmName === selectedDealerId);
    const firmName = dealerObj?.firmName || selectedDealerId;
    const dealerCode = dealerObj?.dealerCode || '';

    setIsSubmitting(true);
    try {
      // 1. Distribute payment across dealer's active orders (FIFO: oldest pending orders first)
      let remainingPayment = payVal;
      const dealerOrders = orders
        .filter(o => {
          const match = (o.dealerName || '').trim().toUpperCase() === firmName.trim().toUpperCase() ||
                        (o.dealerId && dealerObj?.id && o.dealerId === dealerObj.id);
          return match && o.balanceAmount > 0;
        })
        .sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));

      for (const ord of dealerOrders) {
        if (remainingPayment <= 0) break;

        const currentBal = ord.balanceAmount || 0;
        const currentPaid = ord.paidAmount || 0;
        const deduction = Math.min(remainingPayment, currentBal);

        const newPaid = currentPaid + deduction;
        const newBal = Math.max(0, currentBal - deduction);
        const newStatus = newBal <= 0 ? 'collected' : ord.status;

        await updateDoc(doc(db, 'orders', ord.id), {
          paidAmount: newPaid,
          balanceAmount: newBal,
          status: newStatus,
          updatedAt: new Date().toISOString()
        });

        remainingPayment -= deduction;
      }

      // 2. Create collection receipt in collection_entries
      const colEntryRef = doc(collection(db, 'collection_entries'));
      const newEntry: CollectionRecord = {
        id: colEntryRef.id,
        dealerId: dealerObj?.id || '',
        dealerName: firmName,
        dealerCode: dealerCode,
        amount: payVal,
        paymentMode: paymentMode,
        referenceNo: referenceNo.trim(),
        bankName: bankName.trim(),
        date: paymentDate,
        notes: remarks.trim(),
        collectedByUid: profile.uid,
        collectedByName: profile.fullName || 'Officer',
        createdAt: new Date().toISOString()
      };

      await setDoc(colEntryRef, newEntry);

      // 3. Log Audit
      await logAudit(
        'CREATE',
        'collection_entries',
        colEntryRef.id,
        `Payment received: ₹${payVal} from ${firmName} via ${paymentMode}${referenceNo ? ` (Ref: ${referenceNo})` : ''}`,
        profile
      );

      // Feedback
      setShowReceivePaymentModal(false);
      setSuccessToast(`₹${payVal.toLocaleString()} पेमेंट यशस्वीरित्या जमा झाले (${firmName})!`);
      setTimeout(() => setSuccessToast(''), 5000);
    } catch (err: any) {
      console.error('Payment saving error:', err);
      alert('पेमेंट सेव्ह करताना अडचण आली: ' + (err.message || err));
    } finally {
      setIsSubmitting(false);
    }
  };

  // Print single sheet
  const handlePrintSheet = () => {
    window.print();
  };

  return (
    <div className="space-y-5 pb-20">
      {/* Print Styles: strictly forces single-page clean sheet output */}
      <style dangerouslySetInnerHTML={{ __html: `
        @media print {
          @page {
            size: A4 portrait;
            margin: 8mm;
          }
          body {
            background: white !important;
            padding: 0 !important;
            margin: 0 !important;
          }
          .no-print {
            display: none !important;
          }
          #dealer-standing-sheet {
            display: block !important;
            border: 2px solid #000 !important;
            padding: 0 !important;
            width: 100% !important;
          }
        }
      `}} />

      {/* Top Header Card */}
      <div className="bg-white p-4 sm:p-5 rounded-2xl border border-slate-200 shadow-sm flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 no-print">
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 rounded-2xl bg-emerald-50 text-emerald-700 flex items-center justify-center shrink-0 border border-emerald-200">
            <IndianRupee className="w-6 h-6 stroke-[2.5]" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-xl font-black text-slate-900 tracking-tight">
                कलेक्शन
              </h2>
              <span className="bg-emerald-100 text-emerald-800 text-[11px] font-mono font-black px-2 py-0.5 rounded-full">
                ₹{totalStanding.toLocaleString()}
              </span>
            </div>
          </div>
        </div>

        {/* Action Buttons: Prominent 'Receive Payment' right next to Collection */}
        <div className="flex items-center gap-2.5 w-full sm:w-auto">
          <button
            type="button"
            onClick={() => handleOpenReceivePayment()}
            className="flex-1 sm:flex-none flex items-center justify-center gap-2 bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800 text-white font-black text-xs px-4 py-2.5 rounded-xl shadow-md transition active:scale-95 cursor-pointer"
            title="डीलरकडून आलेले पेमेंट जमा करा"
          >
            <Plus className="w-4 h-4 stroke-[3]" />
            <span>रिसिव्ह पेमेंट (Receive Payment)</span>
          </button>

          <button
            type="button"
            onClick={handlePrintSheet}
            className="flex items-center justify-center gap-1.5 bg-slate-100 hover:bg-slate-200 text-slate-800 font-bold text-xs px-3 py-2.5 rounded-xl border border-slate-300 shadow-xs transition active:scale-95 cursor-pointer"
            title="स्टँडिंग शीट प्रिंट करा"
          >
            <Printer className="w-4 h-4 text-slate-700" />
            <span className="hidden sm:inline">शीट प्रिंट</span>
          </button>
        </div>
      </div>

      {/* Success Toast */}
      {successToast && (
        <div className="p-3 bg-emerald-50 border border-emerald-300 text-emerald-900 text-xs rounded-xl flex items-center justify-between no-print animate-fade-in shadow-xs font-bold">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
            <span>{successToast}</span>
          </div>
          <button onClick={() => setSuccessToast('')} className="text-emerald-700 hover:text-emerald-900">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Overview Stat Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 no-print">
        <div className="bg-white p-4 rounded-2xl border border-rose-200 shadow-xs flex items-center justify-between">
          <div>
            <span className="text-[11px] font-black text-rose-600 uppercase tracking-wider block">
              स्टँडिंग बाकी
            </span>
            <div className="text-xl sm:text-2xl font-black font-mono text-rose-700 mt-1">
              ₹{totalStanding.toLocaleString()}
            </div>
          </div>
          <div className="w-10 h-10 rounded-xl bg-rose-50 text-rose-600 flex items-center justify-center">
            <Clock className="w-5 h-5" />
          </div>
        </div>

        <div className="bg-white p-4 rounded-2xl border border-emerald-200 shadow-xs flex items-center justify-between">
          <div>
            <span className="text-[11px] font-black text-emerald-600 uppercase tracking-wider block">
              जमा रक्कम
            </span>
            <div className="text-xl sm:text-2xl font-black font-mono text-emerald-700 mt-1">
              ₹{totalCollected.toLocaleString()}
            </div>
          </div>
          <div className="w-10 h-10 rounded-xl bg-emerald-50 text-emerald-600 flex items-center justify-center">
            <CheckCircle className="w-5 h-5" />
          </div>
        </div>

        <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-xs flex items-center justify-between">
          <div>
            <span className="text-[11px] font-black text-slate-500 uppercase tracking-wider block">
              एकूण बिल
            </span>
            <div className="text-xl sm:text-2xl font-black font-mono text-slate-900 mt-1">
              ₹{totalBilled.toLocaleString()}
            </div>
          </div>
          <div className="w-10 h-10 rounded-xl bg-slate-100 text-slate-700 flex items-center justify-center">
            <Building2 className="w-5 h-5" />
          </div>
        </div>
      </div>

      {/* Tabs & Search Filter */}
      <div className="bg-white p-3 rounded-2xl border border-slate-200 shadow-xs flex flex-col md:flex-row md:items-center justify-between gap-3 no-print">
        {/* Tabs */}
        <div className="flex items-center gap-1.5 p-1 bg-slate-100 rounded-xl shrink-0 overflow-x-auto">
          <button
            type="button"
            onClick={() => setActiveTab('sheet')}
            className={cn(
              "px-3.5 py-1.5 rounded-lg text-xs font-black transition cursor-pointer flex items-center gap-1.5 whitespace-nowrap",
              activeTab === 'sheet'
                ? "bg-slate-900 text-white shadow-sm"
                : "text-slate-600 hover:text-slate-900"
            )}
          >
            <FileText className="w-3.5 h-3.5" />
            <span>डीलर स्टँडिंग शीट (Standing Sheet)</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('receipts')}
            className={cn(
              "px-3.5 py-1.5 rounded-lg text-xs font-black transition cursor-pointer flex items-center gap-1.5 whitespace-nowrap",
              activeTab === 'receipts'
                ? "bg-slate-900 text-white shadow-sm"
                : "text-slate-600 hover:text-slate-900"
            )}
          >
            <History className="w-3.5 h-3.5" />
            <span>पेमेंट पावती नोंदी ({collectionEntries.length})</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('orders')}
            className={cn(
              "px-3.5 py-1.5 rounded-lg text-xs font-black transition cursor-pointer flex items-center gap-1.5 whitespace-nowrap",
              activeTab === 'orders'
                ? "bg-slate-900 text-white shadow-sm"
                : "text-slate-600 hover:text-slate-900"
            )}
          >
            <CreditCard className="w-3.5 h-3.5" />
            <span>सर्व ऑर्डर्स तपशील</span>
          </button>
        </div>

        {/* Search & Filter Controls */}
        <div className="flex items-center gap-2 flex-1 max-w-lg">
          <div className="relative flex-1">
            <Search className="w-4 h-4 absolute left-3 top-2.5 text-slate-400" />
            <input
              type="text"
              placeholder="डीलरचे नाव, कोड किंवा गावाचे नाव शोधा..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-9 pr-4 py-2 rounded-xl border border-slate-200 bg-slate-50 focus:bg-white text-xs font-medium focus:outline-none focus:ring-2 focus:ring-emerald-500"
            />
          </div>

          {activeTab === 'sheet' && (
            <button
              type="button"
              onClick={() => setFilterStandingOnly(!filterStandingOnly)}
              className={cn(
                "px-3 py-2 rounded-xl text-xs font-black border transition cursor-pointer shrink-0 flex items-center gap-1",
                filterStandingOnly
                  ? "bg-rose-50 border-rose-300 text-rose-700 shadow-xs"
                  : "bg-slate-50 border-slate-200 text-slate-600 hover:bg-slate-100"
              )}
              title="फक्त थकबाकी असणारे डीलर दाखवा"
            >
              <Filter className="w-3 h-3" />
              <span>{filterStandingOnly ? 'फक्त बाकी' : 'सर्व डीलर'}</span>
            </button>
          )}
        </div>
      </div>

      {/* ======================= TAB 1: THE CLEAN ONE-PAGE STANDING SHEET ======================= */}
      {activeTab === 'sheet' && (
        <div 
          ref={printableSheetRef}
          id="dealer-standing-sheet"
          className="bg-white rounded-2xl border-2 border-black shadow-lg overflow-hidden"
        >
          {/* Printable Letterhead Header */}
          <div className="p-4 bg-white border-b-2 border-black">
            <div className="flex items-center justify-between gap-4">
              <div className="w-16 h-16 flex items-center justify-center shrink-0">
                <img src="/logo.jpg" alt="Logo" className="w-14 h-14 object-contain" />
              </div>

              <div className="flex-1 text-center space-y-0.5">
                <h1 className="text-xl sm:text-2xl font-black text-red-600 uppercase tracking-tight leading-none">
                  BLACKWORM AGRITECH PVT LTD
                </h1>
                <div className="text-[8.5px] text-slate-700 font-bold leading-tight mt-1">
                  <p>CIN : U01409PN2022PTC217246, GST No. 27AALCB3069J1ZC</p>
                  <p>Address - Gat No. 17 Vijaynagar (Mhaisal), Tal - Miraj, Dist - Sangli. 416409.</p>
                  <p className="flex items-center justify-center gap-4 mt-0.5">
                    <span className="flex items-center gap-1 text-red-600"><Phone className="w-2.5 h-2.5" /> +91 7798716201</span>
                    <span className="flex items-center gap-1 text-red-600 underline"><Mail className="w-2.5 h-2.5" /> blackwormagritechpvtltd@gmail.com</span>
                  </p>
                </div>
              </div>

              <div className="w-20 h-16 flex flex-col items-center justify-center border border-black bg-emerald-50 shrink-0 p-1">
                <span className="text-[8px] font-black uppercase text-emerald-800 text-center leading-tight">
                  COLLECTION STATEMENT
                </span>
                <span className="text-[10px] font-mono font-black text-slate-900 mt-1">
                  {new Date().toLocaleDateString('en-GB')}
                </span>
              </div>
            </div>
          </div>

          {/* Statement Sub-banner */}
          <div className="bg-slate-900 text-white font-black px-4 py-2 flex items-center justify-between border-b-2 border-black text-xs sm:text-sm uppercase tracking-wider">
            <span>डीलर वाईस स्टँडिंग रक्कम विवरण (DEALER STANDING AMOUNT STATEMENT)</span>
            <span className="font-mono text-emerald-400">
              एकूण थकबाकी: ₹{totalStanding.toLocaleString()}
            </span>
          </div>

          {/* THE CLEAN TABLE: STRICTLY DEALER NAME & STANDING AMOUNT AS REQUESTED */}
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs border-collapse">
              <thead>
                <tr className="bg-slate-100 text-black font-black uppercase text-[11px] border-b-2 border-black">
                  <th className="p-2.5 border-r border-black w-12 text-center">अ.क्र.</th>
                  <th className="p-2.5 border-r border-black w-28 font-mono">डीलर कोड</th>
                  <th className="p-2.5 border-r border-black">डीलर / फर्मचे नाव (Dealer / Firm Name)</th>
                  <th className="p-2.5 border-r border-black min-w-[120px]">गाव / केंद्र</th>
                  <th className="p-2.5 border-r border-black text-right min-w-[150px] bg-rose-50/70 font-mono">
                    स्टँडिंग रक्कम (Standing Amount ₹)
                  </th>
                  <th className="p-2.5 text-center w-36 no-print">कृती (Action)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-black/30 font-medium">
                {dealersStandingList.map((item, index) => (
                  <tr 
                    key={item.id} 
                    className={cn(
                      "transition-colors",
                      item.standingAmount > 0 ? "hover:bg-amber-50/50" : "bg-slate-50/30 text-slate-500"
                    )}
                  >
                    {/* Sr No */}
                    <td className="p-2 border-r border-black text-center font-mono font-bold">
                      {index + 1}
                    </td>

                    {/* Dealer Code */}
                    <td className="p-2 border-r border-black font-mono font-bold text-red-600">
                      {item.dealerCode ? `#${item.dealerCode}` : '-'}
                    </td>

                    {/* Dealer / Firm Name */}
                    <td className="p-2 border-r border-black font-black text-slate-900 uppercase">
                      <div className="flex items-center gap-1.5">
                        <span>{item.firmName}</span>
                        {item.proprietorName && (
                          <span className="text-[10px] text-slate-500 font-medium hidden sm:inline">
                            ({item.proprietorName})
                          </span>
                        )}
                      </div>
                    </td>

                    {/* Village / Center */}
                    <td className="p-2 border-r border-black uppercase text-slate-700">
                      {item.village || '-'}
                    </td>

                    {/* Standing Amount (स्टँडिंग रक्कम) */}
                    <td className="p-2 border-r border-black text-right font-mono font-black text-[13px] bg-rose-50/40">
                      <span className={cn(
                        "px-2 py-0.5 rounded",
                        item.standingAmount > 0 
                          ? "text-rose-700 font-black bg-rose-100/70 border border-rose-300" 
                          : "text-emerald-700 bg-emerald-50"
                      )}>
                        ₹{item.standingAmount.toLocaleString()}
                      </span>
                    </td>

                    {/* Action: Receive Payment */}
                    <td className="p-1.5 text-center no-print">
                      {item.standingAmount > 0 ? (
                        <button
                          type="button"
                          onClick={() => handleOpenReceivePayment(item.id)}
                          className="px-2.5 py-1 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-[10.5px] font-black uppercase transition shadow-2xs active:scale-95 cursor-pointer flex items-center gap-1 mx-auto"
                          title={`${item.firmName} चे पेमेंट जमा करा`}
                        >
                          <Plus className="w-3 h-3 stroke-[3]" />
                          <span>पेमेंट स्वीकारा</span>
                        </button>
                      ) : (
                        <span className="text-[10px] font-bold text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded border border-emerald-200">
                          निरंक (Paid)
                        </span>
                      )}
                    </td>
                  </tr>
                ))}

                {dealersStandingList.length === 0 && (
                  <tr>
                    <td colSpan={6} className="p-8 text-center text-slate-500 font-bold">
                      कोणतीही डीलर माहिती उपलब्ध नाही (No records found).
                    </td>
                  </tr>
                )}
              </tbody>

              {/* Total Footer Row */}
              <tfoot>
                <tr className="bg-slate-900 text-white font-black text-xs border-t-2 border-black">
                  <td colSpan={4} className="p-3 text-right uppercase tracking-wider">
                    एकूण स्टँडिंग थकबाकी रक्कम (Total Standing Amount):
                  </td>
                  <td className="p-3 text-right font-mono font-black text-emerald-400 text-sm">
                    ₹{totalStanding.toLocaleString()}
                  </td>
                  <td className="p-3 no-print"></td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      {/* ======================= TAB 2: PAYMENT RECEIPTS HISTORY ======================= */}
      {activeTab === 'receipts' && (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="p-4 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
            <h3 className="text-sm font-black text-slate-900 uppercase">
              जमा झालेल्या पेमेंट्सचा इतिहास (Payment Receipt History)
            </h3>
            <span className="text-xs font-bold text-slate-500">
              एकूण नोंदी: {collectionEntries.length}
            </span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs border-collapse">
              <thead>
                <tr className="bg-slate-100 text-slate-700 font-black uppercase text-[11px] border-b border-slate-200">
                  <th className="p-3 w-12 text-center">Sr.</th>
                  <th className="p-3 w-28">तारीख (Date)</th>
                  <th className="p-3">डीलरचे नाव (Party / Dealer)</th>
                  <th className="p-3 w-28">पद्धत (Mode)</th>
                  <th className="p-3">संदर्भ / चेक क्र. (Ref / Cheque)</th>
                  <th className="p-3 text-right w-32 bg-emerald-50/50 font-mono">जमा रक्कम (₹)</th>
                  <th className="p-3 min-w-[130px]">स्वीकारणारा अधिकारी</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 font-medium">
                {collectionEntries.map((entry, idx) => (
                  <tr key={entry.id} className="hover:bg-slate-50/80 transition">
                    <td className="p-3 text-center font-mono font-bold text-slate-400">
                      {idx + 1}
                    </td>
                    <td className="p-3 font-mono font-bold text-slate-700 whitespace-nowrap">
                      {entry.date}
                    </td>
                    <td className="p-3 font-black text-slate-900 uppercase">
                      {entry.dealerName}
                    </td>
                    <td className="p-3">
                      <span className="px-2 py-0.5 rounded text-[10px] font-black uppercase bg-slate-100 text-slate-800 border border-slate-200">
                        {entry.paymentMode}
                      </span>
                    </td>
                    <td className="p-3 text-slate-600 font-mono">
                      {entry.referenceNo || entry.bankName ? (
                        <span>
                          {entry.referenceNo || '-'}
                          {entry.bankName ? ` (${entry.bankName})` : ''}
                        </span>
                      ) : (
                        '-'
                      )}
                    </td>
                    <td className="p-3 text-right font-mono font-black text-emerald-700 text-xs bg-emerald-50/40">
                      ₹{Number(entry.amount || 0).toLocaleString()}
                    </td>
                    <td className="p-3 text-slate-700 font-bold uppercase text-[11px]">
                      {entry.collectedByName || 'Officer'}
                    </td>
                  </tr>
                ))}

                {collectionEntries.length === 0 && (
                  <tr>
                    <td colSpan={7} className="p-8 text-center text-slate-400 font-bold">
                      अद्याप कोणतीही पेमेंट पावती नोंदलेली नाही. वर दिलेल्या "रिसिव्ह पेमेंट" बटनावरून नवीन पेमेंट जोडा.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ======================= TAB 3: INDIVIDUAL ORDERS CARDS ======================= */}
      {activeTab === 'orders' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {orders
            .filter(o => isUserRecord(o, profile))
            .filter(o => {
              if (!search.trim()) return true;
              const q = search.toLowerCase().trim();
              return (
                o.dealerName.toLowerCase().includes(q) ||
                o.orderNumber.toLowerCase().includes(q)
              );
            })
            .map((o) => (
              <div key={o.id} className="bg-white rounded-2xl border border-slate-200 p-4 sm:p-5 shadow-sm space-y-3">
                <div className="flex justify-between items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <span className="text-[10px] font-mono font-bold text-slate-400 uppercase tracking-widest block">
                      Order: #{o.orderNumber}
                    </span>
                    <h3 className="text-sm sm:text-base font-black text-slate-900 mt-0.5 truncate whitespace-nowrap" title={o.dealerName}>
                      {o.dealerName}
                    </h3>
                  </div>
                  <div className={cn(
                    "px-2 py-0.5 rounded text-[10px] font-bold uppercase shrink-0",
                    o.balanceAmount <= 0 ? "bg-emerald-50 text-emerald-700 border border-emerald-200" : "bg-rose-50 text-rose-700 border border-rose-200"
                  )}>
                    {o.balanceAmount <= 0 ? 'Full Paid' : 'Outstanding'}
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="bg-slate-50 p-2.5 rounded-xl text-center">
                    <span className="text-[10px] text-slate-400 block uppercase font-bold">Total Bill</span>
                    <span className="font-bold text-slate-900 text-xs sm:text-sm">₹{o.totalAmount.toLocaleString()}</span>
                  </div>
                  <div className="bg-emerald-50 p-2.5 rounded-xl text-center">
                    <span className="text-[10px] text-emerald-600 block uppercase font-bold">Received</span>
                    <span className="font-bold text-emerald-700 text-xs sm:text-sm">₹{o.paidAmount.toLocaleString()}</span>
                  </div>
                </div>

                <div className="flex justify-between items-center py-1 px-0.5">
                  <div className="text-xs sm:text-sm font-black text-rose-600 font-mono">
                    Balance: ₹{o.balanceAmount.toLocaleString()}
                  </div>
                  {o.balanceAmount > 0 && (
                    <button
                      onClick={() => handleOpenReceivePayment(o.dealerId || o.dealerName)}
                      className="px-2.5 py-1 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-[10.5px] font-black uppercase transition flex items-center gap-1 shadow-2xs active:scale-95 cursor-pointer shrink-0"
                      title="Receive Payment"
                    >
                      <Plus className="w-3.5 h-3.5 stroke-[3]" />
                      <span>Receive Payment</span>
                    </button>
                  )}
                </div>
              </div>
            ))}
        </div>
      )}

      {/* ======================= RECEIVE PAYMENT MODAL ======================= */}
      {showReceivePaymentModal && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-3 sm:p-4 backdrop-blur-xs animate-in fade-in">
          <div className="bg-white rounded-3xl max-w-lg w-full p-5 sm:p-6 shadow-2xl border border-slate-200 max-h-[92vh] overflow-y-auto space-y-4">
            {/* Modal Header */}
            <div className="flex justify-between items-center pb-3 border-b border-slate-100">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-xl bg-emerald-100 text-emerald-700 flex items-center justify-center shrink-0">
                  <IndianRupee className="w-4 h-4 stroke-[2.5]" />
                </div>
                <div>
                  <h3 className="text-base font-black text-slate-900 leading-tight">
                    रिसिव्ह पेमेंट (Receive Payment)
                  </h3>
                  <span className="text-[11px] text-slate-500 font-medium">
                    डीलरकडून आलेले पेमेंट जमा करा
                  </span>
                </div>
              </div>
              <button 
                type="button" 
                onClick={() => setShowReceivePaymentModal(false)} 
                className="text-slate-400 hover:text-slate-600 p-1 rounded-lg hover:bg-slate-100 transition cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSubmitPayment} className="space-y-4">
              {/* 1. SELECT PARTY / DEALER (पार्टी निवडा) */}
              <div>
                <label className="text-xs font-black text-slate-800 block mb-1">
                  पार्टी / डीलर निवडा (Select Party / Dealer) *
                </label>
                <select
                  required
                  value={selectedDealerId}
                  onChange={(e) => handleSelectDealerInModal(e.target.value)}
                  className="w-full px-3 py-2.5 border-2 border-slate-200 rounded-xl text-xs font-bold text-slate-900 bg-white focus:border-emerald-500 focus:outline-none transition-colors"
                >
                  <option value="">-- डीलर / पार्टी निवडा --</option>
                  {dealersStandingList.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.firmName} {d.dealerCode ? `(#${d.dealerCode})` : ''} - बाकी: ₹{d.standingAmount.toLocaleString()}
                    </option>
                  ))}
                </select>
              </div>

              {/* Outstanding Amount Badge for Selected Party */}
              {currentSelectedDealer && (
                <div className="p-3 bg-rose-50 border border-rose-200 rounded-xl flex items-center justify-between">
                  <div>
                    <span className="text-[10px] font-black text-rose-500 uppercase tracking-wider block">
                      चालू थकबाकी रक्कम (Current Standing)
                    </span>
                    <span className="font-mono font-black text-rose-700 text-base">
                      ₹{currentSelectedDealer.standingAmount.toLocaleString()}
                    </span>
                  </div>
                  {currentSelectedDealer.standingAmount > 0 && (
                    <button
                      type="button"
                      onClick={() => setPaymentAmount(String(currentSelectedDealer.standingAmount))}
                      className="px-2.5 py-1 bg-white hover:bg-rose-100 text-rose-700 border border-rose-300 rounded-lg text-[10.5px] font-black transition cursor-pointer shadow-2xs"
                    >
                      पूर्ण थकबाकी भरा
                    </button>
                  )}
                </div>
              )}

              {/* 2. PAYMENT MODE (कॅश / चेक / एनएफटी / ऑनलाइन) */}
              <div>
                <label className="text-xs font-black text-slate-800 block mb-1">
                  पेमेंट पद्धत (Payment Mode) *
                </label>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {['Cash', 'Cheque', 'NEFT / RTGS', 'UPI / QR'].map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => setPaymentMode(mode)}
                      className={cn(
                        "py-2 px-2 rounded-xl text-xs font-black border transition cursor-pointer text-center",
                        paymentMode === mode
                          ? "bg-slate-900 text-white border-slate-900 shadow-xs"
                          : "bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100"
                      )}
                    >
                      {mode === 'Cash' ? 'कॅश (Cash)' : mode === 'Cheque' ? 'चेक (Cheque)' : mode === 'NEFT / RTGS' ? 'एनएफटी (NEFT)' : 'युपीआय / ऑनलाइन'}
                    </button>
                  ))}
                </div>
              </div>

              {/* 3. PAYMENT AMOUNT (रक्कम) */}
              <div>
                <label className="text-xs font-black text-slate-800 block mb-1">
                  जमा रक्कम (Payment Amount ₹) *
                </label>
                <div className="relative">
                  <IndianRupee className="w-4 h-4 absolute left-3 top-3 text-slate-400" />
                  <input
                    type="number"
                    required
                    min="1"
                    step="any"
                    placeholder="उदा. 50000"
                    value={paymentAmount}
                    onChange={(e) => setPaymentAmount(e.target.value)}
                    className="w-full pl-9 pr-4 py-2.5 border-2 border-slate-200 rounded-xl text-sm font-black text-slate-900 focus:border-emerald-500 focus:outline-none transition-colors"
                  />
                </div>
              </div>

              {/* 4. CHEQUE / NEFT DETAILS (If applicable) */}
              {(paymentMode === 'Cheque' || paymentMode === 'NEFT / RTGS') && (
                <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl space-y-3">
                  <div>
                    <label className="text-[11px] font-bold text-slate-700 block mb-1">
                      {paymentMode === 'Cheque' ? 'चेक नंबर (Cheque Number) *' : 'NEFT / UTR संदर्भ क्रमांक *'}
                    </label>
                    <input
                      type="text"
                      required
                      placeholder={paymentMode === 'Cheque' ? "उदा. 458921" : "उदा. UTR123456789"}
                      value={referenceNo}
                      onChange={(e) => setReferenceNo(e.target.value)}
                      className="w-full px-3 py-2 border border-slate-300 rounded-lg text-xs font-bold text-slate-900 bg-white focus:outline-none focus:border-emerald-500"
                    />
                  </div>

                  <div>
                    <label className="text-[11px] font-bold text-slate-700 block mb-1">
                      बँकेचे नाव (Bank Name)
                    </label>
                    <input
                      type="text"
                      placeholder="उदा. SBI Bank / HDFC"
                      value={bankName}
                      onChange={(e) => setBankName(e.target.value)}
                      className="w-full px-3 py-2 border border-slate-300 rounded-lg text-xs font-bold text-slate-900 bg-white focus:outline-none focus:border-emerald-500"
                    />
                  </div>
                </div>
              )}

              {/* 5. PAYMENT DATE & OFFICER */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="text-[11px] font-bold text-slate-700 block mb-1">
                    पेमेंट तारीख (Payment Date) *
                  </label>
                  <input
                    type="date"
                    required
                    value={paymentDate}
                    onChange={(e) => setPaymentDate(e.target.value)}
                    className="w-full px-3 py-2 border border-slate-200 rounded-xl text-xs font-bold text-slate-900 focus:outline-none focus:border-emerald-500"
                  />
                </div>

                <div>
                  <label className="text-[11px] font-bold text-slate-700 block mb-1">
                    पेमेंट स्वीकारणारा (Received By)
                  </label>
                  <input
                    type="text"
                    disabled
                    value={profile.fullName || 'Officer'}
                    className="w-full px-3 py-2 border border-slate-200 rounded-xl text-xs font-bold text-slate-500 bg-slate-100"
                  />
                </div>
              </div>

              {/* 6. REMARKS / NOTE */}
              <div>
                <label className="text-[11px] font-bold text-slate-700 block mb-1">
                  टीप / तपशील (Remarks / Note)
                </label>
                <input
                  type="text"
                  placeholder="उदा. दिवाळी पेमेंट / भाग रक्कम"
                  value={remarks}
                  onChange={(e) => setRemarks(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-200 rounded-xl text-xs font-medium text-slate-900 focus:outline-none focus:border-emerald-500"
                />
              </div>

              {/* Submit Button */}
              <div className="pt-2">
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="w-full py-3 bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800 disabled:bg-emerald-400 text-white rounded-xl text-xs sm:text-sm font-black shadow-lg transition flex items-center justify-center gap-2 cursor-pointer active:scale-95"
                >
                  {isSubmitting ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span>पेमेंट सेव्ह होत आहे...</span>
                    </>
                  ) : (
                    <>
                      <CheckCircle className="w-4 h-4" />
                      <span>पेमेंट सेव्ह करा (Confirm & Save Payment)</span>
                    </>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
