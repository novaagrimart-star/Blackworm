import React, { useState, useEffect } from 'react';
import { collection, query, onSnapshot, doc, setDoc } from 'firebase/firestore';
import { db } from '../../firebase';
import { UserProfile } from '../../lib/auth';
import { logAudit } from '../../lib/dataService';
import { Language, translations } from '../../lib/i18n';
import { Gift, Plus, CheckCircle2, X } from 'lucide-react';

interface SchemeItem {
  id: string;
  title: string;
  description: string;
  eligibility: string;
  bonusOffer: string;
  isActive: boolean;
  isArchived?: boolean;
}

interface Props {
  profile: UserProfile;
  lang: Language;
}

export const SchemeView: React.FC<Props> = ({ profile, lang }) => {
  const t = translations[lang];
  const [schemes, setSchemes] = useState<SchemeItem[]>([]);
  const [showModal, setShowModal] = useState(false);

  // Form
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [eligibility, setEligibility] = useState('');
  const [bonusOffer, setBonusOffer] = useState('');

  useEffect(() => {
    const q = query(collection(db, 'schemes'));
    const unsub = onSnapshot(q, (snap) => {
      const list: SchemeItem[] = [];
      snap.forEach(d => {
        const data = d.data() as SchemeItem;
        if (!data.isArchived) list.push({ ...data, id: d.id });
      });
      setSchemes(list);
    });
    return () => unsub();
  }, []);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    const id = `scheme_${Date.now()}`;
    const newItem: SchemeItem = {
      id,
      title: title.trim(),
      description: description.trim(),
      eligibility: eligibility.trim(),
      bonusOffer: bonusOffer.trim(),
      isActive: true,
      isArchived: false,
    };

    await setDoc(doc(db, 'schemes', id), newItem);
    await logAudit('CREATE', 'schemes', id, `Created scheme ${newItem.title}`, profile);

    setShowModal(false);
    setTitle('');
    setDescription('');
  };

  return (
    <div className="space-y-6">
      <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-slate-900 flex items-center gap-2">
            <Gift className="w-6 h-6 text-fuchsia-600" />
            Seasonal Schemes & Offers
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">Special discounts and bonus offers for dealers</p>
        </div>
        {(profile.role === 'admin' || profile.role === 'owner') && (
          <button
            onClick={() => setShowModal(true)}
            className="flex items-center gap-2 bg-fuchsia-600 hover:bg-fuchsia-700 text-white px-4 py-2.5 rounded-xl text-xs font-bold transition shadow-sm"
          >
            <Plus className="w-4 h-4" />
            <span>Add New Scheme</span>
          </button>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {schemes.map(s => (
          <div key={s.id} className="bg-white rounded-2xl border border-slate-200 p-6 shadow-sm space-y-3 relative overflow-hidden">
            <div className="absolute top-0 right-0 bg-fuchsia-100 text-fuchsia-800 text-[10px] font-bold px-3 py-1 rounded-bl-xl">
              Active Offer
            </div>
            <h3 className="text-base font-bold text-slate-900">{s.title}</h3>
            <p className="text-xs text-slate-600 leading-relaxed">{s.description}</p>
            <div className="bg-fuchsia-50 border border-fuchsia-100 rounded-xl p-3 text-xs text-fuchsia-900 space-y-1">
              <p><strong>Eligibility:</strong> {s.eligibility}</p>
              <p><strong>Bonus/Benefit:</strong> {s.bonusOffer}</p>
            </div>
          </div>
        ))}
      </div>

      {showModal && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl max-w-md w-full p-6 shadow-2xl border border-slate-100">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-lg font-bold text-slate-900">Add New Scheme</h3>
              <button onClick={() => setShowModal(false)} className="text-slate-400 hover:text-slate-600"><X className="w-5 h-5" /></button>
            </div>

            <form onSubmit={handleSave} className="space-y-4">
              <div>
                <label className="text-xs font-semibold text-slate-700 block mb-1">Scheme Title *</label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Kharif Bumper Offer"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className="w-full px-3 py-2 border rounded-xl text-xs focus:outline-none"
                />
              </div>

              <div>
                <label className="text-xs font-semibold text-slate-700 block mb-1">Description *</label>
                <textarea
                  required
                  rows={3}
                  placeholder="Detailed information about the scheme..."
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  className="w-full px-3 py-2 border rounded-xl text-xs focus:outline-none"
                />
              </div>

              <div>
                <label className="text-xs font-semibold text-slate-700 block mb-1">Eligibility Conditions</label>
                <input
                  type="text"
                  placeholder="e.g. All registered dealers"
                  value={eligibility}
                  onChange={(e) => setEligibility(e.target.value)}
                  className="w-full px-3 py-2 border rounded-xl text-xs focus:outline-none"
                />
              </div>

              <div>
                <label className="text-xs font-semibold text-slate-700 block mb-1">Bonus / Benefit</label>
                <input
                  type="text"
                  placeholder="e.g. 10 bags = +1 bag free"
                  value={bonusOffer}
                  onChange={(e) => setBonusOffer(e.target.value)}
                  className="w-full px-3 py-2 border rounded-xl text-xs focus:outline-none"
                />
              </div>

              <div className="pt-2 flex gap-3">
                <button type="button" onClick={() => setShowModal(false)} className="flex-1 py-2.5 rounded-xl border text-xs font-bold text-slate-600 hover:bg-slate-50">Cancel</button>
                <button type="submit" className="flex-1 py-2.5 rounded-xl bg-fuchsia-600 hover:bg-fuchsia-700 text-xs font-bold text-white shadow-sm">Save Scheme</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
