import React, { useState, useEffect } from 'react';
import { 
  collection, 
  query, 
  onSnapshot, 
  doc, 
  setDoc 
} from 'firebase/firestore';
import { db } from '../../firebase';
import { UserProfile, isAdmin, isUserRecord } from '../../lib/auth';
import { softDeleteRecord, logAudit } from '../../lib/dataService';
import { Language, translations } from '../../lib/i18n';
import { CustomDialogModal } from '../CustomDialogModal';
import { cn } from '../../lib/utils';
import { 
  ShoppingBag, 
  Plus, 
  Search, 
  IndianRupee, 
  CheckCircle, 
  Clock, 
  FileText, 
  Trash2, 
  X 
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
  userId?: string;
  loginId?: string;
  userCode?: string;
  createdByName: string;
  createdAt: string;
  isArchived?: boolean;
}

interface Props {
  profile: UserProfile;
  lang: Language;
}

export const OrderView: React.FC<Props> = ({ profile, lang }) => {
  const t = translations[lang];
  const [orders, setOrders] = useState<OrderItem[]>([]);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [showModal, setShowModal] = useState(false);

  // Mobile back button integration for order form modal
  useEffect(() => {
    if (showModal) {
      window.history.pushState({ tab: 'order', orderModalOpen: true }, '');
      const handlePopState = () => {
        setShowModal(false);
      };
      window.addEventListener('popstate', handlePopState);
      return () => {
        window.removeEventListener('popstate', handlePopState);
      };
    }
  }, [showModal]);

  // Form
  const [dealerName, setDealerName] = useState('');
  const [farmerName, setFarmerName] = useState('');
  const [totalAmount, setTotalAmount] = useState('5000');
  const [status, setStatus] = useState<OrderItem['status']>('confirmed');

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

  const handleCreateOrder = async (e: React.FormEvent) => {
    e.preventDefault();
    const id = `order_${Date.now()}`;
    const tot = Number(totalAmount) || 0;

    const newOrder: OrderItem = {
      id,
      orderNumber: `BW-${Math.floor(100000 + Math.random() * 900000)}`,
      dealerName: dealerName.trim() || 'General Dealer',
      farmerName: farmerName.trim() || 'Direct Farmer',
      totalAmount: tot,
      paidAmount: 0,
      balanceAmount: tot,
      paymentMode: 'Pending',
      status,
      ownerId: profile.uid,
      userId: profile.uid,
      loginId: profile.loginId || '',
      userCode: profile.userCode || '',
      createdByName: profile.fullName || 'User',
      createdAt: new Date().toISOString(),
      isArchived: false,
    };

    await setDoc(doc(db, 'orders', id), newOrder);
    await logAudit('CREATE', 'orders', id, `Created order ${newOrder.orderNumber} for ₹${tot}`, profile);

    setShowModal(false);
    setDealerName('');
    setFarmerName('');
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

  const handleDelete = async (order: OrderItem) => {
    setDialogConfig({
      isOpen: true,
      type: 'confirm',
      title: 'Delete Confirmation',
      message: t.confirmDelete || 'Are you sure you want to delete this record?',
      confirmText: 'Delete',
      cancelText: 'Cancel',
      onConfirm: async () => {
        setDialogConfig(prev => ({ ...prev, isOpen: false }));
        await softDeleteRecord('orders', order.id, order, profile);
      },
      onCancel: () => setDialogConfig(prev => ({ ...prev, isOpen: false })),
    });
  };

  const filtered = orders.filter(o => {
    // Data Isolation: Admin sees all; Non-admin strictly sees only their own data!
    if (!isUserRecord(o, profile)) return false;

    const matchSearch = o.dealerName.toLowerCase().includes(search.toLowerCase()) || o.orderNumber.toLowerCase().includes(search.toLowerCase());
    const matchStatus = statusFilter === 'all' || o.status === statusFilter;
    return matchSearch && matchStatus;
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 bg-white p-4 rounded-2xl border border-slate-200 shadow-sm">
        <div>
          <h2 className="text-xl font-bold text-slate-900 flex items-center gap-2">
            <ShoppingBag className="w-6 h-6 text-purple-600" />
            {t.orders}
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">Manage new orders and delivery statuses</p>
        </div>
        <button
          onClick={() => setShowModal(true)}
          className="flex items-center gap-2 bg-purple-600 hover:bg-purple-700 text-white px-4 py-2.5 rounded-xl text-xs font-bold transition shadow-sm"
        >
          <Plus className="w-4 h-4" />
          <span>{t.addNew} Order</span>
        </button>
      </div>

      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="w-4 h-4 absolute left-3 top-3 text-slate-400" />
          <input
            type="text"
            placeholder="Search Order No or Dealer..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-9 pr-4 py-2.5 rounded-xl border border-slate-200 bg-white text-xs focus:outline-none"
          />
        </div>
        <div className="flex gap-2 overflow-x-auto pb-1 no-scrollbar">
          {['all', 'pending', 'confirmed', 'delivered', 'collected'].map((st) => (
            <button
              key={st}
              onClick={() => setStatusFilter(st)}
              className={`px-3 py-2 rounded-xl text-[10px] font-bold uppercase transition whitespace-nowrap ${statusFilter === st ? 'bg-purple-600 text-white' : 'bg-white border border-slate-200 text-slate-600'}`}
            >
              {st}
            </button>
          ))}
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="bg-white rounded-2xl border border-slate-200 p-12 text-center">
          <ShoppingBag className="w-12 h-12 text-slate-300 mx-auto mb-3" />
          <p className="text-sm font-semibold text-slate-700">No orders found</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {filtered.map(o => (
            <div key={o.id} className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm space-y-3">
              <div className="flex justify-between items-start">
                <div>
                  <span className="text-[10px] font-bold text-purple-600 bg-purple-50 px-2 py-0.5 rounded">
                    {o.orderNumber}
                  </span>
                  <h3 className="text-base font-bold text-slate-900 mt-1">{o.dealerName}</h3>
                  <p className="text-[11px] text-slate-500 font-medium">Farmer: {o.farmerName}</p>
                </div>
                <button onClick={() => handleDelete(o)} className="text-slate-400 hover:text-rose-600 p-1">
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>

              <div className="flex justify-between items-center py-2 border-y border-slate-100">
                <span className="text-xs font-bold text-slate-800">Bill Amount: ₹{o.totalAmount.toLocaleString()}</span>
                <span className={cn(
                  "px-2 py-0.5 rounded-[6px] text-[10px] font-black uppercase tracking-wider",
                  o.status === 'delivered' ? "bg-blue-50 text-blue-700" : 
                  o.status === 'collected' ? "bg-emerald-50 text-emerald-700" :
                  "bg-amber-50 text-amber-700"
                )}>
                  {o.status}
                </span>
              </div>

              <div className="text-[10px] text-slate-400">
                Created by {o.createdByName} on {new Date(o.createdAt).toLocaleDateString()}
              </div>
            </div>
          ))}
        </div>
      )}

      {showModal && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl max-w-md w-full p-6 shadow-2xl border border-slate-100 max-h-[90vh] overflow-y-auto">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-lg font-bold text-slate-900">New Order Entry</h3>
              <button onClick={() => setShowModal(false)} className="text-slate-400 hover:text-slate-600"><X className="w-5 h-5" /></button>
            </div>

            <form onSubmit={handleCreateOrder} className="space-y-4">
              <div>
                <label className="text-xs font-semibold text-slate-700 block mb-1">Dealer / Shop Name *</label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Kisan Krushi Seva"
                  value={dealerName}
                  onChange={(e) => setDealerName(e.target.value)}
                  className="w-full px-3 py-2 border rounded-xl text-xs focus:outline-none"
                />
              </div>

              <div>
                <label className="text-xs font-semibold text-slate-700 block mb-1">Farmer Name</label>
                <input
                  type="text"
                  placeholder="e.g. Ramesh Patil"
                  value={farmerName}
                  onChange={(e) => setFarmerName(e.target.value)}
                  className="w-full px-3 py-2 border rounded-xl text-xs focus:outline-none"
                />
              </div>

              <div>
                <label className="text-xs font-semibold text-slate-700 block mb-1">Total Bill Amount (₹) *</label>
                <input
                  type="number"
                  required
                  value={totalAmount}
                  onChange={(e) => setTotalAmount(e.target.value)}
                  className="w-full px-3 py-2 border rounded-xl text-xs focus:outline-none"
                />
              </div>

              <div>
                <label className="text-xs font-semibold text-slate-700 block mb-1">Order Status</label>
                <select
                  value={status}
                  onChange={(e) => setStatus(e.target.value as any)}
                  className="w-full px-3 py-2 border rounded-xl text-xs focus:outline-none"
                >
                  <option value="pending">Pending</option>
                  <option value="confirmed">Confirmed</option>
                  <option value="delivered">Delivered</option>
                </select>
              </div>

              <div className="pt-2 flex gap-3">
                <button type="button" onClick={() => setShowModal(false)} className="flex-1 py-2.5 rounded-xl border text-xs font-bold text-slate-600">{t.cancel}</button>
                <button type="submit" className="flex-1 py-2.5 rounded-xl bg-purple-600 hover:bg-purple-700 text-xs font-bold text-white shadow-sm">{t.save} Order</button>
              </div>
            </form>
          </div>
        </div>
      )}
      <CustomDialogModal {...dialogConfig} />
    </div>
  );
};
