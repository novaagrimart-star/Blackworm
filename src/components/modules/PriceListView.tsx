import React, { useState, useEffect, useRef } from 'react';
import { collection, query, onSnapshot, doc, setDoc, getDocs, writeBatch } from 'firebase/firestore';
import { db } from '../../firebase';
import { UserProfile } from '../../lib/auth';
import { Language } from '../../lib/i18n';
import { CustomDialogModal } from '../CustomDialogModal';
import { Upload, Download, RefreshCw, Loader2, FileSpreadsheet } from 'lucide-react';
import * as XLSX from 'xlsx';

export interface PackingOption {
  packingSize: string;
  rate: number;
  mrp: number;
}

export interface DynamicPriceProduct {
  id: string;
  groupName: string; // e.g. "Group A - Water Soluble Fertilizers", "Specialty Grades"
  code: string;      // e.g. "A 1.", "S 1."
  brandName: string; // e.g. "Airawat®"
  gradeName: string; // e.g. "19:19:19", "00:42:47 + Fe", "11:44:11 + Zn"
  hsn: string;        // e.g. "31052000"
  gstRate: number;   // e.g. 5
  packings: PackingOption[];
  isArchived?: boolean;
  orderIndex?: number;
}

interface Props {
  profile: UserProfile;
  lang?: Language;
}

