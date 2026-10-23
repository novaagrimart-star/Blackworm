import React, { useState, useEffect, useMemo, useRef } from 'react';
import { 
  collection, 
  query, 
  where,
  orderBy,
  limit,
  onSnapshot, 
  doc, 
  setDoc,
  updateDoc
} from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../../firebase';
import { UserProfile, isAdmin, isUserRecord } from '../../lib/auth';
import { logAudit } from '../../lib/dataService';
import { Language, translations } from '../../lib/i18n';
import { cn } from '../../lib/utils';
import { useBranding } from '../../lib/branding';
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
  Mail,
  Receipt,
  Pencil
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
  updatedAt?: string;
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
  createdByUid?: string;
  created_by_user_id?: string;
  createdByName?: string;
  created_by_name?: string;
  officerName?: string;
  loginId?: string;
  userCode?: string;
  userId?: string;
  ownerId?: string;
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
  updatedAt?: string;
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
  const { logoUrl } = useBranding();
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

  // Edit Receipt Modal States
  const [showEditReceiptModal, setShowEditReceiptModal] = useState<boolean>(false);
  const [editingReceipt, setEditingReceipt] = useState<CollectionRecord | null>(null);
  const [editAmount, setEditAmount] = useState<string>('');
  const [editPaymentMode, setEditPaymentMode] = useState<string>('Cash');
  const [editReferenceNo, setEditReferenceNo] = useState<string>('');
  const [editBankName, setEditBankName] = useState<string>('');
  const [editDate, setEditDate] = useState<string>('');
  const [editRemarks, setEditRemarks] = useState<string>('');

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
    let q = query(
      collection(db, 'orders'),
      orderBy('createdAt', 'desc'),
      limit(300)
    );

    if (!isAdmin(profile)) {
      q = query(
        collection(db, 'orders'),
        where('userId', '==', profile.uid),
        orderBy('createdAt', 'desc'),
        limit(200)
      );
    }

    const unsub = onSnapshot(q, (snap) => {
      const list: OrderItem[] = [];
      snap.forEach((d) => {
        const data = d.data() as OrderItem;
        if (!data.isArchived) {
          list.push({ ...data, id: d.id });
        }
      });
      setOrders(list);
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, 'orders');
    });
    return () => unsub();
  }, []);

  // Real-time listener for Dealers Application with full ownership metadata
  useEffect(() => {
    let q = query(
      collection(db, 'dealers_application'),
      orderBy('createdAt', 'desc'),
      limit(300)
    );

    if (!isAdmin(profile)) {
      q = query(
        collection(db, 'dealers_application'),
        where('userId', '==', profile.uid),
        orderBy('createdAt', 'desc'),
        limit(200)
      );
    }

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
            isArchived: data.isArchived || false,
            createdByUid: data.createdByUid || data.created_by_user_id,
            created_by_user_id: data.created_by_user_id,
            createdByName: data.createdByName || data.created_by_name,
            created_by_name: data.created_by_name,
            officerName: data.officerName,
            loginId: data.loginId,
            userCode: data.userCode,
            userId: data.userId,
            ownerId: data.ownerId
          });
        }
      });
      setDealers(list);
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, 'dealers_application');
    });
    return () => unsub();
  }, []);

  // Real-time listener for Collection Entries
  useEffect(() => {
    let q = query(
      collection(db, 'collection_entries'),
      orderBy('createdAt', 'desc'),
      limit(500)
    );

    if (!isAdmin(profile)) {
      q = query(
        collection(db, 'collection_entries'),
        where('collectedByUid', '==', profile.uid),
        orderBy('createdAt', 'desc'),
        limit(300)
      );
    }

    const unsub = onSnapshot(q, (snap) => {
      const list: CollectionRecord[] = [];
      snap.forEach((d) => {
        const data = d.data() as CollectionRecord;
        list.push({ ...data, id: d.id });
      });
      setCollectionEntries(list);
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, 'collection_entries');
    });
    return () => unsub();
  }, []);

  // User-wise Data Security: isolate officers while preserving Admin/Owner full visibility
  const accessibleDealers = useMemo(() => {
    if (isAdmin(profile)) return dealers;
    return dealers.filter(d => isUserRecord(d, profile));
  }, [dealers, profile]);

  const accessibleOrders = useMemo(() => {
    if (isAdmin(profile)) return orders;
    return orders.filter(o => isUserRecord(o, profile));
  }, [orders, profile]);

  const accessibleCollectionEntries = useMemo(() => {
    if (isAdmin(profile)) return collectionEntries;
    return collectionEntries.filter(e => isUserRecord(e, profile));
  }, [collectionEntries, profile]);

  // Calculate Standing Amounts per Dealer strictly within authorized scope
  const dealersStandingList: DealerStandingItem[] = useMemo(() => {
    const map = new Map<string, DealerStandingItem>();

    // 1. Initialize from accessible registered dealers
    accessibleDealers.forEach((dlr) => {
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

    // 2. Aggregate orders strictly from authorized accessible orders
    accessibleOrders.forEach((ord) => {
      const dealerNameClean = (ord.dealerName || '').trim();
      const key = dealerNameClean.toUpperCase();
      if (!key) return;

      let item = map.get(key);
      if (!item) {
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
  }, [accessibleDealers, accessibleOrders, filterStandingOnly, search, sortBy]);

  // Overall Totals strictly reflecting user-accessible records
  const { totalStanding, totalCollected, totalBilled } = useMemo(() => {
    let standing = 0;
    let paid = 0;
    let billed = 0;

    accessibleOrders.forEach((o) => {
      standing += Number(o.balanceAmount) || 0;
      paid += Number(o.paidAmount) || 0;
      billed += Number(o.totalAmount) || 0;
    });

    return { totalStanding: standing, totalCollected: paid, totalBilled: billed };
  }, [accessibleOrders]);

  // Selected dealer for modal
  const currentSelectedDealer = useMemo(() => {
    if (!selectedDealerId) return null;
    return dealersStandingList.find(d => d.id === selectedDealerId || d.firmName === selectedDealerId) || null;
  }, [selectedDealerId, dealersStandingList]);

  // Open Receive Payment Modal
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
      const firstWithStanding = dealersStandingList.find(d => d.standingAmount > 0) || dealersStandingList[0];
      if (firstWithStanding) {
        setSelectedDealerId(firstWithStanding.id);
        setPaymentAmount(firstWithStanding.standingAmount > 0 ? String(firstWithStanding.standingAmount) : '');
      } else {
        setSelectedDealerId('');
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

  const handleSelectDealerInModal = (dealerKey: string) => {
    setSelectedDealerId(dealerKey);
    const target = dealersStandingList.find(d => d.id === dealerKey || d.firmName === dealerKey);
    if (target && target.standingAmount > 0) {
      setPaymentAmount(String(target.standingAmount));
    } else {
      setPaymentAmount('');
    }
  };

  // Submit payment
  const handleSubmitPayment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;

    const payVal = Number(paymentAmount) || 0;
    if (payVal <= 0) {
      alert('Please enter a valid payment amount');
      return;
    }

    if (!selectedDealerId) {
      alert('Please select a party/dealer');
      return;
    }

    const dealerObj = currentSelectedDealer || dealersStandingList.find(d => d.id === selectedDealerId || d.firmName === selectedDealerId);
    const firmName = dealerObj?.firmName || selectedDealerId;
    const dealerCode = dealerObj?.dealerCode || '';

    setIsSubmitting(true);
    try {
      // 1. Distribute across oldest pending orders (FIFO)
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

      // 2. Create receipt in collection_entries
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

      // 3. Audit Log
      await logAudit(
        'CREATE',
        'collection_entries',
        colEntryRef.id,
        `Payment received: ₹${payVal} from ${firmName} via ${paymentMode}${referenceNo ? ` (Ref: ${referenceNo})` : ''}`,
        profile
      );

      setShowReceivePaymentModal(false);
      setSuccessToast(`Payment of ₹${payVal.toLocaleString()} recorded successfully for ${firmName}!`);
      setTimeout(() => setSuccessToast(''), 4000);
    } catch (err: any) {
      console.error('Payment saving error:', err);
      alert('Error saving payment: ' + (err.message || err));
    } finally {
      setIsSubmitting(false);
    }
  };

  // Delete Receipt and Revert Balances
  const handleDeleteReceipt = async (entry: CollectionRecord) => {
    if (!isAdmin(profile)) return;
    if (!window.confirm(`Are you sure you want to delete this payment receipt of ₹${entry.amount.toLocaleString()}? This will revert the balance on the associated orders.`)) return;

    try {
      // 1. Revert balances on orders (LIFO - Newest paid first)
      let amountToRevert = Number(entry.amount) || 0;
      
      const dealerOrders = orders
        .filter(o => {
          const match = (o.dealerName || '').trim().toUpperCase() === entry.dealerName.trim().toUpperCase() ||
                        (o.dealerId && entry.dealerId && o.dealerId === entry.dealerId);
          return match && o.paidAmount > 0;
        })
        .sort((a, b) => (b.updatedAt || b.createdAt || '').localeCompare(a.updatedAt || a.createdAt || ''));

      for (const ord of dealerOrders) {
        if (amountToRevert <= 0) break;

        const currentPaid = ord.paidAmount || 0;
        const currentBal = ord.balanceAmount || 0;
        const revertVal = Math.min(amountToRevert, currentPaid);

        const newPaid = Math.max(0, currentPaid - revertVal);
        const newBal = currentBal + revertVal;
        // If it was collected, and now has balance, move back to pending/delivered
        // Simple logic: if newBal > 0 and status was 'collected', set to 'delivered' (or whatever makes sense)
        const newStatus = newBal > 0 && ord.status === 'collected' ? 'delivered' : ord.status;

        await updateDoc(doc(db, 'orders', ord.id), {
          paidAmount: newPaid,
          balanceAmount: newBal,
          status: newStatus,
          updatedAt: new Date().toISOString()
        });

        amountToRevert -= revertVal;
      }

      // 2. Delete the record
      await updateDoc(doc(db, 'collection_entries', entry.id), {
        isArchived: true, // Prefer soft delete if possible, but let's see if we should deleteDoc
      });
      // Actually, since we don't have isArchived filter in the listener, let's delete it
      // Wait, let's just delete the doc to keep it simple as requested
      const { deleteDoc } = await import('firebase/firestore');
      await deleteDoc(doc(db, 'collection_entries', entry.id));

      // 3. Audit Log
      await logAudit(
        'DELETE',
        'collection_entries',
        entry.id,
        `Payment receipt deleted: ₹${entry.amount} from ${entry.dealerName}`,
        profile
      );

      setSuccessToast(`Receipt for ₹${entry.amount.toLocaleString()} deleted and balances reverted.`);
      setTimeout(() => setSuccessToast(''), 4000);
    } catch (err: any) {
      console.error('Delete error:', err);
      alert('Error deleting receipt: ' + (err.message || err));
    }
  };

  const handleOpenEditReceipt = (entry: CollectionRecord) => {
    if (!isAdmin(profile)) return;
    setEditingReceipt(entry);
    setEditAmount(String(entry.amount));
    setEditPaymentMode(entry.paymentMode || 'Cash');
    setEditReferenceNo(entry.referenceNo || '');
    setEditBankName(entry.bankName || '');
    setEditDate(entry.date || new Date().toISOString().slice(0, 10));
    setEditRemarks(entry.notes || '');
    setShowEditReceiptModal(true);
  };

  const handleUpdateReceipt = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingReceipt || isSubmitting) return;

    const oldVal = Number(editingReceipt.amount) || 0;
    const newVal = Number(editAmount) || 0;
    const diff = newVal - oldVal;

    setIsSubmitting(true);
    try {
      if (diff !== 0) {
        // If amount changed, we need to adjust orders
        if (diff > 0) {
          // Additional payment - FIFO
          let remaining = diff;
          const dealerOrders = orders
            .filter(o => {
              const match = (o.dealerName || '').trim().toUpperCase() === editingReceipt.dealerName.trim().toUpperCase() ||
                            (o.dealerId && editingReceipt.dealerId && o.dealerId === editingReceipt.dealerId);
              return match && o.balanceAmount > 0;
            })
            .sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));

          for (const ord of dealerOrders) {
            if (remaining <= 0) break;
            const deduction = Math.min(remaining, ord.balanceAmount);
            await updateDoc(doc(db, 'orders', ord.id), {
              paidAmount: ord.paidAmount + deduction,
              balanceAmount: ord.balanceAmount - deduction,
              status: (ord.balanceAmount - deduction) <= 0 ? 'collected' : ord.status,
              updatedAt: new Date().toISOString()
            });
            remaining -= deduction;
          }
        } else {
          // Reduced payment - LIFO
          let toRevert = Math.abs(diff);
          const dealerOrders = orders
            .filter(o => {
              const match = (o.dealerName || '').trim().toUpperCase() === editingReceipt.dealerName.trim().toUpperCase() ||
                            (o.dealerId && editingReceipt.dealerId && o.dealerId === editingReceipt.dealerId);
              return match && o.paidAmount > 0;
            })
            .sort((a, b) => (b.updatedAt || b.createdAt || '').localeCompare(a.updatedAt || a.createdAt || ''));

          for (const ord of dealerOrders) {
            if (toRevert <= 0) break;
            const revertVal = Math.min(toRevert, ord.paidAmount);
            const newBal = ord.balanceAmount + revertVal;
            await updateDoc(doc(db, 'orders', ord.id), {
              paidAmount: ord.paidAmount - revertVal,
              balanceAmount: newBal,
              status: newBal > 0 && ord.status === 'collected' ? 'delivered' : ord.status,
              updatedAt: new Date().toISOString()
            });
            toRevert -= revertVal;
          }
        }
      }

      // Update the receipt record
      await updateDoc(doc(db, 'collection_entries', editingReceipt.id), {
        amount: newVal,
        paymentMode: editPaymentMode,
        referenceNo: editReferenceNo.trim(),
        bankName: editBankName.trim(),
        date: editDate,
        notes: editRemarks.trim(),
        updatedAt: new Date().toISOString()
      });

      await logAudit(
        'UPDATE',
        'collection_entries',
        editingReceipt.id,
        `Payment receipt updated for ${editingReceipt.dealerName}. Amount: ₹${oldVal} -> ₹${newVal}`,
        profile
      );

      setShowEditReceiptModal(false);
      setSuccessToast(`Receipt for ${editingReceipt.dealerName} updated successfully.`);
      setTimeout(() => setSuccessToast(''), 4000);
    } catch (err: any) {
      console.error('Update error:', err);
      alert('Error updating receipt: ' + (err.message || err));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handlePrintSheet = () => {
    window.print();
  };

  return (
    <div className="space-y-4 pb-20">
      {/* Print Styles: Single-page clean sheet */}
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
      <div className="bg-white p-3 sm:p-4 rounded-2xl border border-slate-200 shadow-xs flex flex-wrap sm:flex-nowrap items-center justify-between gap-2.5 sm:gap-3 no-print">
        <div className="flex items-center gap-2 sm:gap-2.5 min-w-0">
          <div className="w-8 h-8 sm:w-10 sm:h-10 rounded-xl bg-emerald-50 text-emerald-700 flex items-center justify-center shrink-0 border border-emerald-200">
            <IndianRupee className="w-4 h-4 sm:w-5 sm:h-5 stroke-[2.5]" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 sm:gap-2">
              <h2 className="text-base sm:text-lg font-black text-slate-900 tracking-tight">
                Collections
              </h2>
              <span className="bg-emerald-100 text-emerald-800 text-[10px] sm:text-[11px] font-mono font-bold px-1.5 py-0.5 rounded-full shrink-0">
                ₹{totalStanding.toLocaleString()}
              </span>
            </div>
          </div>
        </div>

        {/* Action Buttons: Sleek & Compact '+ Receive Payment' and 'Print Sheet' */}
        <div className="flex items-center gap-1.5 shrink-0 ml-auto">
          <button
            type="button"
            onClick={() => handleOpenReceivePayment()}
            className="flex items-center justify-center gap-1 bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800 text-white font-bold text-xs px-2.5 py-1.5 rounded-lg shadow-2xs transition active:scale-95 cursor-pointer whitespace-nowrap"
            title="Receive Payment"
          >
            <Plus className="w-3.5 h-3.5 stroke-[3]" />
            <span>Receive Payment</span>
          </button>

          <button
            type="button"
            onClick={handlePrintSheet}
            className="flex items-center justify-center gap-1 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold text-xs px-2.5 py-1.5 rounded-lg border border-slate-200 shadow-2xs transition active:scale-95 cursor-pointer whitespace-nowrap"
            title="Print Sheet"
          >
            <Printer className="w-3.5 h-3.5 text-slate-600" />
            <span className="hidden sm:inline">Print Sheet</span>
          </button>
        </div>
      </div>

      {/* Success Notification */}
      {successToast && (
        <div className="p-3 bg-emerald-50 border border-emerald-200 text-emerald-900 text-xs rounded-xl flex items-center justify-between no-print animate-fade-in shadow-2xs font-semibold">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
            <span>{successToast}</span>
          </div>
          <button onClick={() => setSuccessToast('')} className="text-emerald-700 hover:text-emerald-900">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Overview Stat Cards - Strictly English */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 no-print">
        <div className="bg-white p-3.5 rounded-xl border border-rose-200 shadow-2xs flex items-center justify-between">
          <div>
            <span className="text-[10.5px] font-bold text-rose-600 uppercase tracking-wider block">
              Standing Due
            </span>
            <div className="text-xl font-black font-mono text-rose-700 mt-0.5">
              ₹{totalStanding.toLocaleString()}
            </div>
          </div>
          <div className="w-9 h-9 rounded-lg bg-rose-50 text-rose-600 flex items-center justify-center">
            <Clock className="w-4 h-4" />
          </div>
        </div>

        <div className="bg-white p-3.5 rounded-xl border border-emerald-200 shadow-2xs flex items-center justify-between">
          <div>
            <span className="text-[10.5px] font-bold text-emerald-600 uppercase tracking-wider block">
              Collected Amount
            </span>
            <div className="text-xl font-black font-mono text-emerald-700 mt-0.5">
              ₹{totalCollected.toLocaleString()}
            </div>
          </div>
          <div className="w-9 h-9 rounded-lg bg-emerald-50 text-emerald-600 flex items-center justify-center">
            <CheckCircle className="w-4 h-4" />
          </div>
        </div>

        <div className="bg-white p-3.5 rounded-xl border border-slate-200 shadow-2xs flex items-center justify-between">
          <div>
            <span className="text-[10.5px] font-bold text-slate-500 uppercase tracking-wider block">
              Total Billed
            </span>
            <div className="text-xl font-black font-mono text-slate-900 mt-0.5">
              ₹{totalBilled.toLocaleString()}
            </div>
          </div>
          <div className="w-9 h-9 rounded-lg bg-slate-100 text-slate-700 flex items-center justify-center">
            <Building2 className="w-4 h-4" />
          </div>
        </div>
      </div>

      {/* Tabs & Search Bar - Strictly English */}
      <div className="bg-white p-2.5 rounded-xl border border-slate-200 shadow-2xs flex flex-col md:flex-row md:items-center justify-between gap-2.5 no-print">
        {/* Navigation Tabs */}
        <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg shrink-0 overflow-x-auto">
          <button
            type="button"
            onClick={() => setActiveTab('sheet')}
            className={cn(
              "px-3 py-1.5 rounded-md text-xs font-bold transition cursor-pointer flex items-center gap-1.5 whitespace-nowrap",
              activeTab === 'sheet'
                ? "bg-slate-900 text-white shadow-2xs"
                : "text-slate-600 hover:text-slate-900"
            )}
          >
            <FileText className="w-3.5 h-3.5" />
            <span>Dealer Standing Sheet</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('receipts')}
            className={cn(
              "px-3 py-1.5 rounded-md text-xs font-bold transition cursor-pointer flex items-center gap-1.5 whitespace-nowrap",
              activeTab === 'receipts'
                ? "bg-slate-900 text-white shadow-2xs"
                : "text-slate-600 hover:text-slate-900"
            )}
          >
            <History className="w-3.5 h-3.5" />
            <span>Payment Receipts ({collectionEntries.length})</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('orders')}
            className={cn(
              "px-3 py-1.5 rounded-md text-xs font-bold transition cursor-pointer flex items-center gap-1.5 whitespace-nowrap",
              activeTab === 'orders'
                ? "bg-slate-900 text-white shadow-2xs"
                : "text-slate-600 hover:text-slate-900"
            )}
          >
            <CreditCard className="w-3.5 h-3.5" />
            <span>Order Details</span>
          </button>
        </div>

        {/* Search & Filter */}
        <div className="flex items-center gap-2 flex-1 max-w-md">
          <div className="relative flex-1">
            <Search className="w-3.5 h-3.5 absolute left-3 top-2.5 text-slate-400" />
            <input
              type="text"
              placeholder="Search dealer by name, code or location..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-8 pr-3 py-1.5 rounded-lg border border-slate-200 bg-slate-50 focus:bg-white text-xs font-medium focus:outline-none focus:ring-1 focus:ring-emerald-500"
            />
          </div>

          {activeTab === 'sheet' && (
            <button
              type="button"
              onClick={() => setFilterStandingOnly(!filterStandingOnly)}
              className={cn(
                "px-2.5 py-1.5 rounded-lg text-xs font-bold border transition cursor-pointer shrink-0 flex items-center gap-1",
                filterStandingOnly
                  ? "bg-rose-50 border-rose-200 text-rose-700 shadow-2xs"
                  : "bg-slate-50 border-slate-200 text-slate-600 hover:bg-slate-100"
              )}
              title="Toggle standing filter"
            >
              <Filter className="w-3 h-3" />
              <span>{filterStandingOnly ? 'Due Only' : 'All Dealers'}</span>
            </button>
          )}
        </div>
      </div>

      {/* ======================= TAB 1: DEALER STANDING SHEET ======================= */}
      {activeTab === 'sheet' && (
        <div className="w-full overflow-x-auto rounded-xl border-2 border-black shadow-md bg-white">
          <div 
            ref={printableSheetRef}
            id="dealer-standing-sheet"
            className="min-w-[700px] sm:min-w-[780px] bg-white"
          >
            {/* Printable Letterhead Header */}
            <div className="p-3 sm:p-3.5 bg-white border-b-2 border-black">
              <div className="flex items-center justify-between gap-3 sm:gap-4">
                <div className="w-12 h-12 sm:w-14 sm:h-14 flex items-center justify-center shrink-0">
                  <img src={logoUrl || "/logo.jpg"} alt="Logo" className="w-10 h-10 sm:w-12 sm:h-12 object-contain" />
                </div>

                <div className="flex-1 text-center space-y-0.5">
                  <h1 className="text-lg sm:text-2xl font-black text-red-600 uppercase tracking-tight leading-none whitespace-nowrap">
                    BLACKWORM AGRITECH PVT LTD
                  </h1>
                  <div className="text-[7.5px] sm:text-[8px] text-slate-700 font-bold leading-tight mt-1 whitespace-nowrap">
                    <p>CIN : U01409PN2022PTC217246, GST No. 27AALCB3069J1ZC</p>
                    <p>Address - Gat No. 17 Vijaynagar (Mhaisal), Tal - Miraj, Dist - Sangli. 416409.</p>
                    <p className="flex items-center justify-center gap-3 sm:gap-4 mt-0.5">
                      <span className="flex items-center gap-1 text-red-600"><Phone className="w-2.5 h-2.5" /> +91 7798716201</span>
                      <span className="flex items-center gap-1 text-red-600 underline"><Mail className="w-2.5 h-2.5" /> blackwormagritechpvtltd@gmail.com</span>
                    </p>
                  </div>
                </div>

                <div className="w-16 sm:w-20 h-12 sm:h-14 flex flex-col items-center justify-center border border-black bg-emerald-50 shrink-0 p-1">
                  <span className="text-[7px] sm:text-[7.5px] font-black uppercase text-emerald-800 text-center leading-tight">
                    COLLECTION STATEMENT
                  </span>
                  <span className="text-[8.5px] sm:text-[9.5px] font-mono font-black text-slate-900 mt-0.5 whitespace-nowrap">
                    {new Date().toLocaleDateString('en-GB')}
                  </span>
                </div>
              </div>
            </div>

            {/* Statement Sub-banner - Strictly English */}
            <div className="bg-slate-900 text-white font-black px-3 sm:px-4 py-2 flex items-center justify-between border-b-2 border-black text-xs uppercase tracking-wider whitespace-nowrap">
              <span>DEALER STANDING AMOUNT STATEMENT</span>
              <span className="font-mono text-emerald-400">
                Total Standing: ₹{totalStanding.toLocaleString()}
              </span>
            </div>

            {/* The Clean Sheet Table - Strictly English */}
            <table className="w-full text-left text-xs border-collapse">
              <thead>
                <tr className="bg-slate-100 text-black font-black uppercase text-[10px] sm:text-[10.5px] border-b-2 border-black">
                  <th className="p-2 border-r border-black w-10 text-center whitespace-nowrap">Sr.</th>
                  <th className="p-2 border-r border-black w-24 font-mono whitespace-nowrap">Dealer Code</th>
                  <th className="p-2 border-r border-black min-w-[220px] sm:min-w-[280px] whitespace-nowrap">Dealer / Firm Name</th>
                  <th className="p-2 border-r border-black min-w-[120px] whitespace-nowrap">Contact Number</th>
                  <th className="p-2 border-r border-black text-right min-w-[130px] sm:min-w-[140px] bg-rose-50/70 font-mono whitespace-nowrap">
                    Standing Due (₹)
                  </th>
                  <th className="p-2 text-center w-24 no-print whitespace-nowrap">Action</th>
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
                    <td className="p-2 border-r border-black text-center font-mono font-bold whitespace-nowrap">
                      {index + 1}
                    </td>

                    <td className="p-2 border-r border-black font-mono font-bold text-red-600 whitespace-nowrap">
                      {item.dealerCode ? `#${item.dealerCode}` : '-'}
                    </td>

                    <td className="p-2 border-r border-black font-bold text-slate-900 uppercase whitespace-nowrap">
                      <div className="flex items-center gap-1.5 truncate">
                        <span className="truncate">{item.firmName}</span>
                      </div>
                    </td>

                    <td className="p-2 border-r border-black uppercase text-slate-700 whitespace-nowrap">
                      {item.contactNumber ? (
                        <a 
                          href={`tel:${item.contactNumber}`} 
                          className="text-blue-600 font-bold hover:underline flex items-center gap-1"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <Phone className="w-3 h-3" />
                          {item.contactNumber}
                        </a>
                      ) : '-'}
                    </td>

                    <td className="p-2 border-r border-black text-right font-mono font-bold text-xs bg-rose-50/40 whitespace-nowrap">
                      <span className={cn(
                        "px-2 py-0.5 rounded",
                        item.standingAmount > 0 
                          ? "text-rose-700 font-black bg-rose-100/70 border border-rose-300" 
                          : "text-emerald-700 bg-emerald-50"
                      )}>
                        ₹{item.standingAmount.toLocaleString()}
                      </span>
                    </td>

                    {/* Action: Receive Payment (Compact) */}
                    <td className="p-1 text-center no-print whitespace-nowrap">
                      {item.standingAmount > 0 ? (
                        <button
                          type="button"
                          onClick={() => handleOpenReceivePayment(item.id)}
                          className="px-2 py-1 bg-emerald-600 hover:bg-emerald-700 text-white rounded-md text-[10px] font-bold uppercase transition shadow-2xs active:scale-95 cursor-pointer inline-flex items-center gap-1 whitespace-nowrap"
                          title={`Receive payment from ${item.firmName}`}
                        >
                          <Plus className="w-3 h-3 stroke-[3]" />
                          <span>Receive</span>
                        </button>
                      ) : (
                        <span className="text-[10px] font-bold text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded border border-emerald-200 whitespace-nowrap">
                          Paid
                        </span>
                      )}
                    </td>
                  </tr>
                ))}

                {dealersStandingList.length === 0 && (
                  <tr>
                    <td colSpan={6} className="p-6 text-center text-slate-400 font-medium">
                      No dealer records found.
                    </td>
                  </tr>
                )}
              </tbody>

              {/* Total Footer Row */}
              <tfoot>
                <tr className="bg-slate-900 text-white font-black text-xs border-t-2 border-black whitespace-nowrap">
                  <td colSpan={4} className="p-2.5 text-right uppercase tracking-wider">
                    TOTAL STANDING AMOUNT:
                  </td>
                  <td className="p-2.5 text-right font-mono font-black text-emerald-400 text-sm">
                    ₹{totalStanding.toLocaleString()}
                  </td>
                  <td className="p-2.5 no-print"></td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      {/* ======================= TAB 2: PAYMENT RECEIPTS ======================= */}
      {activeTab === 'receipts' && (
        <div className="bg-white rounded-xl border border-slate-200 shadow-xs overflow-hidden">
          <div className="p-3 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
            <h3 className="text-xs font-black text-slate-900 uppercase">
              Payment Receipts History
            </h3>
            <span className="text-xs font-bold text-slate-500">
              Total: {accessibleCollectionEntries.length} Records
            </span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs border-collapse">
              <thead>
                <tr className="bg-slate-100 text-slate-700 font-bold uppercase text-[10.5px] border-b border-slate-200">
                  <th className="p-2.5 w-10 text-center">Sr.</th>
                  <th className="p-2.5 w-24">Date</th>
                  <th className="p-2.5">Dealer / Firm Name</th>
                  <th className="p-2.5 w-24">Mode</th>
                  <th className="p-2.5">Ref / Cheque No.</th>
                  <th className="p-2.5 text-right w-28 bg-emerald-50/50 font-mono">Amount (₹)</th>
                  <th className="p-2.5 min-w-[120px]">Collected By</th>
                  {isAdmin(profile) && <th className="p-2.5 w-20 text-center no-print">Actions</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 font-medium">
                {collectionEntries.map((entry, idx) => (
                  <tr key={entry.id} className="hover:bg-slate-50/80 transition">
                    <td className="p-2.5 text-center font-mono font-bold text-slate-400">
                      {idx + 1}
                    </td>
                    <td className="p-2.5 font-mono font-bold text-slate-700 whitespace-nowrap">
                      {entry.date}
                    </td>
                    <td className="p-2.5 font-bold text-slate-900 uppercase">
                      {entry.dealerName}
                    </td>
                    <td className="p-2.5">
                      <span className="px-2 py-0.5 rounded text-[10px] font-bold uppercase bg-slate-100 text-slate-800 border border-slate-200">
                        {entry.paymentMode}
                      </span>
                    </td>
                    <td className="p-2.5 text-slate-600 font-mono text-[11px]">
                      {entry.referenceNo || entry.bankName ? (
                        <span>
                          {entry.referenceNo || '-'}
                          {entry.bankName ? ` (${entry.bankName})` : ''}
                        </span>
                      ) : (
                        '-'
                      )}
                    </td>
                    <td className="p-2.5 text-right font-mono font-bold text-emerald-700 text-xs bg-emerald-50/40">
                      ₹{Number(entry.amount || 0).toLocaleString()}
                    </td>
                    <td className="p-2.5 text-slate-700 font-medium uppercase text-[11px]">
                      {entry.collectedByName || 'Officer'}
                    </td>
                    {isAdmin(profile) && (
                      <td className="p-2.5 no-print">
                        <div className="flex items-center justify-center gap-2">
                          <button
                            onClick={() => handleOpenEditReceipt(entry)}
                            className="p-1.5 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition"
                            title="Edit Receipt"
                          >
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={() => handleDeleteReceipt(entry)}
                            className="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition"
                            title="Delete Receipt"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </td>
                    )}
                  </tr>
                ))}

                {accessibleCollectionEntries.length === 0 && (
                  <tr>
                    <td colSpan={7} className="p-8 text-center text-slate-400 font-medium">
                      No payment receipts recorded yet. Click "Receive Payment" to add one.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ======================= TAB 3: ORDER DETAILS ======================= */}
      {activeTab === 'orders' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {accessibleOrders
            .filter(o => {
              if (!search.trim()) return true;
              const q = search.toLowerCase().trim();
              return (
                o.dealerName.toLowerCase().includes(q) ||
                o.orderNumber.toLowerCase().includes(q)
              );
            })
            .map((o) => (
              <div key={o.id} className="bg-white rounded-xl border border-slate-200 p-3.5 shadow-2xs space-y-2.5">
                <div className="flex justify-between items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <span className="text-[10px] font-mono font-bold text-slate-400 uppercase tracking-widest block">
                      Order: #{o.orderNumber}
                    </span>
                    <h3 className="text-sm font-bold text-slate-900 truncate" title={o.dealerName}>
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

                <div className="grid grid-cols-2 gap-2 text-center text-xs">
                  <div className="bg-slate-50 p-2 rounded-lg">
                    <span className="text-[10px] text-slate-400 block uppercase font-bold">Total Bill</span>
                    <span className="font-bold text-slate-900">₹{o.totalAmount.toLocaleString()}</span>
                  </div>
                  <div className="bg-emerald-50 p-2 rounded-lg">
                    <span className="text-[10px] text-emerald-600 block uppercase font-bold">Received</span>
                    <span className="font-bold text-emerald-700">₹{o.paidAmount.toLocaleString()}</span>
                  </div>
                </div>

                <div className="flex justify-between items-center pt-1">
                  <div className="text-xs font-bold text-rose-600 font-mono">
                    Balance: ₹{o.balanceAmount.toLocaleString()}
                  </div>
                  {o.balanceAmount > 0 && (
                    <button
                      onClick={() => handleOpenReceivePayment(o.dealerId || o.dealerName)}
                      className="px-2 py-1 bg-emerald-600 hover:bg-emerald-700 text-white rounded-md text-[10px] font-bold uppercase transition flex items-center gap-1 shadow-2xs active:scale-95 cursor-pointer shrink-0"
                      title="Receive Payment"
                    >
                      <Plus className="w-3 h-3 stroke-[3]" />
                      <span>Receive</span>
                    </button>
                  )}
                </div>
              </div>
            ))}
        </div>
      )}

      {/* ======================= RECEIVE PAYMENT MODAL (ATTRACTIVE & SIMPLE) ======================= */}
      {showReceivePaymentModal && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-3 sm:p-4 backdrop-blur-xs animate-in fade-in">
          <div className="bg-white rounded-2xl max-w-md w-full p-5 shadow-2xl border border-slate-200 max-h-[92vh] overflow-y-auto space-y-4">
            
            {/* Modal Header - Sleek & Modern */}
            <div className="flex justify-between items-center pb-3 border-b border-slate-100">
              <div className="flex items-center gap-2.5">
                <div className="w-9 h-9 rounded-xl bg-emerald-50 text-emerald-700 flex items-center justify-center shrink-0 border border-emerald-200">
                  <Receipt className="w-4 h-4 stroke-[2.5]" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-slate-900 leading-tight">
                    Receive Payment
                  </h3>
                  <span className="text-[11px] text-slate-500 font-medium">
                    Record dealer payment collection
                  </span>
                </div>
              </div>
              <button 
                type="button" 
                onClick={() => setShowReceivePaymentModal(false)} 
                className="text-slate-400 hover:text-slate-600 p-1 rounded-lg hover:bg-slate-100 transition cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleSubmitPayment} className="space-y-3.5">
              {/* 1. SELECT PARTY / DEALER */}
              <div>
                <label className="text-xs font-bold text-slate-700 block mb-1">
                  Select Party / Dealer *
                </label>
                <select
                  required
                  value={selectedDealerId}
                  onChange={(e) => handleSelectDealerInModal(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-xs font-bold text-slate-900 bg-white focus:border-emerald-500 focus:outline-none transition-colors"
                >
                  <option value="">-- Select Party / Dealer --</option>
                  {dealersStandingList.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.firmName} {d.dealerCode ? `(#${d.dealerCode})` : ''} - Due: ₹{d.standingAmount.toLocaleString()}
                    </option>
                  ))}
                </select>
              </div>

              {/* Outstanding Due Badge */}
              {currentSelectedDealer && (
                <div className="p-2.5 bg-rose-50 border border-rose-200 rounded-lg flex items-center justify-between">
                  <div>
                    <span className="text-[10px] font-bold text-rose-500 uppercase tracking-wider block">
                      Current Standing Due
                    </span>
                    <span className="font-mono font-black text-rose-700 text-sm">
                      ₹{currentSelectedDealer.standingAmount.toLocaleString()}
                    </span>
                  </div>
                  {currentSelectedDealer.standingAmount > 0 && (
                    <button
                      type="button"
                      onClick={() => setPaymentAmount(String(currentSelectedDealer.standingAmount))}
                      className="px-2 py-1 bg-white hover:bg-rose-100 text-rose-700 border border-rose-300 rounded-md text-[10px] font-bold transition cursor-pointer shadow-2xs"
                    >
                      Pay Full Due
                    </button>
                  )}
                </div>
              )}

              {/* 2. PAYMENT MODE */}
              <div>
                <label className="text-xs font-bold text-slate-700 block mb-1">
                  Payment Mode *
                </label>
                <div className="grid grid-cols-4 gap-1.5">
                  {['Cash', 'Cheque', 'NEFT / RTGS', 'UPI / QR'].map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => setPaymentMode(mode)}
                      className={cn(
                        "py-1.5 px-1 rounded-lg text-xs font-bold border transition cursor-pointer text-center",
                        paymentMode === mode
                          ? "bg-slate-900 text-white border-slate-900 shadow-2xs"
                          : "bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100"
                      )}
                    >
                      {mode}
                    </button>
                  ))}
                </div>
              </div>

              {/* 3. PAYMENT AMOUNT */}
              <div>
                <label className="text-xs font-bold text-slate-700 block mb-1">
                  Amount Received (₹) *
                </label>
                <div className="relative">
                  <IndianRupee className="w-3.5 h-3.5 absolute left-3 top-2.5 text-slate-400" />
                  <input
                    type="number"
                    required
                    min="1"
                    step="any"
                    placeholder="e.g. 50000"
                    value={paymentAmount}
                    onChange={(e) => setPaymentAmount(e.target.value)}
                    className="w-full pl-8 pr-3 py-2 border border-slate-300 rounded-lg text-sm font-bold text-slate-900 focus:border-emerald-500 focus:outline-none transition-colors"
                  />
                </div>
              </div>

              {/* 4. CHEQUE / NEFT DETAILS */}
              {(paymentMode === 'Cheque' || paymentMode === 'NEFT / RTGS') && (
                <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg space-y-2.5">
                  <div>
                    <label className="text-[11px] font-bold text-slate-700 block mb-1">
                      {paymentMode === 'Cheque' ? 'Cheque Number *' : 'NEFT / UTR Reference No. *'}
                    </label>
                    <input
                      type="text"
                      required
                      placeholder={paymentMode === 'Cheque' ? "e.g. 458921" : "e.g. UTR123456789"}
                      value={referenceNo}
                      onChange={(e) => setReferenceNo(e.target.value)}
                      className="w-full px-2.5 py-1.5 border border-slate-300 rounded-md text-xs font-bold text-slate-900 bg-white focus:outline-none focus:border-emerald-500"
                    />
                  </div>

                  <div>
                    <label className="text-[11px] font-bold text-slate-700 block mb-1">
                      Bank Name (Optional)
                    </label>
                    <input
                      type="text"
                      placeholder="e.g. SBI Bank / HDFC"
                      value={bankName}
                      onChange={(e) => setBankName(e.target.value)}
                      className="w-full px-2.5 py-1.5 border border-slate-300 rounded-md text-xs font-bold text-slate-900 bg-white focus:outline-none focus:border-emerald-500"
                    />
                  </div>
                </div>
              )}

              {/* 5. PAYMENT DATE & COLLECTED BY */}
              <div className="grid grid-cols-2 gap-2.5">
                <div>
                  <label className="text-[11px] font-bold text-slate-700 block mb-1">
                    Payment Date *
                  </label>
                  <input
                    type="date"
                    required
                    value={paymentDate}
                    onChange={(e) => setPaymentDate(e.target.value)}
                    className="w-full px-2.5 py-1.5 border border-slate-300 rounded-lg text-xs font-bold text-slate-900 focus:outline-none focus:border-emerald-500"
                  />
                </div>

                <div>
                  <label className="text-[11px] font-bold text-slate-700 block mb-1">
                    Received By
                  </label>
                  <input
                    type="text"
                    disabled
                    value={profile.fullName || 'Officer'}
                    className="w-full px-2.5 py-1.5 border border-slate-200 rounded-lg text-xs font-bold text-slate-500 bg-slate-100"
                  />
                </div>
              </div>

              {/* 6. REMARKS / NOTES */}
              <div>
                <label className="text-[11px] font-bold text-slate-700 block mb-1">
                  Notes / Remarks
                </label>
                <input
                  type="text"
                  placeholder="e.g. Partial payment / clearance"
                  value={remarks}
                  onChange={(e) => setRemarks(e.target.value)}
                  className="w-full px-2.5 py-1.5 border border-slate-300 rounded-lg text-xs font-medium text-slate-900 focus:outline-none focus:border-emerald-500"
                />
              </div>

              {/* Submit Button - Sleek & Compact */}
              <div className="pt-1.5">
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="w-full py-2.5 bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800 disabled:bg-emerald-400 text-white rounded-xl text-xs font-bold shadow-sm transition flex items-center justify-center gap-2 cursor-pointer active:scale-95"
                >
                  {isSubmitting ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      <span>Saving payment...</span>
                    </>
                  ) : (
                    <>
                      <CheckCircle className="w-3.5 h-3.5" />
                      <span>Save Payment</span>
                    </>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ======================= EDIT RECEIPT MODAL (ADMIN ONLY) ======================= */}
      {showEditReceiptModal && editingReceipt && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-3 sm:p-4 backdrop-blur-xs animate-in fade-in">
          <div className="bg-white rounded-2xl max-w-md w-full p-5 shadow-2xl border border-slate-200 max-h-[92vh] overflow-y-auto space-y-4">
            <div className="flex justify-between items-center pb-3 border-b border-slate-100">
              <div className="flex items-center gap-2.5">
                <div className="w-9 h-9 rounded-xl bg-blue-50 text-blue-700 flex items-center justify-center shrink-0 border border-blue-200">
                  <Pencil className="w-4 h-4 stroke-[2.5]" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-slate-900 leading-tight">Edit Payment Receipt</h3>
                  <span className="text-[11px] text-slate-500 font-medium">Update receipt details for {editingReceipt.dealerName}</span>
                </div>
              </div>
              <button type="button" onClick={() => setShowEditReceiptModal(false)} className="text-slate-400 hover:text-slate-600 p-1 rounded-lg hover:bg-slate-100 transition">
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleUpdateReceipt} className="space-y-3.5">
              <div className="bg-slate-50 p-2.5 rounded-lg border border-slate-200">
                <div className="text-[10px] font-bold text-slate-400 uppercase">Party Name</div>
                <div className="text-sm font-black text-slate-900 uppercase">{editingReceipt.dealerName}</div>
              </div>

              <div>
                <label className="text-xs font-bold text-slate-700 block mb-1">Payment Amount (₹) *</label>
                <div className="relative">
                  <IndianRupee className="w-3.5 h-3.5 absolute left-3 top-2.5 text-slate-400" />
                  <input
                    type="number"
                    required
                    step="any"
                    value={editAmount}
                    onChange={(e) => setEditAmount(e.target.value)}
                    placeholder="0.00"
                    className="w-full pl-8 pr-3 py-2 border border-slate-300 rounded-lg text-sm font-black text-slate-900 focus:border-blue-500 focus:outline-none transition-colors"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-bold text-slate-700 block mb-1">Payment Mode *</label>
                  <select
                    value={editPaymentMode}
                    onChange={(e) => setEditPaymentMode(e.target.value)}
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg text-xs font-bold text-slate-900 focus:border-blue-500 focus:outline-none"
                  >
                    <option value="Cash">Cash</option>
                    <option value="Cheque">Cheque</option>
                    <option value="RTGS/NEFT">RTGS/NEFT</option>
                    <option value="UPI / GPay">UPI / GPay</option>
                    <option value="Online Transfer">Online Transfer</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs font-bold text-slate-700 block mb-1">Payment Date *</label>
                  <input
                    type="date"
                    required
                    value={editDate}
                    onChange={(e) => setEditDate(e.target.value)}
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg text-xs font-bold text-slate-900 focus:border-blue-500 focus:outline-none"
                  />
                </div>
              </div>

              {(editPaymentMode !== 'Cash' && editPaymentMode !== 'UPI / GPay') && (
                <div className="grid grid-cols-2 gap-3 animate-in slide-in-from-top-1">
                  <div>
                    <label className="text-xs font-bold text-slate-700 block mb-1">Ref / Cheque No.</label>
                    <input
                      type="text"
                      value={editReferenceNo}
                      onChange={(e) => setEditReferenceNo(e.target.value)}
                      placeholder="Enter Number"
                      className="w-full px-3 py-2 border border-slate-300 rounded-lg text-xs font-bold text-slate-900 focus:border-blue-500 focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="text-xs font-bold text-slate-700 block mb-1">Bank Name</label>
                    <input
                      type="text"
                      value={editBankName}
                      onChange={(e) => setEditBankName(e.target.value)}
                      placeholder="Enter Bank"
                      className="w-full px-3 py-2 border border-slate-300 rounded-lg text-xs font-bold text-slate-900 focus:border-blue-500 focus:outline-none"
                    />
                  </div>
                </div>
              )}

              <div>
                <label className="text-xs font-bold text-slate-700 block mb-1">Remarks (Optional)</label>
                <textarea
                  value={editRemarks}
                  onChange={(e) => setEditRemarks(e.target.value)}
                  placeholder="Any internal notes..."
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg text-xs font-medium text-slate-900 focus:border-blue-500 focus:outline-none h-16 resize-none"
                />
              </div>

              <div className="pt-2 flex gap-3">
                <button
                  type="button"
                  onClick={() => setShowEditReceiptModal(false)}
                  className="flex-1 px-4 py-2.5 border border-slate-200 text-slate-600 rounded-xl text-xs font-bold hover:bg-slate-50 transition active:scale-95"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="flex-1 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 text-white px-4 py-2.5 rounded-xl text-xs font-bold shadow-lg shadow-blue-200 transition active:scale-95 flex items-center justify-center gap-2"
                >
                  {isSubmitting ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Update Receipt'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
