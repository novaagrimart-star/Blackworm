import React, { useState, useEffect } from 'react';
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
  History
} from 'lucide-react';

interface OrderItem {
  id: string;
  orderNumber: string;
  dealerName: string;
  farmerName: string;
  totalAmount: number;
  paidAmount: number;
  balanceAmount: number;
  paymentMode: string;
  status: 'pending' | 'confirmed' | 'delivered' | 'collected';
  ownerId: string;
  createdByName: string;
  createdAt: string;
  isArchived?: boolean;
}

interface Props {
  profile: UserProfile;
  lang: Language;
}

export const CollectionView: React.FC<Props> = ({ profile, lang }) => {
  const t = translations[lang];
  const [orders, setOrders] = useState<OrderItem[]>([]);
  const [search, setSearch] = useState('');
  const [showPayModal, setShowPayModal] = useState(false);
  const [selectedOrder, setSelectedOrder] = useState<OrderItem | null>(null);

  // Mobile back button integration for payment modal
  useEffect(() => {
    if (showPayModal) {
      window.history.pushState({ tab: 'collection', payModalOpen: true }, '');
      const handlePopState = () => {
        setShowPayModal(false);
      };
      window.addEventListener('popstate', handlePopState);
      return () => {
        window.removeEventListener('popstate', handlePopState);
      };
    }
  }, [showPayModal]);

  // Pay Form
  const [amountToPay, setAmountToPay] = useState('');
  const [payMode, setPayMode] = useState('UPI / QR');

  useEffect(() => {
    const q = query(collection(db, 'orders'));
    const unsub = onSnapshot(q, (snap) => {
      const list: OrderItem[] = [];
      snap.forEach(d => {
        const data = d.data() as OrderItem;
        if (!data.isArchived) list.push({ ...data, id: d.id });
      });
      setOrders(list);
    });
    return () => unsub();
  }, []);

  const handlePayment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedOrder) return;

    const payVal = Number(amountToPay) || 0;
    const newPaid = selectedOrder.paidAmount + payVal;
    const newBalance = selectedOrder.totalAmount - newPaid;
    
    const status = newBalance <= 0 ? 'collected' : selectedOrder.status;

    await updateDoc(doc(db, 'orders', selectedOrder.id), {
      paidAmount: newPaid,
      balanceAmount: newBalance,
      status: status,
      updatedAt: new Date().toISOString(),
    });

    // Create a specific collection entry for daily tracking
    const colEntryRef = doc(collection(db, 'collection_entries'));
    await setDoc(colEntryRef, {
      id: colEntryRef.id,
      orderId: selectedOrder.id,
      orderNumber: selectedOrder.orderNumber,
      dealerName: selectedOrder.dealerName,
      amount: payVal,
      paymentMode: payMode,
      ownerId: profile.uid,
      userId: profile.uid,
      loginId: profile.loginId || '',
      collectedByUid: profile.uid,
      collectedByName: profile.fullName || 'Officer',
      date: new Date().toISOString().slice(0, 10),
      createdAt: new Date().toISOString()
    });

    await logAudit('UPDATE', 'orders', selectedOrder.id, `Payment received: ₹${payVal} via ${payMode}. New Balance: ₹${newBalance}`, profile);

    setShowPayModal(false);
    setSelectedOrder(null);
    setAmountToPay('');
  };

  const filtered = orders.filter(o => {
    // Data Isolation: Admin sees all; Non-admin strictly sees only their own data!
    if (!isUserRecord(o, profile)) return false;

    const matchSearch = o.dealerName.toLowerCase().includes(search.toLowerCase()) || o.orderNumber.toLowerCase().includes(search.toLowerCase());
    return matchSearch;
  });

  return (
    <div className="space-y-6">
      <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-900 flex items-center gap-2">
            <IndianRupee className="w-6 h-6 text-emerald-600" />
            {t.collections}
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">Track payments and manage outstanding balances</p>
        </div>
      </div>

      <div className="relative">
        <Search className="w-4 h-4 absolute left-3 top-3 text-slate-400" />
        <input
          type="text"
          placeholder="Search by Order ID or Dealer..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full pl-9 pr-4 py-2.5 rounded-xl border border-slate-200 bg-white text-xs focus:outline-none"
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {filtered.map(o => (
          <div key={o.id} className="bg-white rounded-2xl border border-slate-200 p-4 sm:p-5 shadow-sm space-y-3">
            <div className="flex justify-between items-start gap-2">
              <div className="min-w-0 flex-1">
                <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest block">
                  Order: {o.orderNumber}
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
              <div className="text-xs sm:text-sm font-black text-rose-600">
                Balance: ₹{o.balanceAmount.toLocaleString()}
              </div>
              {o.balanceAmount > 0 && (
                <button
                  onClick={() => { setSelectedOrder(o); setShowPayModal(true); }}
                  className="px-2 py-0.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded text-[10px] font-bold uppercase transition flex items-center gap-1 shadow-2xs active:scale-95 cursor-pointer shrink-0"
                  title="Receive Payment"
                >
                  <Plus className="w-3 h-3" />
                  <span>Receive Payment</span>
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      {showPayModal && selectedOrder && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl max-w-md w-full p-6 shadow-2xl border border-slate-100 max-h-[90vh] overflow-y-auto">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-lg font-bold text-slate-900">Receive Payment</h3>
              <button onClick={() => setShowPayModal(false)} className="text-slate-400 hover:text-slate-600"><X className="w-5 h-5" /></button>
            </div>

            <div className="mb-6 p-4 bg-slate-50 rounded-2xl border border-slate-100">
              <p className="text-[10px] text-slate-400 uppercase font-bold">Collecting from</p>
              <h4 className="text-sm font-bold text-slate-800">{selectedOrder.dealerName}</h4>
              <div className="flex justify-between mt-2 text-xs">
                <span>Outstanding:</span>
                <span className="font-bold text-rose-600">₹{selectedOrder.balanceAmount.toLocaleString()}</span>
              </div>
            </div>

            <form onSubmit={handlePayment} className="space-y-4">
              <div>
                <label className="text-xs font-semibold text-slate-700 block mb-1">Payment Amount (₹) *</label>
                <input
                  type="number"
                  required
                  autoFocus
                  max={selectedOrder.balanceAmount}
                  value={amountToPay}
                  onChange={(e) => setAmountToPay(e.target.value)}
                  className="w-full px-3 py-2.5 border-2 border-slate-100 rounded-xl text-sm font-bold focus:border-emerald-500 focus:outline-none transition-colors"
                />
              </div>

              <div>
                <label className="text-xs font-semibold text-slate-700 block mb-1">Payment Mode</label>
                <select
                  value={payMode}
                  onChange={(e) => setPayMode(e.target.value)}
                  className="w-full px-3 py-2 border rounded-xl text-xs focus:outline-none"
                >
                  <option value="UPI / QR">UPI / QR Code</option>
                  <option value="Cash">Cash</option>
                  <option value="Cheque">Cheque</option>
                  <option value="Bank Transfer">Bank Transfer</option>
                </select>
              </div>

              <button
                type="submit"
                className="w-full py-3 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-sm font-bold shadow-lg transition flex items-center justify-center gap-2 mt-4"
              >
                <CheckCircle className="w-4 h-4" />
                <span>Confirm Collection</span>
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