// Master reference data matching the official Blackworm Agritech document
export const OFFICIAL_REFERENCE_DATA: Omit<DynamicPriceProduct, 'id'>[] = [
  // --- Group A - Water Soluble Fertilizers ---
  {
    groupName: 'Group A - Water Soluble Fertilizers',
    code: 'A 1.',
    brandName: 'Airawat®',
    gradeName: '19:19:19',
    hsn: '31052000',
    gstRate: 5,
    packings: [
      { packingSize: '1 Kg', rate: 195, mrp: 370 },
      { packingSize: '25 Kg', rate: 3710, mrp: 4960 },
    ],
    orderIndex: 1,
  },
  {
    groupName: 'Group A - Water Soluble Fertilizers',
    code: 'A 2.',
    brandName: 'Airawat®',
    gradeName: '13:40:13',
    hsn: '31052000',
    gstRate: 5,
    packings: [
      { packingSize: '1 Kg', rate: 225, mrp: 389 },
      { packingSize: '25 Kg', rate: 4525, mrp: 6400 },
    ],
    orderIndex: 2,
  },
  {
    groupName: 'Group A - Water Soluble Fertilizers',
    code: 'A 3.',
    brandName: 'Airawat®',
    gradeName: '12:61:0',
    hsn: '31054000',
    gstRate: 5,
    packings: [
      { packingSize: '1 Kg', rate: 255, mrp: 397 },
      { packingSize: '25 Kg', rate: 4880, mrp: 6940 },
    ],
    orderIndex: 3,
  },
  {
    groupName: 'Group A - Water Soluble Fertilizers',
    code: 'A 4.',
    brandName: 'Airawat®',
    gradeName: '0:52:34',
    hsn: '31056000',
    gstRate: 5,
    packings: [
      { packingSize: '1 Kg', rate: 290, mrp: 460 },
      { packingSize: '25 Kg', rate: 5750, mrp: 7930 },
    ],
    orderIndex: 4,
  },
  {
    groupName: 'Group A - Water Soluble Fertilizers',
    code: 'A 5.',
    brandName: 'Airawat®',
    gradeName: '13:0:45',
    hsn: '31059010',
    gstRate: 5,
    packings: [
      { packingSize: '1 Kg', rate: 235, mrp: 370 },
      { packingSize: '25 Kg', rate: 4240, mrp: 5860 },
    ],
    orderIndex: 5,
  },
  {
    groupName: 'Group A - Water Soluble Fertilizers',
    code: 'A 6.',
    brandName: 'Airawat®',
    gradeName: '0:0:50',
    hsn: '31043000',
    gstRate: 5,
    packings: [
      { packingSize: '1 Kg', rate: 180, mrp: 352 },
      { packingSize: '25 Kg', rate: 3240, mrp: 4240 },
    ],
    orderIndex: 6,
  },
  {
    groupName: 'Group A - Water Soluble Fertilizers',
    code: 'A 7.',
    brandName: 'Airawat®',
    gradeName: 'Calcium Nitrate',
    hsn: '31026000',
    gstRate: 5,
    packings: [
      { packingSize: '1 Kg', rate: 135, mrp: 325 },
    ],
    orderIndex: 7,
  },
  {
    groupName: 'Group A - Water Soluble Fertilizers',
    code: 'A 8.',
    brandName: 'Airawat®',
    gradeName: 'Potassium Schoenite',
    hsn: '31049000',
    gstRate: 5,
    packings: [
      { packingSize: '1 Kg', rate: 155, mrp: 343 },
    ],
    orderIndex: 8,
  },
  {
    groupName: 'Group A - Water Soluble Fertilizers',
    code: 'A 9.',
    brandName: 'Airawat®',
    gradeName: 'Magnesium Sulphate',
    hsn: '28332990',
    gstRate: 18,
    packings: [
      { packingSize: '1 Kg', rate: 85, mrp: 165 },
      { packingSize: '25 Kg', rate: 1100, mrp: 1650 },
    ],
    orderIndex: 9,
  },

  // --- Specialty Grades ---
  {
    groupName: 'Specialty Grades',
    code: 'S 1.',
    brandName: 'Airawat®',
    gradeName: '00:42:47 + Fe',
    hsn: '31056000',
    gstRate: 5,
    packings: [
      { packingSize: '1 Kg', rate: 495, mrp: 1120 },
      { packingSize: '2.5 Kg', rate: 1180, mrp: 2795 },
    ],
    orderIndex: 10,
  },
  {
    groupName: 'Specialty Grades',
    code: 'S 2.',
    brandName: 'Airawat®',
    gradeName: '00:60:20 + Mg',
    hsn: '31056000',
    gstRate: 5,
    packings: [
      { packingSize: '1 Kg', rate: 330, mrp: 746 },
      { packingSize: '2.5 Kg', rate: 780, mrp: 1855 },
    ],
    orderIndex: 11,
  },
  {
    groupName: 'Specialty Grades',
    code: 'S 3.',
    brandName: 'Airawat®',
    gradeName: '00:55:18 + S',
    hsn: '31056000',
    gstRate: 5,
    packings: [
      { packingSize: '2.5 Kg', rate: 950, mrp: 2350 },
    ],
    orderIndex: 12,
  },
  {
    groupName: 'Specialty Grades',
    code: 'S 4.',
    brandName: 'Airawat®',
    gradeName: '00:09:46 + S',
    hsn: '31056000',
    gstRate: 5,
    packings: [
      { packingSize: '1 Kg', rate: 365, mrp: 937 },
      { packingSize: '2.5 Kg', rate: 820, mrp: 2143 },
    ],
    orderIndex: 13,
  },
  {
    groupName: 'Specialty Grades',
    code: 'S 5.',
    brandName: 'Airawat®',
    gradeName: '00:33:65 + Cu + Zn',
    hsn: '31054000',
    gstRate: 5,
    packings: [
      { packingSize: '2.5 Kg', rate: 1705, mrp: 2980 },
    ],
    orderIndex: 14,
  },
  {
    groupName: 'Specialty Grades',
    code: 'S 6.',
    brandName: 'Airawat®',
    gradeName: '36:10:10 + Combi',
    hsn: '31052000',
    gstRate: 5,
    packings: [
      { packingSize: '1 Kg', rate: 292, mrp: 694 },
      { packingSize: '2.5 Kg', rate: 695, mrp: 1720 },
    ],
    orderIndex: 15,
  },
  {
    groupName: 'Specialty Grades',
    code: 'S 7.',
    brandName: 'Airawat®',
    gradeName: '11:44:11 + Zn',
    hsn: '31052000',
    gstRate: 5,
    packings: [
      { packingSize: '1 Kg', rate: 390, mrp: 946 },
      { packingSize: '2.5 Kg', rate: 920, mrp: 2368 },
    ],
    orderIndex: 16,
  },
  {
    groupName: 'Specialty Grades',
    code: 'S 8.',
    brandName: 'Airawat®',
    gradeName: 'Nitro King',
    hsn: '31052000',
    gstRate: 5,
    packings: [
      { packingSize: '2.5 Kg', rate: 540, mrp: 1270 },
    ],
    orderIndex: 17,
  },
];

