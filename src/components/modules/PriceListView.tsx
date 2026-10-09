import React, { useState, useEffect, useRef } from 'react';
import { collection, query, onSnapshot, doc, setDoc, deleteDoc, getDocs, writeBatch } from 'firebase/firestore';
import { db } from '../../firebase';
import { UserProfile } from '../../lib/auth';
import { logAudit } from '../../lib/dataService';
import { Language, translations } from '../../lib/i18n';
import { CustomDialogModal } from '../CustomDialogModal';
import { 
  FileSpreadsheet, 
  Search, 
  Plus, 
  Edit3, 
  Trash2, 
  X, 
  Printer, 
  Upload, 
  Loader2, 
  Download, 
  RefreshCw,
  Eye,
  CheckCircle2,
  Calendar
} from 'lucide-react';
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
  packings: PackingOption[]; // 1 or more packings (e.g. 1Kg * 25 Nos and 25 Kg)
  isArchived?: boolean;
  orderIndex?: number;
}

interface Props {
  profile: UserProfile;
  lang: Language;
}

// Master official reference data from the company's official photo
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
      { packingSize: '1Kg * 25 Nos', rate: 195, mrp: 370 },
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
      { packingSize: '1Kg * 25 Nos', rate: 225, mrp: 389 },
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
      { packingSize: '1Kg * 25 Nos', rate: 255, mrp: 397 },
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
      { packingSize: '1Kg * 25 Nos', rate: 290, mrp: 460 },
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
      { packingSize: '1Kg * 25 Nos', rate: 235, mrp: 370 },
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
      { packingSize: '1Kg * 25 Nos', rate: 180, mrp: 352 },
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
      { packingSize: '1Kg * 25 Nos', rate: 135, mrp: 325 },
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
      { packingSize: '1Kg * 25 Nos', rate: 155, mrp: 343 },
    ],
    orderIndex: 8,
  },
  {
    groupName: 'Group A - Water Soluble Fertilizers',
    code: 'A 9.',
    brandName: 'Airawat®',
    gradeName: 'Magnesium Sulphate',
    hsn: '28332990',
    gstRate: 5,
    packings: [
      { packingSize: '1Kg * 25 Nos', rate: 110, mrp: 190 },
    ],
    orderIndex: 9,
  },

  // --- Specialty Grades ---
  {
    groupName: 'Specialty Grades',
    code: 'S 1.',
    brandName: 'Airawat®',
    gradeName: '00:42:47 + Fe',
    hsn: '31054000',
    gstRate: 5,
    packings: [
      { packingSize: '2.5 Kg', rate: 1375, mrp: 2530 },
    ],
    orderIndex: 10,
  },
  {
    groupName: 'Specialty Grades',
    code: 'S 2.',
    brandName: 'Airawat®',
    gradeName: '14:48:00 + Mg',
    hsn: '31052000',
    gstRate: 5,
    packings: [
      { packingSize: '2.5 Kg', rate: 890, mrp: 2170 },
    ],
    orderIndex: 11,
  },
  {
    groupName: 'Specialty Grades',
    code: 'S 3.',
    brandName: 'Airawat®',
    gradeName: '05:55:17 + Zn + B',
    hsn: '31053000',
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

export const PriceListView: React.FC<Props> = ({ profile, lang }) => {
  const t = translations[lang];
  const [products, setProducts] = useState<DynamicPriceProduct[]>([]);
  const [search, setSearch] = useState('');
  const [validityDate, setValidityDate] = useState('Pricelist w.e.f 01/10/2026 to 31/10/2026');
  const [isUploading, setIsUploading] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [editingProduct, setEditingProduct] = useState<DynamicPriceProduct | null>(null);

  // Form State for Adding / Editing Product
  const [formGroup, setFormGroup] = useState('Group A - Water Soluble Fertilizers');
  const [formCode, setFormCode] = useState('');
  const [formBrand, setFormBrand] = useState('Airawat®');
  const [formGrade, setFormGrade] = useState('');
  const [formHsn, setFormHsn] = useState('31052000');
  const [formGst, setFormGst] = useState('5');
  const [formPackings, setFormPackings] = useState<PackingOption[]>([
    { packingSize: '25 Kg', rate: 0, mrp: 0 }
  ]);

  // Branding
  const [logoUrl, setLogoUrl] = useState<string>('');
  const [logoSize, setLogoSize] = useState<number>(75);

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

  const fileInputRef = useRef<HTMLInputElement>(null);

  // 1. Fetch Branding
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
        await seedOfficialReferenceData();
      } else {
        // Sort products by orderIndex or group and code
        list.sort((a, b) => {
          if (a.groupName !== b.groupName) {
            // Group A first, then Specialty Grades, then others
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

  // Seed / Reset to official reference data matching photo exactly
  const seedOfficialReferenceData = async () => {
    setIsResetting(true);
    try {
      // Clear legacy items in v2 to ensure zero duplicates
      const snap = await getDocs(collection(db, 'products_pricelist_v2'));
      const batch = writeBatch(db);
      snap.forEach((d) => batch.delete(d.ref));
      await batch.commit();

      // Write pristine items
      for (const item of OFFICIAL_REFERENCE_DATA) {
        const cleanId = `prod_${item.code.replace(/[^A-Za-z0-9]/g, '_')}_${item.gradeName.replace(/[^A-Za-z0-9]/g, '_')}`;
        await setDoc(doc(db, 'products_pricelist_v2', cleanId), {
          ...item,
          id: cleanId,
          isArchived: false,
        });
      }

      await setDoc(doc(db, 'config', 'pricelist_meta'), {
        validityDate: 'Pricelist w.e.f 01/10/2026 to 31/10/2026',
        updatedAt: new Date().toISOString(),
      }, { merge: true });

      await logAudit('CREATE', 'products_pricelist_v2', 'reference_seed', 'Loaded official price list matching photo reference', profile);
    } catch (err) {
      console.error('Error seeding official price list:', err);
    } finally {
      setIsResetting(false);
    }
  };

  // Upload handler: dynamically reads any PDF / Image
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsUploading(true);
    const formData = new FormData();
    formData.append('file', file);

    try {
      const response = await fetch('/api/parse-pricelist', {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        const errData = await response.json();
        throw new Error(errData.error || 'Failed to read price list');
      }

      const parsedData = await response.json();

      let extractedProducts: any[] = [];
      let extractedValidity = parsedData.validityDate || '';

      if (parsedData.products && Array.isArray(parsedData.products)) {
        extractedProducts = parsedData.products;
      } else if (Array.isArray(parsedData)) {
        // Flat legacy list: group items with same code and grade
        const groupedMap = new Map<string, any>();
        parsedData.forEach((item, idx) => {
          const key = `${item.groupName}_${item.code}_${item.name}`;
          if (!groupedMap.has(key)) {
            groupedMap.set(key, {
              groupName: item.groupName || 'Group A - Water Soluble Fertilizers',
              code: item.code || `Item ${idx + 1}`,
              brandName: 'Airawat®',
              gradeName: item.name || '',
              hsn: item.hsn || '-',
              gstRate: Number(item.gstRate) || 5,
              packings: [{
                packingSize: item.packingSize || '25 Kg',
                rate: Number(item.rate) || 0,
                mrp: Number(item.mrp) || 0,
              }],
              orderIndex: idx + 1,
            });
          } else {
            groupedMap.get(key).packings.push({
              packingSize: item.packingSize || '25 Kg',
              rate: Number(item.rate) || 0,
              mrp: Number(item.mrp) || 0,
            });
          }
        });
        extractedProducts = Array.from(groupedMap.values());
      }

      if (extractedProducts.length === 0) {
        throw new Error('No product records could be identified in the uploaded file.');
      }

      // Show in-app confirmation before applying new upload
      setDialogConfig({
        isOpen: true,
        type: 'confirm',
        title: 'New Price List Detected',
        message: `Extracted ${extractedProducts.length} product rows and grades from the uploaded document.\n\nValidity: ${extractedValidity || 'Current'}\n\nDo you want to replace the current price list with this new uploaded list?`,
        confirmText: 'Apply Price List',
        cancelText: 'Cancel',
        onConfirm: async () => {
          setDialogConfig((p) => ({ ...p, isOpen: false }));
          setIsUploading(true);

          try {
            // Clear existing items in collection to guarantee ZERO DUPLICATION
            const existingSnap = await getDocs(collection(db, 'products_pricelist_v2'));
            const batch = writeBatch(db);
            existingSnap.forEach((d) => batch.delete(d.ref));
            await batch.commit();

            // Insert new dynamically read products
            for (let i = 0; i < extractedProducts.length; i++) {
              const p = extractedProducts[i];
              const cleanCode = (p.code || `Item_${i + 1}`).replace(/[^A-Za-z0-9]/g, '_');
              const cleanGrade = (p.gradeName || p.name || `Grade_${i + 1}`).replace(/[^A-Za-z0-9]/g, '_');
              const docId = `prod_${cleanCode}_${cleanGrade}_${i + 1}`;

              const docData: DynamicPriceProduct = {
                id: docId,
                groupName: p.groupName || 'General',
                code: p.code || `${i + 1}.`,
                brandName: p.brandName || 'Airawat®',
                gradeName: p.gradeName || p.name || 'Custom Grade',
                hsn: p.hsn || '-',
                gstRate: Number(p.gstRate) || 5,
                packings: Array.isArray(p.packings) && p.packings.length > 0 
                  ? p.packings.map((pk: any) => ({
                      packingSize: String(pk.packingSize || '').trim(),
                      rate: Number(pk.rate) || 0,
                      mrp: Number(pk.mrp) || 0,
                    }))
                  : [{ packingSize: p.packingSize || '25 Kg', rate: Number(p.rate) || 0, mrp: Number(p.mrp) || 0 }],
                orderIndex: i + 1,
                isArchived: false,
              };

              await setDoc(doc(db, 'products_pricelist_v2', docId), docData);
            }

            if (extractedValidity) {
              await setDoc(doc(db, 'config', 'pricelist_meta'), {
                validityDate: extractedValidity,
                updatedAt: new Date().toISOString(),
              }, { merge: true });
              setValidityDate(extractedValidity);
            }

            await logAudit('CREATE', 'products_pricelist_v2', 'dynamic_upload', `Applied uploaded price list with ${extractedProducts.length} rows`, profile);

            setDialogConfig({
              isOpen: true,
              type: 'success',
              title: 'Upload Successful',
              message: `Price list updated!\nTotal Rows Created: ${extractedProducts.length}\nAll grades and packing rates are loaded cleanly with zero duplicates.`,
              confirmText: 'OK',
              onConfirm: () => setDialogConfig((p) => ({ ...p, isOpen: false })),
            });
          } catch (saveErr: any) {
            console.error('Error saving uploaded list:', saveErr);
            setDialogConfig({
              isOpen: true,
              type: 'alert',
              title: 'Error Saving Data',
              message: 'Failed to save price list: ' + saveErr.message,
              confirmText: 'OK',
              onConfirm: () => setDialogConfig((p) => ({ ...p, isOpen: false })),
            });
          } finally {
            setIsUploading(false);
          }
        },
        onCancel: () => setDialogConfig((p) => ({ ...p, isOpen: false })),
      });
    } catch (err: any) {
      console.error('Upload Error:', err);
      setDialogConfig({
        isOpen: true,
        type: 'alert',
        title: 'Upload Error',
        message: 'Could not parse document: ' + err.message,
        confirmText: 'OK',
        onConfirm: () => setDialogConfig((p) => ({ ...p, isOpen: false })),
      });
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  // Export to Excel (.xlsx) file
  const handleExportToExcel = () => {
    try {
      const rows: any[] = [];
      let counter = 1;

      products.forEach((prod) => {
        prod.packings.forEach((pk, pkIdx) => {
          rows.push({
            'Sr. No': pkIdx === 0 ? prod.code : '',
            'Category': pkIdx === 0 ? prod.groupName : '',
            'Brand': prod.brandName,
            'Product Grade': prod.gradeName,
            'HSN': prod.hsn,
            'Packing Size': pk.packingSize,
            'Rate (₹)': pk.rate,
            'GST Rate (%)': `${prod.gstRate} %`,
            'MRP (₹)': pk.mrp,
          });
        });
        counter++;
      });

      const worksheet = XLSX.utils.json_to_sheet(rows);
      worksheet['!cols'] = [
        { wch: 10 },
        { wch: 32 },
        { wch: 14 },
        { wch: 28 },
        { wch: 14 },
        { wch: 18 },
        { wch: 14 },
        { wch: 12 },
        { wch: 14 },
      ];

      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, worksheet, 'Price List');
      const filename = `Blackworm_Agritech_PriceList_${new Date().toISOString().slice(0, 10)}.xlsx`;
      XLSX.writeFile(workbook, filename);
    } catch (err) {
      console.error('Export failed:', err);
    }
  };

  // Edit / Add Modal Handlers
  const handleOpenAddModal = () => {
    setEditingProduct(null);
    setFormGroup('Group A - Water Soluble Fertilizers');
    setFormCode(`A ${products.length + 1}.`);
    setFormBrand('Airawat®');
    setFormGrade('');
    setFormHsn('31052000');
    setFormGst('5');
    setFormPackings([
      { packingSize: '1Kg * 25 Nos', rate: 200, mrp: 380 },
      { packingSize: '25 Kg', rate: 4000, mrp: 5500 },
    ]);
    setShowEditModal(true);
  };

  const handleOpenEditModal = (p: DynamicPriceProduct) => {
    setEditingProduct(p);
    setFormGroup(p.groupName);
    setFormCode(p.code);
    setFormBrand(p.brandName);
    setFormGrade(p.gradeName);
    setFormHsn(p.hsn);
    setFormGst(String(p.gstRate));
    setFormPackings([...p.packings]);
    setShowEditModal(true);
  };

  const handleSaveProduct = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formGrade.trim()) return;

    const id = editingProduct ? editingProduct.id : `prod_${Date.now()}`;
    const payload: DynamicPriceProduct = {
      id,
      groupName: formGroup,
      code: formCode.trim(),
      brandName: formBrand.trim(),
      gradeName: formGrade.trim(),
      hsn: formHsn.trim(),
      gstRate: Number(formGst) || 5,
      packings: formPackings.filter(pk => pk.packingSize.trim() !== ''),
      orderIndex: editingProduct?.orderIndex || products.length + 1,
      isArchived: false,
    };

    await setDoc(doc(db, 'products_pricelist_v2', id), payload, { merge: true });
    await logAudit(editingProduct ? 'UPDATE' : 'CREATE', 'products_pricelist_v2', id, `Updated price for ${payload.brandName} ${payload.gradeName}`, profile);

    setShowEditModal(false);
    setEditingProduct(null);
  };

  const handleDeleteProduct = (p: DynamicPriceProduct) => {
    setDialogConfig({
      isOpen: true,
      type: 'confirm',
      title: 'Delete Product',
      message: `Are you sure you want to delete ${p.code} ${p.brandName} ${p.gradeName}?`,
      confirmText: 'Delete',
      cancelText: 'Cancel',
      onConfirm: async () => {
        setDialogConfig(prev => ({ ...prev, isOpen: false }));
        await deleteDoc(doc(db, 'products_pricelist_v2', p.id));
        await logAudit('DELETE', 'products_pricelist_v2', p.id, `Deleted price item ${p.code} ${p.gradeName}`, profile);
      },
      onCancel: () => setDialogConfig(prev => ({ ...prev, isOpen: false })),
    });
  };

  // Group products dynamically by Category Name (e.g. Group A, Specialty Grades, etc.)
  const groupedProducts: { groupName: string; items: DynamicPriceProduct[] }[] = [];
  const groupMap = new Map<string, DynamicPriceProduct[]>();

  products.forEach((p) => {
    const matchesSearch = 
      !search ||
      p.code.toLowerCase().includes(search.toLowerCase()) ||
      p.gradeName.toLowerCase().includes(search.toLowerCase()) ||
      p.brandName.toLowerCase().includes(search.toLowerCase()) ||
      p.hsn.toLowerCase().includes(search.toLowerCase()) ||
      p.groupName.toLowerCase().includes(search.toLowerCase());

    if (matchesSearch) {
      if (!groupMap.has(p.groupName)) {
        groupMap.set(p.groupName, []);
      }
      groupMap.get(p.groupName)!.push(p);
    }
  });

  groupMap.forEach((items, groupName) => {
    groupedProducts.push({ groupName, items });
  });

  const isUserAdminOrOwner = profile.role === 'admin' || profile.role === 'owner';

  return (
    <div className="space-y-4 font-sans text-slate-900">
      {/* Top Toolbar: Action Buttons (Search, Upload, Export, Print, Reset) */}
      <div className="bg-white p-3 sm:p-4 rounded-2xl border border-slate-200 shadow-sm flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 no-print">
        <div className="relative w-full sm:w-80">
          <Search className="w-4 h-4 absolute left-3.5 top-3 text-slate-400" />
          <input
            type="text"
            placeholder="Search code, grade, HSN..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-9 pr-8 py-2 rounded-xl border border-slate-200 text-xs font-medium focus:ring-2 focus:ring-slate-900 focus:outline-none"
          />
          {search && (
            <button
              onClick={() => setSearch('')}
              className="absolute right-2.5 top-2 text-slate-400 hover:text-slate-600 p-1"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto">
          <input
            type="file"
            ref={fileInputRef}
            onChange={handleFileUpload}
            accept=".pdf,.png,.jpg,.jpeg,.webp"
            className="hidden"
          />

          {/* Upload Button: Reads any PDF or Image dynamically */}
          {isUserAdminOrOwner && (
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={isUploading}
              className="flex-1 sm:flex-none flex items-center justify-center gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white px-3.5 py-2 rounded-xl text-xs font-bold transition shadow-sm disabled:opacity-50 cursor-pointer"
              title="Upload PDF / Image price list - table automatically adapts to item count"
            >
              {isUploading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>Reading File...</span>
                </>
              ) : (
                <>
                  <Upload className="w-4 h-4" />
                  <span>Upload Price List</span>
                </>
              )}
            </button>
          )}

          {/* Export to Excel (.xlsx) */}
          <button
            onClick={handleExportToExcel}
            className="flex-1 sm:flex-none flex items-center justify-center gap-1.5 bg-slate-700 hover:bg-slate-800 text-white px-3 py-2 rounded-xl text-xs font-bold transition shadow-sm cursor-pointer"
            title="Download Excel Spreadsheet"
          >
            <Download className="w-4 h-4" />
            <span>Excel</span>
          </button>

          {/* Print Price List */}
          <button
            onClick={() => window.print()}
            className="flex-1 sm:flex-none flex items-center justify-center gap-1.5 bg-slate-900 hover:bg-black text-white px-3 py-2 rounded-xl text-xs font-bold transition shadow-sm cursor-pointer"
            title="Print Official A4 Price List"
          >
            <Printer className="w-4 h-4" />
            <span>Print</span>
          </button>

          {/* Add Product Row */}
          {isUserAdminOrOwner && (
            <button
              onClick={handleOpenAddModal}
              className="flex-1 sm:flex-none flex items-center justify-center gap-1.5 bg-rose-600 hover:bg-rose-700 text-white px-3 py-2 rounded-xl text-xs font-bold transition shadow-sm cursor-pointer"
              title="Add New Grade / Row to Table"
            >
              <Plus className="w-4 h-4" />
              <span>Add Grade</span>
            </button>
          )}

          {/* Reset / Sync Reference Photo Data */}
          {isUserAdminOrOwner && (
            <button
              onClick={() => {
                setDialogConfig({
                  isOpen: true,
                  type: 'confirm',
                  title: 'Reset to Reference Design',
                  message: 'Do you want to reset the price list to the exact 17 products from the official reference document?',
                  confirmText: 'Reset to Reference',
                  cancelText: 'Cancel',
                  onConfirm: async () => {
                    setDialogConfig((p) => ({ ...p, isOpen: false }));
                    await seedOfficialReferenceData();
                  },
                  onCancel: () => setDialogConfig((p) => ({ ...p, isOpen: false })),
                });
              }}
              disabled={isResetting}
              className="p-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl transition cursor-pointer"
              title="Reset to Reference Image List"
            >
              <RefreshCw className={`w-4 h-4 ${isResetting ? 'animate-spin' : ''}`} />
            </button>
          )}
        </div>
      </div>

      {/* ========================================================================= */}
      {/* THE CONTINUOUS OFFICIAL PRICE LIST (EXACT REPLICA OF THE REFERENCE IMAGE)  */}
      {/* ========================================================================= */}
      <div className="bg-white p-4 sm:p-8 rounded-2xl border border-slate-200 shadow-sm print:border-none print:shadow-none print:p-0 max-w-5xl mx-auto overflow-hidden">
        
        {/* Top Header: !! Shri !! */}
        <div className="text-center mb-1">
          <span className="text-xs sm:text-sm italic font-serif text-black font-semibold">
            !! Shri !!
          </span>
        </div>

        {/* Company Header: Logo on Left, Full Company Details on Right */}
        <div className="flex flex-col sm:flex-row items-center sm:items-start justify-between gap-4 pb-4">
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

          {/* Company Text Right (Exact Match to Reference Photo) */}
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
          <span className="text-xs sm:text-sm font-black text-cyan-700 tracking-wide">
            {validityDate}
          </span>
        </div>

        {/* DYNAMIC SECTIONS & CONTINUOUS TABLES */}
        <div className="space-y-6">
          {groupedProducts.map((section) => (
            <div key={section.groupName} className="space-y-2">
              {/* Category Heading in Bold Green (Matching Photo) */}
              <h2 className="text-xs sm:text-sm font-black text-emerald-700 tracking-tight">
                {section.groupName}
              </h2>

              {/* Responsive Scroll Wrapper */}
              <div className="overflow-x-auto">
                {/* Continuous Table with Exact Black Borders */}
                <table className="w-full border-collapse border-2 border-black text-xs font-sans">
                  {/* Table Headers */}
                  <thead className="bg-white text-black font-black">
                    <tr className="border-b-2 border-black">
                      <th className="border border-black py-2 px-2 text-center w-14 whitespace-nowrap">
                        Sr.<br />No.
                      </th>
                      <th className="border border-black py-2 px-3 text-center min-w-[200px]">
                        Product Name
                      </th>
                      <th className="border border-black py-2 px-2 text-center w-24 whitespace-nowrap">
                        HSN
                      </th>
                      <th className="border border-black py-2 px-3 text-center w-32 whitespace-nowrap">
                        Packing Size
                      </th>
                      <th className="border border-black py-2 px-3 text-center w-24 whitespace-nowrap">
                        Rate
                      </th>
                      <th className="border border-black py-2 px-2 text-center w-20 whitespace-nowrap">
                        GST<br />Rate
                      </th>
                      <th className="border border-black py-2 px-3 text-center w-24 whitespace-nowrap">
                        MRP
                      </th>
                      {isUserAdminOrOwner && (
                        <th className="border border-black py-2 px-2 text-center w-16 no-print">
                          Action
                        </th>
                      )}
                    </tr>
                  </thead>

                  {/* Table Rows (Exactly 1 Continuous Row per Product, Stacked Packings inside) */}
                  <tbody>
                    {section.items.map((prod) => (
                      <tr key={prod.id} className="border-b border-black hover:bg-slate-50/80 transition-colors">
                        {/* Sr. No / Code */}
                        <td className="border border-black py-2 px-2 text-center font-bold text-black align-middle whitespace-nowrap font-serif">
                          {prod.code}
                        </td>

                        {/* Product Name: Brand in Orange/Rust, Grade in Bold Blue (Matching Photo) */}
                        <td className="border border-black py-2 px-3 text-center align-middle">
                          <div className="flex flex-col items-center justify-center leading-tight">
                            <span className="text-[11px] font-bold text-amber-700 font-sans tracking-tight">
                              {prod.brandName || 'Airawat®'}
                            </span>
                            <span className="text-xs sm:text-[13px] font-black text-sky-600 font-sans tracking-tight">
                              {prod.gradeName}
                            </span>
                          </div>
                        </td>

                        {/* HSN Code */}
                        <td className="border border-black py-2 px-2 text-center font-bold text-black align-middle whitespace-nowrap">
                          {prod.hsn}
                        </td>

                        {/* Packing Size: Stacked neatly if multiple variants exist */}
                        <td className="border border-black py-2 px-3 text-center font-bold text-black align-middle">
                          <div className="flex flex-col items-center justify-center space-y-1">
                            {prod.packings.map((pk, idx) => (
                              <span key={idx} className="whitespace-nowrap leading-tight">
                                {pk.packingSize}
                              </span>
                            ))}
                          </div>
                        </td>

                        {/* Rate: Stacked with '/-' notation (Matching Photo) */}
                        <td className="border border-black py-2 px-3 text-center font-black text-black align-middle">
                          <div className="flex flex-col items-center justify-center space-y-1">
                            {prod.packings.map((pk, idx) => (
                              <span key={idx} className="whitespace-nowrap leading-tight">
                                {pk.rate}/-
                              </span>
                            ))}
                          </div>
                        </td>

                        {/* GST Rate: '5 %' */}
                        <td className="border border-black py-2 px-2 text-center font-bold text-black align-middle whitespace-nowrap">
                          {prod.gstRate} %
                        </td>

                        {/* MRP: Stacked with '/-' notation (Matching Photo) */}
                        <td className="border border-black py-2 px-3 text-center font-black text-black align-middle">
                          <div className="flex flex-col items-center justify-center space-y-1">
                            {prod.packings.map((pk, idx) => (
                              <span key={idx} className="whitespace-nowrap leading-tight">
                                {pk.mrp}/-
                              </span>
                            ))}
                          </div>
                        </td>

                        {/* Actions for Admin / Owner (Hidden in Print) */}
                        {isUserAdminOrOwner && (
                          <td className="border border-black py-2 px-1 text-center align-middle no-print">
                            <div className="flex items-center justify-center gap-1">
                              <button
                                type="button"
                                onClick={() => handleOpenEditModal(prod)}
                                className="p-1 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded transition cursor-pointer"
                                title="Edit Product"
                              >
                                <Edit3 className="w-3.5 h-3.5" />
                              </button>
                              <button
                                type="button"
                                onClick={() => handleDeleteProduct(prod)}
                                className="p-1 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded transition cursor-pointer"
                                title="Delete Product"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}

          {groupedProducts.length === 0 && (
            <div className="py-12 text-center text-slate-400 border-2 border-dashed border-slate-300 rounded-xl">
              <p className="text-sm font-bold">No product rows in price list.</p>
              <p className="text-xs text-slate-400 mt-1">Upload a price list PDF or click 'Add Grade' to insert rows.</p>
            </div>
          )}
        </div>
      </div>

      {/* Modal: Add / Edit Product Grade & Packings */}
      {showEditModal && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-xs z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl max-w-lg w-full p-6 shadow-2xl border border-slate-100 max-h-[92vh] overflow-y-auto">
            <div className="flex justify-between items-center border-b border-slate-100 pb-3">
              <h3 className="text-base font-black text-slate-900">
                {editingProduct ? 'Edit Product Row' : 'Add New Product Row'}
              </h3>
              <button 
                onClick={() => setShowEditModal(false)}
                className="text-slate-400 hover:text-slate-600 p-1 rounded-lg"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSaveProduct} className="space-y-4 pt-4">
              <div>
                <label className="text-xs font-bold text-slate-700 block mb-1">Category / Group *</label>
                <input 
                  type="text" 
                  required
                  placeholder="e.g. Group A - Water Soluble Fertilizers or Specialty Grades"
                  value={formGroup}
                  onChange={(e) => setFormGroup(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-200 rounded-xl text-xs font-medium focus:ring-2 focus:ring-slate-900 focus:outline-none"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-bold text-slate-700 block mb-1">Sr. No / Code *</label>
                  <input 
                    type="text" 
                    required 
                    placeholder="e.g. A 1. or S 7."
                    value={formCode} 
                    onChange={(e) => setFormCode(e.target.value)} 
                    className="w-full px-3 py-2 border border-slate-200 rounded-xl text-xs font-bold focus:ring-2 focus:ring-slate-900 focus:outline-none" 
                  />
                </div>
                <div>
                  <label className="text-xs font-bold text-slate-700 block mb-1">HSN Code *</label>
                  <input 
                    type="text" 
                    required 
                    placeholder="e.g. 31052000"
                    value={formHsn} 
                    onChange={(e) => setFormHsn(e.target.value)} 
                    className="w-full px-3 py-2 border border-slate-200 rounded-xl text-xs font-mono focus:ring-2 focus:ring-slate-900 focus:outline-none" 
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-bold text-slate-700 block mb-1">Brand Name *</label>
                  <input 
                    type="text" 
                    required 
                    placeholder="e.g. Airawat®"
                    value={formBrand} 
                    onChange={(e) => setFormBrand(e.target.value)} 
                    className="w-full px-3 py-2 border border-slate-200 rounded-xl text-xs font-bold text-amber-700 focus:ring-2 focus:ring-slate-900 focus:outline-none" 
                  />
                </div>
                <div>
                  <label className="text-xs font-bold text-slate-700 block mb-1">Product Grade *</label>
                  <input 
                    type="text" 
                    required 
                    placeholder="e.g. 19:19:19 or 11:44:11 + Zn"
                    value={formGrade} 
                    onChange={(e) => setFormGrade(e.target.value)} 
                    className="w-full px-3 py-2 border border-slate-200 rounded-xl text-xs font-black text-sky-600 focus:ring-2 focus:ring-slate-900 focus:outline-none" 
                  />
                </div>
              </div>

              {/* Dynamic Packing Variants (Multiple Packings per Product) */}
              <div className="space-y-2 pt-2 border-t border-slate-100">
                <div className="flex justify-between items-center">
                  <label className="text-xs font-black text-slate-800">
                    Packing Sizes, Rates & MRPs
                  </label>
                  <button
                    type="button"
                    onClick={() => setFormPackings([...formPackings, { packingSize: '', rate: 0, mrp: 0 }])}
                    className="text-[11px] font-bold text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded-md hover:bg-emerald-100"
                  >
                    + Add Packing Size
                  </button>
                </div>

                {formPackings.map((pk, idx) => (
                  <div key={idx} className="p-2.5 bg-slate-50 border border-slate-200 rounded-xl grid grid-cols-12 gap-2 items-center">
                    <div className="col-span-5">
                      <span className="text-[10px] text-slate-500 font-bold block mb-0.5">Packing</span>
                      <input
                        type="text"
                        placeholder="e.g. 1Kg * 25 Nos or 25 Kg"
                        value={pk.packingSize}
                        onChange={(e) => {
                          const updated = [...formPackings];
                          updated[idx].packingSize = e.target.value;
                          setFormPackings(updated);
                        }}
                        className="w-full px-2 py-1.5 bg-white border border-slate-200 rounded-lg text-xs font-medium"
                      />
                    </div>
                    <div className="col-span-3">
                      <span className="text-[10px] text-slate-500 font-bold block mb-0.5">Rate (₹)</span>
                      <input
                        type="number"
                        placeholder="Rate"
                        value={pk.rate || ''}
                        onChange={(e) => {
                          const updated = [...formPackings];
                          updated[idx].rate = Number(e.target.value);
                          setFormPackings(updated);
                        }}
                        className="w-full px-2 py-1.5 bg-white border border-slate-200 rounded-lg text-xs font-bold"
                      />
                    </div>
                    <div className="col-span-3">
                      <span className="text-[10px] text-slate-500 font-bold block mb-0.5">MRP (₹)</span>
                      <input
                        type="number"
                        placeholder="MRP"
                        value={pk.mrp || ''}
                        onChange={(e) => {
                          const updated = [...formPackings];
                          updated[idx].mrp = Number(e.target.value);
                          setFormPackings(updated);
                        }}
                        className="w-full px-2 py-1.5 bg-white border border-slate-200 rounded-lg text-xs font-bold"
                      />
                    </div>
                    <div className="col-span-1 text-center pt-3">
                      {formPackings.length > 1 && (
                        <button
                          type="button"
                          onClick={() => setFormPackings(formPackings.filter((_, i) => i !== idx))}
                          className="text-slate-400 hover:text-rose-600"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              <div className="pt-3 flex gap-3">
                <button
                  type="button"
                  onClick={() => setShowEditModal(false)}
                  className="flex-1 py-2.5 rounded-xl border border-slate-200 text-xs font-bold text-slate-600 hover:bg-slate-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="flex-1 py-2.5 rounded-xl bg-slate-900 hover:bg-black text-xs font-bold text-white shadow-sm"
                >
                  Save Product Row
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Clean In-App Custom Confirmation & Alert Dialog (No Browser alert) */}
      <CustomDialogModal {...dialogConfig} />
    </div>
  );
};
