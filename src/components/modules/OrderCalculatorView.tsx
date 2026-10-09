import React, { useState } from 'react';
import { doc, setDoc } from 'firebase/firestore';
import { db } from '../../firebase';
import { UserProfile } from '../../lib/auth';
import { logAudit } from '../../lib/dataService';
import { Language, translations } from '../../lib/i18n';
import { Calculator, ShoppingBag, CheckCircle, IndianRupee } from 'lucide-react';

interface Props {
  profile: UserProfile;
  lang: Language;
}

export const OrderCalculatorView: React.FC<Props> = ({ profile, lang }) => {
  const t = translations[lang];
  const [bagsVermicompost, setBagsVermicompost] = useState(10);
  const [vermimaxPrice] = useState(650);
  const [bagsVermiwash, setBagsVermiwash] = useState(2);
  const [vermiwashPrice] = useState(520);
  const [bagsNeem, setBagsNeem] = useState(5);
  const [neemPrice] = useState(560);
  const [discountPercent, setDiscountPercent] = useState(5);
  const [dealerName, setDealerName] = useState('Kisan Krushi Seva Kendra');
  const [success, setSuccess] = useState(false);

  const subtotal = (bagsVermicompost * vermimaxPrice) + (bagsVermiwash * vermiwashPrice) + (bagsNeem * neemPrice);
  const discountAmount = Math.round((subtotal * discountPercent) / 100);
  const netPayable = subtotal - discountAmount;

  const handleConvertToOrder = async () => {
    try {
      const id = `order_calc_${Date.now()}`;
      const newOrder = {
        id,
        orderNumber: `BW-CALC-${Math.floor(1000 + Math.random() * 9000)}`,
        dealerName,
        farmerName: 'Direct Calculator Order',
        totalAmount: netPayable,
        paidAmount: 0,
        balanceAmount: netPayable,
        paymentMode: 'Credit / Calculated',
        status: 'pending',
        ownerId: profile.uid,
        userId: profile.uid,
        loginId: profile.loginId || '',
        userCode: profile.userCode || '',
        createdByName: profile.fullName || 'User',
        createdAt: new Date().toISOString(),
        isArchived: false,
      };

      await setDoc(doc(db, 'orders', id), newOrder);
      await logAudit('CREATE', 'orders', id, `Converted calculated order for ${dealerName} (₹${netPayable})`, profile);
      setSuccess(true);
      setTimeout(() => setSuccess(false), 4000);
    } catch (err) {
      console.error('Error creating order from calculator:', err);
    }
  };

  return (
    <div className="space-y-6 max-w-3xl mx-auto">
      <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-slate-900 flex items-center gap-2">
            <Calculator className="w-6 h-6 text-teal-600" />
            Order Calculator
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">Calculate product rates and scheme discounts</p>
        </div>
      </div>

      {success && (
        <div className="p-3 bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs rounded-xl flex items-center gap-2">
          <CheckCircle className="w-4 h-4 text-emerald-600 shrink-0" />
          <span>Success! Calculated order saved in 'Orders' module.</span>
        </div>
      )}

      <div className="bg-white rounded-2xl border border-slate-200 p-6 shadow-sm space-y-6">
        <div>
          <label className="text-xs font-semibold text-slate-700 block mb-1">Dealer / Shop Name</label>
          <input
            type="text"
            value={dealerName}
            onChange={(e) => setDealerName(e.target.value)}
            className="w-full px-3 py-2 border rounded-xl text-xs focus:outline-none"
          />
        </div>

        <div className="space-y-4">
          <div className="flex items-center justify-between p-3 bg-slate-50 rounded-xl">
            <div>
              <p className="text-xs font-bold text-slate-800">Blackworm Vermicompost (50 kg)</p>
              <p className="text-[11px] text-slate-500">Rate: ₹{vermimaxPrice} / Bag</p>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min="0"
                value={bagsVermicompost}
                onChange={(e) => setBagsVermicompost(Number(e.target.value))}
                className="w-20 px-2 py-1 text-center border rounded-lg text-xs font-bold"
              />
              <span className="text-xs text-slate-600">Bags</span>
            </div>
          </div>

          <div className="flex items-center justify-between p-3 bg-slate-50 rounded-xl">
            <div>
              <p className="text-xs font-bold text-slate-800">Vermiwash Liquid (5 Ltr)</p>
              <p className="text-[11px] text-slate-500">Rate: ₹{vermiwashPrice} / Can</p>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min="0"
                value={bagsVermiwash}
                onChange={(e) => setBagsVermiwash(Number(e.target.value))}
                className="w-20 px-2 py-1 text-center border rounded-lg text-xs font-bold"
              />
              <span className="text-xs text-slate-600">Cans</span>
            </div>
          </div>

          <div className="flex items-center justify-between p-3 bg-slate-50 rounded-xl">
            <div>
              <p className="text-xs font-bold text-slate-800">Neem Oil Pest Guard (1 Ltr)</p>
              <p className="text-[11px] text-slate-500">Rate: ₹{neemPrice} / Bottle</p>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min="0"
                value={bagsNeem}
                onChange={(e) => setBagsNeem(Number(e.target.value))}
                className="w-20 px-2 py-1 text-center border rounded-lg text-xs font-bold"
              />
              <span className="text-xs text-slate-600">Bottles</span>
            </div>
          </div>
        </div>

        <div className="flex items-center justify-between pt-2 border-t border-slate-100">
          <span className="text-xs font-semibold text-slate-700">Scheme / Special Discount (%)</span>
          <input
            type="number"
            min="0"
            max="50"
            value={discountPercent}
            onChange={(e) => setDiscountPercent(Number(e.target.value))}
            className="w-20 px-2 py-1 text-center border rounded-lg text-xs font-bold text-teal-600"
          />
        </div>

        <div className="bg-teal-50 border border-teal-200 rounded-2xl p-4 space-y-2 text-xs">
          <div className="flex justify-between text-slate-600">
            <span>Subtotal:</span>
            <span className="font-bold">₹{subtotal.toLocaleString()}</span>
          </div>
          <div className="flex justify-between text-teal-700">
            <span>Discount ({discountPercent}%):</span>
            <span className="font-bold">- ₹{discountAmount.toLocaleString()}</span>
          </div>
          <div className="flex justify-between text-base font-black text-teal-900 pt-2 border-t border-teal-200">
            <span>Net Payable:</span>
            <span>₹{netPayable.toLocaleString()}</span>
          </div>
        </div>

        <button
          onClick={handleConvertToOrder}
          className="w-full py-3 bg-teal-600 hover:bg-teal-700 text-white rounded-xl text-xs font-bold shadow-md transition flex items-center justify-center gap-2"
        >
          <ShoppingBag className="w-4 h-4" />
          <span>Convert to Order</span>
        </button>
      </div>
    </div>
  );
};