// Calculate Rate With GST: Basic Rate + (Basic Rate * GST %)
export const calculateWithGst = (basicRate: number | undefined, gstPercent: number = 5): number => {
  if (!basicRate || basicRate <= 0) return 0;
  const withGst = basicRate * (1 + (gstPercent || 0) / 100);
  return Math.round(withGst * 100) / 100;
};

export const PriceListView: React.FC<Props> = ({ profile }) => {
  const [products, setProducts] = useState<DynamicPriceProduct[]>([]);
  const [validityDate, setValidityDate] = useState('Pricelist w.e.f 01/10/2026 to 31/10/2026');
  const [logoUrl, setLogoUrl] = useState<string>('');
  const [logoSize, setLogoSize] = useState<number>(75);
  const [isUploading, setIsUploading] = useState<boolean>(false);
  const [isResetting, setIsResetting] = useState<boolean>(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

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

  // 1. Fetch Branding & Validity Date
  useEffect(() => {
    const unsubBranding = onSnapshot(doc(db, 'config', 'branding'), (snap) => {
      if (snap.exists()) {
        const data = snap.data();
        setLogoUrl(data.logoUrl || '');
        setLogoSize(data.logoSize || 75);
      }
    });
    const unsubMeta = onSnapshot(doc(db, 'config', 'pricelist_meta'), (snap) => {
      if (snap.exists() && snap.data().validityDate) {
        setValidityDate(snap.data().validityDate);
      }
    });
    return () => {
      unsubBranding();
      unsubMeta();
    };
  }, []);

  // 2. Real-time Listener for Dynamic Products
  useEffect(() => {
    const q = query(collection(db, 'products_pricelist_v2'));
    const unsub = onSnapshot(q, async (snap) => {
      const list: DynamicPriceProduct[] = [];
      snap.forEach((docSnap) => {
        const data = docSnap.data() as DynamicPriceProduct;
        if (!data.isArchived) {
          list.push({ ...data, id: docSnap.id });
        }
      });

      // If empty on first load, seed with official reference data from photo
      if (list.length === 0) {
        await seedReferenceData();
      } else {
        // Sort products by orderIndex or group and code
        list.sort((a, b) => {
          if (a.groupName !== b.groupName) {
            if (a.groupName.includes('Group A')) return -1;
            if (b.groupName.includes('Group A')) return 1;
            if (a.groupName.includes('Specialty')) return -1;
            if (b.groupName.includes('Specialty')) return 1;
            return a.groupName.localeCompare(b.groupName);
          }
          return (a.orderIndex || 0) - (b.orderIndex || 0);
        });
        setProducts(list);
      }
    });

    return () => unsub();
  }, []);

  // Seed reference data
  const seedReferenceData = async () => {
    try {
      const snapOld = await getDocs(collection(db, 'products_pricelist_v2'));
      const batch = writeBatch(db);
      snapOld.forEach((d) => batch.delete(d.ref));
      await batch.commit();

      for (const item of OFFICIAL_REFERENCE_DATA) {
        const cleanId = `prod_${item.code.replace(/[^A-Za-z0-9]/g, '_')}_${item.gradeName.replace(/[^A-Za-z0-9]/g, '_')}`;
        await setDoc(doc(db, 'products_pricelist_v2', cleanId), {
          ...item,
          id: cleanId,
          isArchived: false,
        });
      }
    } catch (err) {
      console.error('Error auto-seeding reference price list:', err);
    }
  };

  // Export Sample / Current Excel Template matching the row-by-row structure
  const handleDownloadTemplate = () => {
    try {
      const rows: any[] = [];
      products.forEach((prod) => {
        (prod.packings || []).forEach((pk) => {
          rows.push({
            'Category': prod.groupName,
            'Sr No': prod.code,
            'Brand': prod.brandName,
            'Product Grade': prod.gradeName,
            'HSN': prod.hsn,
            'Packing Size': pk.packingSize,
            'Basic Rate': pk.rate,
            'GST Rate (%)': prod.gstRate,
            'MRP': pk.mrp,
          });
        });
      });

      const worksheet = XLSX.utils.json_to_sheet(rows);
      worksheet['!cols'] = [
        { wch: 34 },
        { wch: 10 },
        { wch: 14 },
        { wch: 24 },
        { wch: 14 },
        { wch: 16 },
        { wch: 14 },
        { wch: 14 },
        { wch: 14 },
      ];

      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, worksheet, 'Price_List');
      XLSX.writeFile(workbook, 'Blackworm_Pricelist_Template.xlsx');
    } catch (err) {
      console.error('Excel export error:', err);
    }
  };

  // Handle Upload of Excel (.xlsx/.xls) or PDF / Image
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsUploading(true);

    try {
      const fileName = file.name.toLowerCase();

      // Case A: Excel File (.xlsx, .xls, .csv)
      if (fileName.endsWith('.xlsx') || fileName.endsWith('.xls') || fileName.endsWith('.csv')) {
        const data = await file.arrayBuffer();
        const workbook = XLSX.read(data, { type: 'array' });
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];
        const jsonRows: any[] = XLSX.utils.sheet_to_json(worksheet);

        if (!jsonRows || jsonRows.length === 0) {
          throw new Error('एक्सेल फाईलमध्ये कोणताही डेटा सापडला नाही.');
        }

        // Group rows by Grade Name so 1 Kg and 25 Kg stay grouped under the same product
        const productMap = new Map<string, DynamicPriceProduct>();

        jsonRows.forEach((row, idx) => {
          const gradeName = String(row['Product Grade'] || row['Grade'] || row['Product Name'] || row['प्रॉडक्ट'] || '').trim();
          if (!gradeName) return;

          const groupName = String(row['Category'] || row['Group'] || 'Group A - Water Soluble Fertilizers').trim();
          const code = String(row['Sr No'] || row['Sr. No.'] || row['Code'] || `${idx + 1}.`).trim();
          const brandName = String(row['Brand'] || 'Airawat®').trim();
          const hsn = String(row['HSN'] || row['hsn'] || '31052000').trim();
          const gstRate = Number(row['GST Rate (%)'] || row['GST Rate'] || row['GST'] || 5);

          const packingSize = String(row['Packing Size'] || row['Packing'] || '1 Kg').trim();
          const rate = Number(row['Basic Rate'] || row['Rate'] || 0);
          const mrp = Number(row['MRP'] || row['mrp'] || 0);

          const key = `${groupName}__${code}__${gradeName}`;

          if (!productMap.has(key)) {
            const cleanId = `prod_${code.replace(/[^A-Za-z0-9]/g, '_')}_${gradeName.replace(/[^A-Za-z0-9]/g, '_')}`;
            productMap.set(key, {
              id: cleanId,
              groupName,
              code,
              brandName,
              gradeName,
              hsn,
              gstRate,
              packings: [{ packingSize, rate, mrp }],
              orderIndex: idx + 1,
              isArchived: false,
            });
          } else {
            productMap.get(key)!.packings.push({ packingSize, rate, mrp });
          }
        });

        const newProducts = Array.from(productMap.values());

        if (newProducts.length === 0) {
          throw new Error('एक्सेल फाईलमध्ये योग्य प्रॉडक्ट्स किंवा ग्रेड्स सापडले नाहीत. कृपया नमुना फॉरमॅट वापरा.');
        }

        // Sync to Firestore
        const snapOld = await getDocs(collection(db, 'products_pricelist_v2'));
        const batch = writeBatch(db);
        snapOld.forEach((d) => batch.delete(d.ref));
        await batch.commit();

        for (const item of newProducts) {
          await setDoc(doc(db, 'products_pricelist_v2', item.id), item);
        }

        setDialogConfig({
          isOpen: true,
          type: 'success',
          title: 'प्राईस लिस्ट अपडेट झाली',
          message: `एक्सेल फाईलमधून एकूण ${newProducts.length} प्रॉडक्ट्स यशस्वीरित्या ॲपमध्ये अपडेट करण्यात आले आहेत.`,
          confirmText: 'ठीक आहे',
          onConfirm: () => setDialogConfig((p) => ({ ...p, isOpen: false })),
        });
      } else {
        // Case B: PDF or Image via Server AI Parser
        const formData = new FormData();
        formData.append('file', file);

        const response = await fetch('/api/parse-pricelist', {
          method: 'POST',
          body: formData,
        });

        if (!response.ok) {
          const errData = await response.json();
          throw new Error(errData.error || 'फाईल वाचण्यात त्रुटी आली.');
        }

        const parsedData = await response.json();
        const extractedProducts: any[] = parsedData.products || [];

        if (extractedProducts.length === 0) {
          throw new Error('फाईलमधून प्रॉडक्ट्स डेटा वाचता आला नाही.');
        }

        // Clear existing and insert extracted items
        const snapOld = await getDocs(collection(db, 'products_pricelist_v2'));
        const batch = writeBatch(db);
        snapOld.forEach((d) => batch.delete(d.ref));
        await batch.commit();

        for (let idx = 0; idx < extractedProducts.length; idx++) {
          const item = extractedProducts[idx];
          const cleanId = `prod_${(item.code || `item_${idx}`).replace(/[^A-Za-z0-9]/g, '_')}_${(item.gradeName || '').replace(/[^A-Za-z0-9]/g, '_')}`;
          await setDoc(doc(db, 'products_pricelist_v2', cleanId), {
            groupName: item.groupName || 'Group A - Water Soluble Fertilizers',
            code: item.code || `${idx + 1}.`,
            brandName: item.brandName || 'Airawat®',
            gradeName: item.gradeName || '',
            hsn: item.hsn || '31052000',
            gstRate: Number(item.gstRate) || 5,
            packings: item.packings || [],
            orderIndex: idx + 1,
            isArchived: false,
            id: cleanId,
          });
        }

        if (parsedData.validityDate) {
          await setDoc(doc(db, 'config', 'pricelist_meta'), {
            validityDate: parsedData.validityDate,
            updatedAt: new Date().toISOString(),
          }, { merge: true });
        }

        setDialogConfig({
          isOpen: true,
          type: 'success',
          title: 'प्राईस लिस्ट अपडेट झाली',
          message: `अपलोड केलेल्या फाईलमधून एकूण ${extractedProducts.length} प्रॉडक्ट्स यशस्वीरित्या ॲपमध्ये सेव्ह झाले आहेत.`,
          confirmText: 'ठीक आहे',
          onConfirm: () => setDialogConfig((p) => ({ ...p, isOpen: false })),
        });
      }
    } catch (err: any) {
      console.error('File parse error:', err);
      setDialogConfig({
        isOpen: true,
        type: 'alert',
        title: 'अपलोड अयशस्वी',
        message: err.message || 'कृपया योग्य एक्सेल, PDF किंवा इमेज फाईल अपलोड करा.',
        confirmText: 'ठीक आहे',
        onConfirm: () => setDialogConfig((p) => ({ ...p, isOpen: false })),
      });
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  // Group products dynamically by Category Name (e.g. Group A, Specialty Grades, etc.)
  const groupedProducts: { groupName: string; items: DynamicPriceProduct[] }[] = [];
  const groupMap = new Map<string, DynamicPriceProduct[]>();

  products.forEach((p) => {
    if (!groupMap.has(p.groupName)) {
      groupMap.set(p.groupName, []);
    }
    groupMap.get(p.groupName)!.push(p);
  });

  groupMap.forEach((items, groupName) => {
    groupedProducts.push({ groupName, items });
  });

  const isUserAdminOrOwner = profile.role === 'admin' || profile.role === 'owner';

  return (
    <div className="font-sans text-slate-900 space-y-4">
      {/* ========================================================================= */}
      {/* COMPACT & PROFESSIONAL UPLOAD BAR                                         */}
      {/* ========================================================================= */}
      {isUserAdminOrOwner && (
        <div className="bg-white p-3 rounded-2xl border border-slate-200 shadow-sm flex flex-col sm:flex-row items-center justify-between gap-3 no-print">
          <div className="flex items-center gap-2">
            <span className="text-xs font-bold text-slate-800 flex items-center gap-1.5">
              <FileSpreadsheet className="w-4 h-4 text-emerald-600" />
              <span>कंपनी प्राईस लिस्ट</span>
            </span>
            <span className="text-[11px] text-slate-500 hidden sm:inline">
              (PDF, इमेज किंवा एक्सेल अपलोड करा; फाईलमधील सर्व प्रॉडक्ट्स व दर ऑटोमॅटिक अपडेट होतील)
            </span>
          </div>

          <div className="flex items-center gap-2 w-full sm:w-auto">
            <input
              type="file"
              ref={fileInputRef}
              onChange={handleFileUpload}
              accept=".xlsx,.xls,.csv,.pdf,.png,.jpg,.jpeg"
              className="hidden"
            />

            {/* Single Clean Upload Button */}
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={isUploading}
              className="w-full sm:w-auto flex items-center justify-center gap-2 bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-2 rounded-xl text-xs font-black transition shadow-sm disabled:opacity-50 cursor-pointer"
              title="नवीन प्राईस लिस्ट फाईल अपलोड करा (PDF / इमेज / एक्सेल)"
            >
              {isUploading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>अपलोड व अपडेट होत आहे...</span>
                </>
              ) : (
                <>
                  <Upload className="w-4 h-4" />
                  <span>प्राईस लिस्ट अपलोड करा</span>
                </>
              )}
            </button>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* THE OFFICIAL CLEAN PRICE LIST TABLE (STACKED 1 KG & 25 KG SUB-ROWS)       */}
      {/* ========================================================================= */}
      <div className="bg-white p-4 sm:p-8 rounded-2xl border border-slate-200 shadow-sm print:border-none print:shadow-none print:p-0 max-w-5xl mx-auto overflow-hidden">
        
        {/* Top Header: !! Shri !! */}
        <div className="text-center mb-1">
          <span className="text-xs sm:text-sm italic font-serif text-black font-semibold">
            !! Shri !!
          </span>
        </div>

        {/* Company Header: Logo on Left, Full Company Details on Right */}
        <div className="flex flex-col sm:flex-row items-center sm:items-start justify-between gap-4 pb-4 border-b border-slate-200">
          {/* Logo Left */}
          <div className="shrink-0 flex items-center justify-center">
            {logoUrl ? (
              <img 
                src={logoUrl} 
                alt="Blackworm Agritech" 
                style={{ width: `${logoSize * 1.5}px` }} 
                className="object-contain max-h-24" 
              />
            ) : (
              <div className="flex items-center gap-2">
                <div className="w-16 h-16 bg-rose-50 border border-rose-200 rounded-xl flex items-center justify-center">
                  <span className="text-xl font-black text-rose-600">BA</span>
                </div>
                <div className="flex flex-col">
                  <span className="text-lg font-black tracking-tighter text-rose-600">BLACKWORM</span>
                  <span className="text-[9px] text-slate-500 font-bold">Agriculture with new perspective</span>
                </div>
              </div>
            )}
          </div>

          {/* Company Text Right */}
          <div className="text-center sm:text-right flex-1 min-w-0">
            <h1 className="text-xl sm:text-2xl font-black text-black tracking-tight uppercase leading-tight font-sans">
              BLACKWORM AGRITECH PVT LTD
            </h1>
            <p className="text-[11px] sm:text-xs font-bold text-black mt-0.5 leading-snug">
              CIN : U01409PN2022PTC217246, GST No. 27AALCB3069J1ZC
            </p>
            <p className="text-[10px] sm:text-[11px] font-medium text-black leading-snug">
              Address - Gat No. 17 Vijaynagar (Mhaisal), Tal - Miraj, Dist - Sangli.416409.
            </p>
            <p className="text-[10px] sm:text-[11px] font-medium text-black leading-snug">
              Ph : <span className="font-bold">+91 7798716201</span>, E-Mail : <span className="underline text-blue-700">blackwormagritechpvtltd@gmail.com</span>
            </p>
          </div>
        </div>

        {/* Pricelist Validity Date (Cyan / Blue centered text) */}
        <div className="text-center my-4">
          <span className="text-xs sm:text-sm font-black text-cyan-800 tracking-wide bg-cyan-50 px-4 py-1.5 rounded-full border border-cyan-200 inline-block">
            {validityDate}
          </span>
        </div>

        {/* DYNAMIC SECTIONS & CONTINUOUS TABLES */}
        <div className="space-y-6">
          {groupedProducts.map((section) => (
            <div key={section.groupName} className="space-y-2">
              {/* Category Heading in Bold Green (Matching Photo) */}
              <div className="flex items-center justify-between">
                <h2 className="text-xs sm:text-sm font-black text-emerald-800 tracking-tight">
                  {section.groupName}
                </h2>
                <span className="text-[11px] font-bold text-slate-400">
                  {section.items.length} Products
                </span>
              </div>

              {/* Responsive Scroll Wrapper */}
              <div className="overflow-x-auto">
                {/* Continuous Table with Clean Sub-rows for 1 Kg and 25 Kg */}
                <table className="w-full border-collapse border-2 border-black text-xs font-sans">
                  {/* Table Header: Only 7 clean columns strictly as requested */}
                  <thead className="bg-white text-black font-black">
                    <tr className="border-b-2 border-black text-center">
                      <th className="border border-black py-2.5 px-2 text-center w-14 whitespace-nowrap bg-slate-50">
                        Sr.<br />No.
                      </th>
                      <th className="border border-black py-2.5 px-3 text-center min-w-[200px] bg-slate-50">
                        Product Name & Grade
                      </th>
                      <th className="border border-black py-2.5 px-3 text-center w-28 whitespace-nowrap bg-amber-50/50">
                        Packing Size
                      </th>
                      <th className="border border-black py-2.5 px-3 text-center w-28 whitespace-nowrap bg-slate-50">
                        Basic Rate
                      </th>
                      <th className="border border-black py-2.5 px-2 text-center w-20 whitespace-nowrap bg-slate-50">
                        GST<br />Rate
                      </th>
                      <th className="border border-black py-2.5 px-3 text-center w-32 whitespace-nowrap bg-emerald-50 text-emerald-900">
                        With GST Rate
                      </th>
                      <th className="border border-black py-2.5 px-3 text-center w-28 whitespace-nowrap bg-slate-50">
                        MRP
                      </th>
                    </tr>
                  </thead>

                  {/* Table Body: 1 Kg on top sub-box, 25 Kg directly beneath it with corresponding rates in front */}
                  <tbody className="text-black font-bold">
                    {section.items.map((prod) => {
                      const packings = prod.packings && prod.packings.length > 0
                        ? prod.packings
                        : [{ packingSize: '25 Kg', rate: 0, mrp: 0 }];
                      const rowCount = packings.length;

                      return packings.map((pk, pkIdx) => {
                        const withGst = calculateWithGst(pk.rate, prod.gstRate);
                        const isLastSubRow = pkIdx === rowCount - 1;

                        return (
                          <tr
                            key={`${prod.id}_${pkIdx}`}
                            className={`hover:bg-slate-50 transition-colors ${
                              isLastSubRow ? 'border-b-2 border-black' : 'border-b border-slate-300'
                            }`}
                          >
                            {/* 1. Sr. No (Spans across all packings of this product) */}
                            {pkIdx === 0 && (
                              <td
                                rowSpan={rowCount}
                                className="border-r border-black py-2 px-2 text-center font-bold text-black align-middle whitespace-nowrap font-serif bg-white"
                              >
                                {prod.code}
                              </td>
                            )}

                            {/* 2. Product Name & Grade (Spans across all packings) */}
                            {pkIdx === 0 && (
                              <td
                                rowSpan={rowCount}
                                className="border-r border-black py-2 px-3 text-center align-middle bg-white"
                              >
                                <div className="flex flex-col items-center justify-center leading-tight">
                                  {prod.brandName && (
                                    <span className="text-[11px] font-bold text-amber-700 font-sans tracking-tight">
                                      {prod.brandName}
                                    </span>
                                  )}
                                  <span className="text-xs sm:text-[13px] font-black text-sky-700 font-sans tracking-tight">
                                    {prod.gradeName}
                                  </span>
                                </div>
                              </td>
                            )}

                            {/* 3. Packing Size (1 Kg box on top, 25 Kg box below) */}
                            <td className="border-r border-black py-2 px-3 text-center font-bold text-black align-middle whitespace-nowrap bg-amber-50/20">
                              {pk.packingSize}
                            </td>

                            {/* 4. Basic Rate (In front of corresponding packing) */}
                            <td className="border-r border-black py-2 px-3 text-center font-black text-black align-middle whitespace-nowrap">
                              {pk.rate > 0 ? `₹ ${pk.rate.toLocaleString('en-IN')}/-` : '-'}
                            </td>

                            {/* 5. GST Rate (Spans across all packings) */}
                            {pkIdx === 0 && (
                              <td
                                rowSpan={rowCount}
                                className="border-r border-black py-2 px-2 text-center font-bold text-black align-middle whitespace-nowrap bg-white"
                              >
                                {prod.gstRate} %
                              </td>
                            )}

                            {/* 6. With GST Rate (Calculated Basic Rate + GST % in front of corresponding packing) */}
                            <td className="border-r border-black py-2 px-3 text-center font-black text-emerald-800 align-middle whitespace-nowrap bg-emerald-50/30">
                              {withGst > 0 ? `₹ ${withGst.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}/-` : '-'}
                            </td>

                            {/* 7. MRP (In front of corresponding packing) */}
                            <td className="py-2 px-3 text-center font-black text-black align-middle whitespace-nowrap">
                              {pk.mrp > 0 ? `₹ ${pk.mrp.toLocaleString('en-IN')}/-` : '-'}
                            </td>
                          </tr>
                        );
                      });
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          ))}

          {groupedProducts.length === 0 && (
            <div className="py-12 text-center text-slate-400 border-2 border-dashed border-slate-300 rounded-xl">
              <p className="text-sm font-bold">कोणतेही प्रॉडक्ट्स उपलब्ध नाहीत.</p>
              <p className="text-xs text-slate-400 mt-1">प्राईस लिस्ट फाईल अपलोड करून प्रॉडक्ट्स जोडा.</p>
            </div>
          )}
        </div>
      </div>

      <CustomDialogModal {...dialogConfig} />
    </div>
  );
};
