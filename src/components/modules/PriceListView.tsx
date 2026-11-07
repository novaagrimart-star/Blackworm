import React, { useState, useEffect, useRef } from 'react';
import { collection, query, onSnapshot, doc, setDoc, getDoc, getDocs, writeBatch, limit, orderBy } from 'firebase/firestore';
import { db } from '../../firebase';
import { UserProfile, isAdmin } from '../../lib/auth';
import { Language } from '../../lib/i18n';
import { CustomDialogModal } from '../CustomDialogModal';
import { cn } from '../../lib/utils';
import { 
  Upload, 
  Download, 
  RefreshCw, 
  Loader2, 
  FileSpreadsheet, 
  ShieldCheck, 
  History, 
  Database, 
  CheckCircle2, 
  RotateCcw, 
  X, 
  Check
} from 'lucide-react';
import { logAudit, deduplicateProducts, getCanonicalProductKey, normalizePackingSize } from '../../lib/dataService';
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

// Helper: Read cached products instantly from localStorage (0ms display)
export const getInitialCachedProducts = (): DynamicPriceProduct[] => {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem('blackworm_cached_pricelist');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) return deduplicateProducts(parsed);
    }
    const masterRaw = localStorage.getItem('blackworm_master_pricelist');
    if (masterRaw) {
      const parsed = JSON.parse(masterRaw);
      if (parsed && Array.isArray(parsed.products) && parsed.products.length > 0) return deduplicateProducts(parsed.products);
    }
  } catch (e) {}
  return [];
};

// Helper: Clean numeric string to number (handles ₹, commas, /-, spaces)
export const cleanNumber = (val: any, fallback = 0): number => {
  if (val === null || val === undefined) return fallback;
  if (typeof val === 'number') return isNaN(val) ? fallback : val;
  const cleaned = String(val).replace(/[^0-9.-]/g, '');
  const num = parseFloat(cleaned);
  return isNaN(num) ? fallback : num;
};

// Helper: Normalize string for fuzzy matching (case, spaces, symbols)
export const normStr = (s: string): string => {
  return (s || '')
    .toLowerCase()
    .replace(/®/g, '')
    .replace(/blackworm|airawat/g, '')
    .replace(/[^a-z0-9]/g, '');
};

// Robust Excel Parser: Supports multi-sheet, dynamic header rows (row 0, 1, 2, 3+), Marathi/English headers, horizontal/vertical packings, and sub-rows
export function parseExcelToProducts(workbook: XLSX.WorkBook): { products: DynamicPriceProduct[]; validity?: string } {
  const allParsed: DynamicPriceProduct[] = [];
  let foundValidity = '';

  for (const sheetName of workbook.SheetNames) {
    const worksheet = workbook.Sheets[sheetName];
    if (!worksheet) continue;

    const rawRows = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '' }) as any[][];
    if (!rawRows || rawRows.length === 0) continue;

    // Scan for validity date in top 10 rows
    for (let r = 0; r < Math.min(10, rawRows.length); r++) {
      const rowStr = (rawRows[r] || []).map(c => String(c || '')).join(' ');
      const match = rowStr.match(/pricelist\s*w\.?e\.?f\.?[^,;\n]+/i) || rowStr.match(/w\.?e\.?f\.?\s*\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}[^\n]*/i);
      if (match && !foundValidity) {
        foundValidity = match[0].trim();
      }
    }

    // Find the header row by scoring distinct column matches
    let headerRowIdx = -1;
    let maxHeaderScore = 0;

    for (let r = 0; r < Math.min(15, rawRows.length); r++) {
      const row = rawRows[r] || [];
      let score = 0;
      for (const cell of row) {
        const c = String(cell || '').trim().toLowerCase();
        if (/(grade|product|item|particular|description|material|तपशील|प्रॉडक्ट|उत्पादन|नाव)/i.test(c)) score += 3;
        if (/(basic\s*rate|company\s*price|price|rate|दर|किंमत|रक्कम|dp|billing)/i.test(c)) score += 3;
        if (/(pack|size|वजन|पॅकिंग|पॅक|unit)/i.test(c)) score += 2;
        if (/(m\.?r\.?p|एमआरपी)/i.test(c)) score += 2;
        if (/(gst|tax|जीएसटी|hsn)/i.test(c)) score += 1;
        if (/(sr|s\.n|code|क्रमांक|क्र|अ\.क्र|no\.)/i.test(c)) score += 1;
        if (/(category|group|विभाग|गट|वर्ग)/i.test(c)) score += 1;
      }
      if (score > maxHeaderScore && score >= 4) {
        maxHeaderScore = score;
        headerRowIdx = r;
      }
    }

    if (headerRowIdx === -1) {
      headerRowIdx = 0;
    }

    const headerRow = rawRows[headerRowIdx] || [];
    const headers = headerRow.map((c: any) => String(c || '').trim().toLowerCase());

    let gradeCol = -1;
    let packCol = -1;
    let rateCol = -1;
    let mrpCol = -1;
    let gstCol = -1;
    let groupCol = -1;
    let codeCol = -1;
    let brandCol = -1;
    let hsnCol = -1;

    // Also support horizontal packings (e.g. 1 Kg Rate, 25 Kg Rate)
    let rate1KgCol = -1;
    let mrp1KgCol = -1;
    let rate25KgCol = -1;
    let mrp25KgCol = -1;

    headers.forEach((h: string, idx: number) => {
      // Check horizontal packing columns
      if (/1\s*kg.*(rate|price|दर|किंमत|basic)|basic.*1\s*kg/i.test(h)) {
        rate1KgCol = idx;
      } else if (/1\s*kg.*mrp|mrp.*1\s*kg/i.test(h)) {
        mrp1KgCol = idx;
      } else if (/25\s*kg.*(rate|price|दर|किंमत|basic)|basic.*25\s*kg/i.test(h)) {
        rate25KgCol = idx;
      } else if (/25\s*kg.*mrp|mrp.*25\s*kg/i.test(h)) {
        mrp25KgCol = idx;
      }

      if (gradeCol === -1 && /(product\s*name|product\s*grade|grade\s*name|grade|product|item\s*name|item|particulars|particular|description|desc|details|material|नाव|उत्पादन|प्रॉडक्ट|तपशील|chemical)/i.test(h)) {
        gradeCol = idx;
      }
      if (packCol === -1 && /(packing\s*size|pack\s*size|packing|pack|size|weight|वजन|पॅकिंग|पॅक|unit)/i.test(h)) {
        packCol = idx;
      }
      if (rateCol === -1 && /(basic\s*rate|company\s*price|company\s*rate|billing\s*rate|net\s*rate|basic|rate|price|दर|किंमत|रक्कम|dp|unit\s*price)/i.test(h)) {
        rateCol = idx;
      }
      if (mrpCol === -1 && /(m\.?r\.?p|max\s*retail|retail\s*price|एमआरपी)/i.test(h)) {
        mrpCol = idx;
      }
      if (gstCol === -1 && /(gst\s*rate|gst\s*%|gst|tax\s*%|tax|जीएसटी)/i.test(h)) {
        gstCol = idx;
      }
      if (groupCol === -1 && /(group\s*name|group|category|cat|classification|विभाग|गट|वर्ग|section)/i.test(h)) {
        groupCol = idx;
      }
      if (codeCol === -1 && /(item\s*code|item\s*no|sr\.?\s*no|s\.?n\.?|code|क्रमांक|क्र|अ\.क्र|no\.)/i.test(h)) {
        codeCol = idx;
      }
      if (brandCol === -1 && /(brand\s*name|brand|make|company|ब्रँड|कंपनी)/i.test(h)) {
        brandCol = idx;
      }
      if (hsnCol === -1 && /(hsn\s*code|hsn|एचएसएन)/i.test(h)) {
        hsnCol = idx;
      }
    });

    if (gradeCol === -1) {
      gradeCol = headers.length > 1 ? 1 : 0;
    }
    if (rateCol === -1 && rate1KgCol === -1) {
      rateCol = headers.findIndex((_, idx) => idx !== gradeCol && idx !== packCol);
    }

    let currentSection = 'Group A - Water Soluble Fertilizers';
    const productMap = new Map<string, DynamicPriceProduct>();
    let lastProduct: DynamicPriceProduct | null = null;

    for (let r = headerRowIdx + 1; r < rawRows.length; r++) {
      const row = rawRows[r] as any[];
      if (!row || row.length === 0) continue;

      // Section header detection (e.g. "Specialty Grades", "Group A - Water Soluble Fertilizers")
      const nonBlankCells = (row || [])
        .map((c: any, i: number) => ({ val: String(c || '').trim(), idx: i }))
        .filter((c: { val: string; idx: number }) => c.val.length > 0);

      if (nonBlankCells.length === 1 && nonBlankCells[0].val.length > 3) {
        const text = nonBlankCells[0].val;
        if (/group|specialty|micro|fertilizer|grade|वर्ग|गट|विभाग|bio|water\s*soluble/i.test(text) && !/\d{3,}/.test(text)) {
          currentSection = text;
          lastProduct = null;
          continue;
        }
      }

      const rawGrade = (gradeCol !== -1 ? String(row[gradeCol] || '').trim() : '');
      const rawPacking = (packCol !== -1 ? String(row[packCol] || '').trim() : '');
      const rate = cleanNumber(rateCol !== -1 ? row[rateCol] : 0, 0);
      const mrp = cleanNumber(mrpCol !== -1 ? row[mrpCol] : 0, Math.round(rate * 1.3));

      // CASE A: Merged cell or continuation row for previous product's 2nd packing (e.g. 25 Kg row right below 1 Kg)
      if (!rawGrade || rawGrade.toLowerCase() === 'total' || rawGrade.toLowerCase() === 'एकूण') {
        if (lastProduct && (rawPacking || rate > 0)) {
          const pSize = rawPacking || '25 Kg';
          const pkIdx = lastProduct.packings.findIndex(p => normStr(p.packingSize) === normStr(pSize));
          if (pkIdx >= 0) {
            lastProduct.packings[pkIdx] = { packingSize: pSize, rate, mrp };
          } else {
            lastProduct.packings.push({ packingSize: pSize, rate, mrp });
          }
        }
        continue;
      }

      const groupName = (groupCol !== -1 && String(row[groupCol] || '').trim()) || currentSection;
      let code = (codeCol !== -1 && String(row[codeCol] || '').trim()) || '';
      const brandName = (brandCol !== -1 && String(row[brandCol] || '').trim()) || 'Airawat®';
      const hsn = (hsnCol !== -1 && String(row[hsnCol] || '').trim()) || '31052000';
      const gstRate = cleanNumber(gstCol !== -1 ? row[gstCol] : 5, 5);

      // Auto-extract code if embedded in gradeName (e.g. "A 1. 19:19:19" or "1. 19:19:19")
      let cleanGradeName = rawGrade;
      const codeMatch = rawGrade.match(/^([A-Za-z]?\s*\d+\.?)\s+(.+)$/);
      if (codeMatch && !code) {
        code = codeMatch[1].trim();
        cleanGradeName = codeMatch[2].trim();
      }

      const normGrade = normStr(cleanGradeName);
      const key = `${groupName.toLowerCase()}___${normGrade}`;

      // Build packings array
      const packings: PackingOption[] = [];

      // Check if horizontal format (1 Kg and 25 Kg in separate columns)
      if (rate1KgCol !== -1 && row[rate1KgCol] !== undefined && row[rate1KgCol] !== '') {
        const r1 = cleanNumber(row[rate1KgCol], 0);
        const m1 = cleanNumber(mrp1KgCol !== -1 ? row[mrp1KgCol] : 0, Math.round(r1 * 1.3));
        packings.push({ packingSize: '1 Kg', rate: r1, mrp: m1 });
      }
      if (rate25KgCol !== -1 && row[rate25KgCol] !== undefined && row[rate25KgCol] !== '') {
        const r25 = cleanNumber(row[rate25KgCol], 0);
        const m25 = cleanNumber(mrp25KgCol !== -1 ? row[mrp25KgCol] : 0, Math.round(r25 * 1.3));
        packings.push({ packingSize: '25 Kg', rate: r25, mrp: m25 });
      }

      // If vertical format
      if (packings.length === 0) {
        const pSize = rawPacking || '25 Kg';
        packings.push({ packingSize: pSize, rate, mrp });
      }

      if (!productMap.has(key)) {
        const cleanId = `prod_${(code || `item_${productMap.size + 1}`).replace(/[^A-Za-z0-9]/g, '_')}_${cleanGradeName.replace(/[^A-Za-z0-9]/g, '_')}`;
        const newProduct: DynamicPriceProduct = {
          id: cleanId,
          groupName,
          code: code || `${productMap.size + 1}.`,
          brandName,
          gradeName: cleanGradeName,
          hsn,
          gstRate,
          packings,
          orderIndex: productMap.size + 1,
          isArchived: false,
        };
        productMap.set(key, newProduct);
        lastProduct = newProduct;
      } else {
        const existing = productMap.get(key)!;
        packings.forEach(pk => {
          const pkIdx = existing.packings.findIndex(p => normStr(p.packingSize) === normStr(pk.packingSize));
          if (pkIdx >= 0) {
            existing.packings[pkIdx] = { ...pk };
          } else {
            existing.packings.push({ ...pk });
          }
        });
        lastProduct = existing;
      }
    }

    productMap.forEach(prod => allParsed.push(prod));
  }

  return { products: allParsed, validity: foundValidity };
}

// Intelligent Merge Engine: Detects new products added and price changes with precision
export function mergeUploadedProducts(
  uploadedProducts: DynamicPriceProduct[],
  currentProducts: DynamicPriceProduct[]
): {
  merged: DynamicPriceProduct[];
  newAddedCount: number;
  priceUpdatedCount: number;
} {
  let newAddedCount = 0;
  let priceUpdatedCount = 0;

  // Clean and deduplicate current products
  const baseProducts = currentProducts && currentProducts.length > 0 
    ? currentProducts 
    : OFFICIAL_REFERENCE_DATA.map((p, idx) => ({ ...p, id: `ref_${idx + 1}` }));
  const cleanCurrent = deduplicateProducts(baseProducts);
  const cleanUploaded = deduplicateProducts(uploadedProducts);

  const resultMap = new Map<string, DynamicPriceProduct>();
  cleanCurrent.forEach(p => {
    const key = getCanonicalProductKey(p);
    resultMap.set(key, { ...p, packings: [...(p.packings || []).map(pk => ({ ...pk }))] });
  });

  cleanUploaded.forEach((up, upIdx) => {
    const upKey = getCanonicalProductKey(up);
    let matchedKey: string | null = null;

    if (resultMap.has(upKey)) {
      matchedKey = upKey;
    } else {
      // Fallback matching: normalized code in the same category
      for (const [key, cur] of resultMap.entries()) {
        const curCode = (cur.code || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        const upCode = (up.code || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        const sameGroup = cur.groupName.toLowerCase().replace(/[^a-z]/g, '') === up.groupName.toLowerCase().replace(/[^a-z]/g, '');
        if (curCode && upCode && curCode === upCode && sameGroup) {
          matchedKey = key;
          break;
        }
      }
    }

    if (matchedKey) {
      // Existing product found -> UPDATE prices and packings!
      const existing = resultMap.get(matchedKey)!;
      let hasPriceChange = false;

      (up.packings || []).forEach(upPk => {
        const cleanSize = normalizePackingSize(upPk.packingSize);
        const existingPkIdx = existing.packings.findIndex(p => normalizePackingSize(p.packingSize) === cleanSize);
        if (existingPkIdx >= 0) {
          const oldPk = existing.packings[existingPkIdx];
          if ((upPk.rate > 0 && oldPk.rate !== upPk.rate) || (upPk.mrp > 0 && oldPk.mrp !== upPk.mrp)) {
            hasPriceChange = true;
          }
          existing.packings[existingPkIdx] = {
            packingSize: cleanSize,
            rate: upPk.rate > 0 ? upPk.rate : oldPk.rate,
            mrp: upPk.mrp > 0 ? upPk.mrp : oldPk.mrp,
          };
        } else {
          // New packing size added to existing product!
          existing.packings.push({
            packingSize: cleanSize,
            rate: upPk.rate,
            mrp: upPk.mrp
          });
          hasPriceChange = true;
        }
      });

      if (up.gstRate && up.gstRate !== existing.gstRate) {
        existing.gstRate = up.gstRate;
        hasPriceChange = true;
      }
      if (up.brandName && up.brandName !== 'Airawat®') {
        existing.brandName = up.brandName;
      }
      if (up.hsn) existing.hsn = up.hsn;

      if (hasPriceChange) {
        priceUpdatedCount++;
      }
    } else {
      // NEW PRODUCT ADDED!
      newAddedCount++;
      const newId = `prod_${Date.now()}_${upIdx + 1}`;
      resultMap.set(upKey || newId, {
        ...up,
        id: newId,
        orderIndex: resultMap.size + 1,
        isArchived: false,
      });
    }
  });

  const merged = deduplicateProducts(Array.from(resultMap.values()));
  return { merged, newAddedCount, priceUpdatedCount };
}

// Permanent Storage Engine: Saves to Firestore Master Doc, Collection, Backup Collection, and LocalStorage
export async function savePriceListPermanently(
  newProducts: DynamicPriceProduct[],
  sourceLabel: string,
  profile: UserProfile,
  validityDate?: string,
  currentProducts: DynamicPriceProduct[] = []
): Promise<{ success: boolean; count: number }> {
  const cleanProducts = deduplicateProducts(newProducts);
  if (!cleanProducts || cleanProducts.length === 0) {
    throw new Error('प्रॉडक्ट्स लिस्ट रिकामी आहे. कोणतीही माहिती सेव्ह केली गेली नाही.');
  }

  // 1. Instant local caching for 0ms refresh / offline / mobile sync
  try {
    localStorage.setItem('blackworm_cached_pricelist', JSON.stringify(cleanProducts));
    localStorage.setItem('blackworm_master_pricelist', JSON.stringify({
      products: cleanProducts,
      validityDate: validityDate || 'Pricelist w.e.f 01/10/2026 to 31/10/2026',
      updatedAt: new Date().toISOString(),
      updatedByUid: profile.uid,
      updatedByName: profile.fullName || 'Admin',
      isCustomUploaded: true,
      totalProducts: cleanProducts.length,
    }));
  } catch (e) {
    console.warn('Local storage write notice:', e);
  }
  // 2. Automated Permanent Backup of previous state
  try {
    const backupId = `backup_${Date.now()}`;
    await setDoc(doc(db, 'pricelist_backups', backupId), {
      id: backupId,
      backupId,
      createdAt: new Date().toISOString(),
      performedByUid: profile.uid,
      performedByName: profile.fullName || profile.loginId || 'Admin',
      source: sourceLabel,
      previousProductsCount: currentProducts.length,
      previousProducts: currentProducts,
    });
  } catch (backupErr) {
    console.warn('Pre-upload automatic backup notice:', backupErr);
  }

  // 3. Save to Master Document config/master_pricelist (Single atomic source of truth)
  await setDoc(doc(db, 'config', 'master_pricelist'), {
    products: cleanProducts,
    validityDate: validityDate || 'Pricelist w.e.f 01/10/2026 to 31/10/2026',
    updatedAt: new Date().toISOString(),
    updatedByUid: profile.uid,
    updatedByName: profile.fullName || 'Admin',
    isCustomUploaded: true,
    totalProducts: cleanProducts.length,
    source: sourceLabel,
  }, { merge: true });

  if (validityDate) {
    try {
      await setDoc(doc(db, 'config', 'pricelist_meta'), {
        validityDate,
        updatedAt: new Date().toISOString(),
      }, { merge: true });
    } catch {}
  }

  // 4. Batch Upsert products into products_pricelist_v2 in chunks of 400 (Ultra fast atomic commits)
  try {
    const BATCH_SIZE = 400;
    for (let i = 0; i < cleanProducts.length; i += BATCH_SIZE) {
      const chunk = cleanProducts.slice(i, i + BATCH_SIZE);
      const batch = writeBatch(db);
      chunk.forEach(item => {
        const itemRef = doc(db, 'products_pricelist_v2', item.id);
        batch.set(itemRef, {
          ...item,
          isArchived: false,
          updatedAt: new Date().toISOString(),
        }, { merge: true });
      });
      await batch.commit();
    }
  } catch (upsertErr) {
    console.warn('Batch upsert products notice:', upsertErr);
  }

  // 5. Soft-archive any duplicate or superseded products in products_pricelist_v2
  try {
    const cleanIds = new Set(cleanProducts.map(p => p.id));
    const cleanCanonicalKeys = new Set(cleanProducts.map(p => getCanonicalProductKey(p)));
    const oldSnap = await getDocs(collection(db, 'products_pricelist_v2'));
    const archiveBatch = writeBatch(db);
    let count = 0;
    oldSnap.forEach(d => {
      const data = d.data();
      const dKey = getCanonicalProductKey(data);
      if (!cleanIds.has(d.id) && (!data.isArchived || cleanCanonicalKeys.has(dKey))) {
        archiveBatch.update(d.ref, { isArchived: true, archivedAt: new Date().toISOString() });
        count++;
      }
    });
    if (count > 0) {
      await archiveBatch.commit();
    }
  } catch (archErr) {
    console.warn('Soft-archive notice:', archErr);
  }

  // 6. Audit Log
  try {
    await logAudit(
      'UPDATE',
      'products_pricelist_v2',
      'master_pricelist',
      `Permanently saved and updated Price List (${newProducts.length} products) from ${sourceLabel}`,
      profile
    );
  } catch (auditErr) {
    console.warn('Audit log write notice:', auditErr);
  }

  return { success: true, count: newProducts.length };
}

export const PriceListView: React.FC<Props> = ({ profile }) => {
  // Pre-load from instant cache for 0ms initial render
  const [products, setProducts] = useState<DynamicPriceProduct[]>(getInitialCachedProducts);
  const [validityDate, setValidityDate] = useState('Pricelist w.e.f 01/10/2026 to 31/10/2026');
  const [logoUrl, setLogoUrl] = useState<string>('');
  const [logoSize, setLogoSize] = useState<number>(75);
  const [isUploading, setIsUploading] = useState<boolean>(false);
  const [uploadStatusMessage, setUploadStatusMessage] = useState<string>('');
  const [isResetting, setIsResetting] = useState<boolean>(false);

  // Backup & Restore state
  const [showBackupModal, setShowBackupModal] = useState<boolean>(false);
  const [backupList, setBackupList] = useState<any[]>([]);
  const [isLoadingBackups, setIsLoadingBackups] = useState<boolean>(false);
  const [isRestoringBackup, setIsRestoringBackup] = useState<boolean>(false);

  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);
  const isUploadingRef = useRef<boolean>(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleManualRefresh = async () => {
    setIsRefreshing(true);
    try {
      const masterSnap = await getDoc(doc(db, 'config', 'master_pricelist'));
      if (masterSnap.exists() && Array.isArray(masterSnap.data()?.products) && masterSnap.data().products.length > 0) {
        const validList = deduplicateProducts(masterSnap.data().products.filter((p: any) => !p.isArchived));
        setProducts(validList);
        try {
          localStorage.setItem('blackworm_cached_pricelist', JSON.stringify(validList));
        } catch {}
      } else {
        const snap = await getDocs(query(collection(db, 'products_pricelist_v2')));
        const pList: DynamicPriceProduct[] = [];
        snap.forEach((d) => {
          const data = d.data() as DynamicPriceProduct;
          if (!data.isArchived) pList.push({ ...data, id: d.id });
        });
        if (pList.length > 0) {
          const cleanPList = deduplicateProducts(pList);
          setProducts(cleanPList);
          try {
            localStorage.setItem('blackworm_cached_pricelist', JSON.stringify(cleanPList));
          } catch {}
        }
      }
    } catch (e) {
      console.warn('Manual refresh notice:', e);
    } finally {
      setTimeout(() => setIsRefreshing(false), 400);
    }
  };

  const [isCleaning, setIsCleaning] = useState<boolean>(false);
  const handleCleanDuplicates = async () => {
    setIsCleaning(true);
    try {
      const cleanList = deduplicateProducts(products);
      await savePriceListPermanently(
        cleanList,
        'Manual Deduplication & Cleanup',
        profile,
        validityDate,
        products
      );
      setProducts(cleanList);
      setDialogConfig({
        isOpen: true,
        type: 'success',
        title: 'प्राईस लिस्ट स्वच्छ झाली (Cleaned)',
        message: `प्राईस लिस्ट पूर्णपणे तपासली गेली आहे:\n• एकूण युनिक प्रॉडक्ट्स: ${cleanList.length}\n• सर्व डबल/डुप्लिकेट प्रॉडक्ट्स हटवण्यात आले आहेत.\n• सर्व दर (Rates) आणि एमआरपी (MRP) सुरक्षित आहेत.`,
        confirmText: 'ठीक आहे',
        onConfirm: () => setDialogConfig(p => ({ ...p, isOpen: false })),
      });
    } catch (e: any) {
      console.error('Clean duplicates error:', e);
    } finally {
      setIsCleaning(false);
    }
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

  // 1. Fetch Branding & Validity Date
  useEffect(() => {
    const unsubBranding = onSnapshot(doc(db, 'config', 'branding'), (snap) => {
      if (snap.exists()) {
        const data = snap.data();
        setLogoUrl(data.logoUrl || '');
        setLogoSize(data.logoSize || 75);
      }
    }, (err) => {
      console.warn('PriceList branding live sync notice:', err);
    });

    const unsubMeta = onSnapshot(doc(db, 'config', 'pricelist_meta'), (snap) => {
      if (snap.exists() && snap.data().validityDate) {
        setValidityDate(snap.data().validityDate);
      }
    }, (err) => {
      console.warn('PriceList meta live sync notice:', err);
    });

    return () => {
      unsubBranding();
      unsubMeta();
    };
  }, []);

  // 2. Real-time Listener with Dual Master-Doc & Collection Redundancy (Zero-Wipe Guarantee)
  useEffect(() => {
    // 2.1 First listen to config/master_pricelist (Master Document)
    const unsubMaster = onSnapshot(doc(db, 'config', 'master_pricelist'), (docSnap) => {
      if (docSnap.exists()) {
        const data = docSnap.data();
        if (data && Array.isArray(data.products) && data.products.length > 0) {
          const clean = deduplicateProducts(data.products);
          try {
            localStorage.setItem('blackworm_master_pricelist', JSON.stringify({ ...data, products: clean }));
            localStorage.setItem('blackworm_cached_pricelist', JSON.stringify(clean));
          } catch {}
          setProducts(clean);
          if (data.validityDate) setValidityDate(data.validityDate);
          if (clean.length < data.products.length && isAdmin(profile)) {
            savePriceListPermanently(clean, 'Auto Deduplication Self-Healing', profile, data.validityDate, data.products).catch(() => {});
          }
        }
      }
    }, (err) => {
      console.warn('Master price list sync notice:', err);
    });

    // 2.2 Listen to products_pricelist_v2 collection
    const q = query(collection(db, 'products_pricelist_v2'));
    const unsub = onSnapshot(q, async (snap) => {
      const list: DynamicPriceProduct[] = [];
      snap.forEach((docSnap) => {
        const data = docSnap.data() as DynamicPriceProduct;
        if (!data.isArchived) {
          list.push({ ...data, id: docSnap.id });
        }
      });

      if (list.length > 0) {
        const cleanList = deduplicateProducts(list);
        cleanList.sort((a, b) => {
          if (a.groupName !== b.groupName) {
            if (a.groupName.includes('Group A')) return -1;
            if (b.groupName.includes('Group A')) return 1;
            if (a.groupName.includes('Specialty')) return -1;
            if (b.groupName.includes('Specialty')) return 1;
            return a.groupName.localeCompare(b.groupName);
          }
          return (a.orderIndex || 0) - (b.orderIndex || 0);
        });
        setProducts(cleanList);
        try {
          localStorage.setItem('blackworm_cached_pricelist', JSON.stringify(cleanList));
        } catch {}
      } else {
        // Collection returned 0 items: NEVER auto-wipe!
        // Check if master_pricelist or localStorage already has custom products
        const cached = getInitialCachedProducts();
        if (cached.length > 0) {
          setProducts(cached);
        } else {
          // Truly empty first-time database setup only
          await seedReferenceDataSafe();
        }
      }
    }, (err) => {
      console.warn('PriceList products live sync notice:', err);
      const cached = getInitialCachedProducts();
      if (cached.length > 0) {
        setProducts(cached);
      } else {
        const fallback: DynamicPriceProduct[] = OFFICIAL_REFERENCE_DATA.map((item, idx) => ({
          ...item,
          id: `ref_${idx + 1}`,
        }));
        setProducts(fallback);
      }
    });

    return () => {
      unsubMaster();
      unsub();
    };
  }, []);

  // Safe Seeding: Only runs if database is completely empty; NEVER wipes or overwrites
  const seedReferenceDataSafe = async () => {
    try {
      const masterCheck = await getDoc(doc(db, 'config', 'master_pricelist'));
      if (masterCheck.exists() && masterCheck.data()?.products?.length > 0) {
        setProducts(masterCheck.data().products);
        return;
      }

      const initialProducts: DynamicPriceProduct[] = OFFICIAL_REFERENCE_DATA.map((item) => {
        const cleanId = `prod_${item.code.replace(/[^A-Za-z0-9]/g, '_')}_${item.gradeName.replace(/[^A-Za-z0-9]/g, '_')}`;
        return {
          ...item,
          id: cleanId,
          isArchived: false,
        };
      });

      await setDoc(doc(db, 'config', 'master_pricelist'), {
        products: initialProducts,
        validityDate: 'Pricelist w.e.f 01/10/2026 to 31/10/2026',
        updatedAt: new Date().toISOString(),
        version: 1,
        isInitialDefault: true,
      }, { merge: true });

      for (const item of initialProducts) {
        await setDoc(doc(db, 'products_pricelist_v2', item.id), item, { merge: true });
      }
      setProducts(initialProducts);
      try {
        localStorage.setItem('blackworm_cached_pricelist', JSON.stringify(initialProducts));
      } catch {}
    } catch (err) {
      console.error('Safe seed notice:', err);
    }
  };

  // Fetch Firestore backup history
  const fetchBackups = async () => {
    setIsLoadingBackups(true);
    try {
      const qBackups = query(collection(db, 'pricelist_backups'), orderBy('createdAt', 'desc'), limit(15));
      const snap = await getDocs(qBackups);
      const list: any[] = [];
      snap.forEach(d => list.push({ id: d.id, ...d.data() }));
      setBackupList(list);
    } catch (e) {
      console.warn('Fetch backups notice:', e);
    } finally {
      setIsLoadingBackups(false);
    }
  };

  // Restore price list from historical backup
  const handleRestoreFromBackup = async (b: any) => {
    if (!b || !Array.isArray(b.previousProducts) || b.previousProducts.length === 0) {
      setDialogConfig({
        isOpen: true,
        type: 'alert',
        title: 'डेटा उपलब्ध नाही',
        message: 'या बॅकअपमध्ये रिस्टोर करण्यासाठी प्रॉडक्ट्स सापडले नाहीत.',
        confirmText: 'ठीक आहे',
        onConfirm: () => setDialogConfig(p => ({ ...p, isOpen: false })),
      });
      return;
    }

    setDialogConfig({
      isOpen: true,
      type: 'confirm',
      title: 'प्राईस लिस्ट रिस्टोर निश्चित करा',
      message: `तुम्ही "${new Date(b.createdAt).toLocaleString('en-IN')}" रोजीचा ${b.previousProducts.length} प्रॉडक्ट्सचा बॅकअप रिस्टोर करू इच्छिता का? फाईलमधील सर्व प्रॉडक्ट्स व दर ॲपमध्ये लागू होतील.`,
      confirmText: 'होय, रिस्टोर करा',
      cancelText: 'रद्द करा',
      onConfirm: async () => {
        setDialogConfig(p => ({ ...p, isOpen: false }));
        setIsRestoringBackup(true);
        try {
          await savePriceListPermanently(
            b.previousProducts,
            `Restore from backup (${b.createdAt})`,
            profile,
            validityDate,
            products
          );
          setProducts(b.previousProducts);
          setShowBackupModal(false);
          setDialogConfig({
            isOpen: true,
            type: 'success',
            title: 'रिस्टोर यशस्वी',
            message: `मागील बॅकअपमधून एकूण ${b.previousProducts.length} प्रॉडक्ट्स यशस्वीरित्या रिस्टोर झाले आहेत.`,
            confirmText: 'ठीक आहे',
            onConfirm: () => setDialogConfig(p => ({ ...p, isOpen: false })),
          });
        } catch (err: any) {
          setDialogConfig({
            isOpen: true,
            type: 'alert',
            title: 'रिस्टोर अयशस्वी',
            message: err.message || 'रिस्टोर करताना त्रुटी आली.',
            confirmText: 'ठीक आहे',
            onConfirm: () => setDialogConfig(p => ({ ...p, isOpen: false })),
          });
        } finally {
          setIsRestoringBackup(false);
        }
      },
      onCancel: () => setDialogConfig(p => ({ ...p, isOpen: false })),
    });
  };

  // Download Current Price List as JSON Backup
  const handleDownloadBackupJson = () => {
    try {
      const exportPayload = {
        title: 'Blackworm Agritech Pvt Ltd - Official Price List Backup',
        validityDate,
        exportedAt: new Date().toISOString(),
        exportedBy: profile.fullName || profile.loginId,
        totalProducts: products.length,
        products: products,
      };
      const blob = new Blob([JSON.stringify(exportPayload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `Blackworm_PriceList_Backup_${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error('JSON export error:', e);
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

  // Handle Upload of Excel (.xlsx/.xls/.csv) or PDF / Image with Intelligent Product Add & Price Update
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsUploading(true);
    isUploadingRef.current = true;
    setUploadStatusMessage('फाईल तपासत आहे...');

    try {
      const fileName = file.name.toLowerCase();
      let uploadedProducts: DynamicPriceProduct[] = [];
      let newValidity = validityDate;

      // Case A: Excel File (.xlsx, .xls, .csv, .tsv) - Processed 100% locally with SheetJS (Zero server load, immune to 503!)
      if (fileName.endsWith('.xlsx') || fileName.endsWith('.xls') || fileName.endsWith('.csv') || fileName.endsWith('.tsv')) {
        setUploadStatusMessage('एक्सेल डेटा तपासत आहे...');
        const data = await file.arrayBuffer();
        const workbook = XLSX.read(data, { type: 'array' });
        const parsed = parseExcelToProducts(workbook);
        uploadedProducts = parsed.products;
        if (parsed.validity) newValidity = parsed.validity;
      } else {
        // Case B: PDF or Image via Server AI Parser with Client-Side Retry & Exponential Backoff
        let parsedData: any = null;
        let lastErrText = '';
        const clientMaxRetries = 2;

        for (let cAttempt = 1; cAttempt <= clientMaxRetries; cAttempt++) {
          try {
            if (cAttempt > 1) {
              setUploadStatusMessage(`AI सर्व्हर व्यस्त आहे, आपोआप पुन्हा प्रयत्न करत आहोत (प्रयत्न ${cAttempt}/${clientMaxRetries})...`);
              await new Promise(r => setTimeout(r, 2500 * cAttempt));
            } else {
              setUploadStatusMessage('AI मॉडेलद्वारे डेटा प्रोसेस करत आहे (कृपया थोडा वेळ थांबा)...');
            }

            const formData = new FormData();
            formData.append('file', file);

            const response = await fetch('/api/parse-pricelist', {
              method: 'POST',
              body: formData,
            });

            if (!response.ok) {
              const errData = await response.json().catch(() => ({}));
              lastErrText = errData.error || 'सर्व्हरकडून त्रुटी आली.';
              if (response.status === 503 || errData.isOverloaded) {
                // Server overloaded: retry
                continue;
              }
              throw new Error(lastErrText);
            }

            parsedData = await response.json();
            break;
          } catch (fetchErr: any) {
            lastErrText = fetchErr.message;
            if (cAttempt === clientMaxRetries) throw fetchErr;
          }
        }

        if (!parsedData) {
          throw new Error(lastErrText || 'AI सर्व्हरवर सध्या जास्त लोड आहे. कृपया १ मिनिटांनंतर पुन्हा प्रयत्न करा किंवा एक्सेल फाईल वापरा.');
        }

        const extractedProducts: any[] = parsedData.products || [];
        if (parsedData.validityDate) newValidity = parsedData.validityDate;

        uploadedProducts = extractedProducts.map((item, idx) => {
          const cleanId = `prod_${(item.code || `item_${idx}`).replace(/[^A-Za-z0-9]/g, '_')}_${(item.gradeName || '').replace(/[^A-Za-z0-9]/g, '_')}`;
          return {
            groupName: item.groupName || 'Group A - Water Soluble Fertilizers',
            code: item.code || `${idx + 1}.`,
            brandName: item.brandName || 'Airawat®',
            gradeName: item.gradeName || '',
            hsn: item.hsn || '31052000',
            gstRate: Number(item.gstRate) || 5,
            packings: (item.packings || []).map((pk: any) => ({
              packingSize: normalizePackingSize(pk.packingSize),
              rate: Number(pk.rate) || 0,
              mrp: Number(pk.mrp) || 0,
            })),
            orderIndex: idx + 1,
            isArchived: false,
            id: cleanId,
          };
        });
        uploadedProducts = deduplicateProducts(uploadedProducts);
      }

      if (!uploadedProducts || uploadedProducts.length === 0) {
        throw new Error('फाईलमधून प्रॉडक्ट्स डेटा वाचता आला नाही. कृपया योग्य एक्सेल (उदा. Product Name, Packing, Basic Rate, MRP) किंवा डॉक्युमेंट फाईल निवडा.');
      }

      setUploadStatusMessage('प्रॉडक्ट्स, नवीन आयटम व दर सुरक्षित सेव्ह करत आहे...');

      // Intelligently check products: detect new products added and price changes
      const { merged, newAddedCount, priceUpdatedCount } = mergeUploadedProducts(uploadedProducts, products);

      // Permanently Save to Firestore Master Doc, Collection, Backup and LocalStorage
      await savePriceListPermanently(
        merged,
        file.name,
        profile,
        newValidity,
        products
      );

      // Instantly update component state ONLY after successful save
      setProducts(merged);
      if (newValidity) {
        setValidityDate(newValidity);
      }

      setDialogConfig({
        isOpen: true,
        type: 'success',
        title: 'प्राईस लिस्ट यशस्वीरित्या अपडेट झाली',
        message: `अपलोड केलेल्या फाईलनुसार प्राईस लिस्ट अपडेट झाली आहे:\n• नवीन ऍड झालेले प्रॉडक्ट्स: ${newAddedCount}\n• दर/पॅकिंग अपडेट झालेले प्रॉडक्ट्स: ${priceUpdatedCount}\n• एकूण उपलब्ध प्रॉडक्ट्स: ${merged.length}\n\nसर्व बदल डेटाबेसमध्ये कायमस्वरूपी सेव्ह करण्यात आले आहेत.`,
        confirmText: 'ठीक आहे',
        onConfirm: () => setDialogConfig((p) => ({ ...p, isOpen: false })),
      });
    } catch (err: any) {
      console.error('File parse error:', err);
      const rawMsg = err.message || '';
      let cleanDisplayMsg = rawMsg;
      if (rawMsg.includes('503') || rawMsg.includes('UNAVAILABLE') || rawMsg.includes('overloaded')) {
        cleanDisplayMsg = 'AI सर्व्हरवर सध्या खूप जास्त लोड (High Demand) आहे. सिस्टीमने स्वयंचलित २-३ वेळा प्रयत्न केले, परंतु सर्व्हर तात्पुरता व्यस्त आहे.\n\nटीप: आपली जुनी प्राईस लिस्ट पूर्णपणे सुरक्षित आहे. आपण १-२ मिनिटांनंतर पुन्हा प्रयत्न करू शकता किंवा थेट एक्सेल (.xlsx) फाईल अपलोड करू शकता जी कोणत्याही सर्व्हर लोडशिवाय त्वरित सेव्ह होते.';
      }

      setDialogConfig({
        isOpen: true,
        type: 'alert',
        title: 'अपलोड नोटीस',
        message: cleanDisplayMsg,
        confirmText: 'समजले',
        onConfirm: () => setDialogConfig((p) => ({ ...p, isOpen: false })),
      });
    } finally {
      setIsUploading(false);
      isUploadingRef.current = false;
      setUploadStatusMessage('');
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

  const isUserAdminOrOwner = isAdmin(profile);

  return (
    <div className="font-sans text-slate-900 space-y-4 relative">
      {/* ========================================================================= */}
      {/* STYLISH LOADING OVERLAY WITH USER-FRIENDLY STATUS & EXPONENTIAL RETRY     */}
      {/* ========================================================================= */}
      {isUploading && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl p-6 sm:p-8 max-w-md w-full shadow-2xl border border-slate-200 text-center space-y-5 animate-in fade-in zoom-in-95">
            <div className="w-16 h-16 mx-auto rounded-2xl bg-emerald-50 border-2 border-emerald-200 flex items-center justify-center shadow-inner">
              <Loader2 className="w-8 h-8 text-emerald-600 animate-spin" />
            </div>
            <div className="space-y-2">
              <h3 className="text-base sm:text-lg font-black text-slate-900">
                प्राईस लिस्ट अपडेट होत आहे
              </h3>
              <p className="text-xs font-bold text-slate-600 bg-slate-50 py-2 px-3 rounded-xl border border-slate-200">
                {uploadStatusMessage || 'कृपया थोडा वेळ थांबा, सिस्टीम काम करत आहे...'}
              </p>
            </div>
            
            {/* Animated Gradient Progress Bar */}
            <div className="w-full bg-slate-100 rounded-full h-2.5 overflow-hidden">
              <div className="bg-gradient-to-r from-emerald-500 via-teal-500 to-indigo-600 h-2.5 rounded-full animate-pulse w-full" />
            </div>

            <div className="p-3 bg-amber-50/80 rounded-2xl border border-amber-200 text-[11px] text-amber-900 font-medium text-left space-y-1">
              <div className="flex items-center gap-1.5 font-bold text-amber-950">
                <ShieldCheck className="w-3.5 h-3.5 text-amber-700 shrink-0" />
                <span>सुरक्षितता हमी:</span>
              </div>
              <p>
                आपली जुनी प्राईस लिस्ट पूर्ण सुरक्षित आहे. सर्व्हरवर जास्त लोड असल्यास सिस्टीम आपोआप पुन्हा प्रयत्न (Auto-retry) करते.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* COMPACT & PROFESSIONAL UPLOAD BAR                                         */}
      {/* ========================================================================= */}
      {isUserAdminOrOwner && (
        <div className="bg-white p-3 rounded-2xl border border-slate-200 shadow-sm flex flex-col sm:flex-row items-center justify-between gap-3 no-print">
          <div className="flex items-center gap-2">
            {/* Icon Button in front of Company Price */}
            <button
              type="button"
              onClick={handleManualRefresh}
              disabled={isRefreshing || isCleaning}
              title="रीफ्रेश करा (Refresh Price List)"
              className="p-1.5 bg-emerald-50 hover:bg-emerald-100 text-emerald-700 rounded-lg border border-emerald-200 transition shadow-2xs cursor-pointer active:scale-95 disabled:opacity-50 flex items-center justify-center shrink-0"
            >
              <RefreshCw className={cn("w-3.5 h-3.5", isRefreshing && "animate-spin")} />
            </button>

            {/* Clean Duplicates Button */}
            <button
              type="button"
              onClick={handleCleanDuplicates}
              disabled={isCleaning || isRefreshing}
              title="सर्व डबल डेटा हटवून लिस्ट स्वच्छ करा (Remove Duplicates)"
              className="p-1.5 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 rounded-lg border border-indigo-200 transition shadow-2xs cursor-pointer active:scale-95 disabled:opacity-50 flex items-center justify-center shrink-0"
            >
              {isCleaning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ShieldCheck className="w-3.5 h-3.5" />}
            </button>
            <span className="text-xs font-bold text-slate-800 flex items-center gap-1.5">
              <span>कंपनी प्राईस</span>
            </span>
            <span className="text-[11px] text-slate-500 hidden sm:inline">
              (Excel, PDF किंवा इमेज अपलोड करा; सर्व प्रॉडक्ट्स, नवीन आयटम व दर त्वरित अपडेट होतील)
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto">
            {/* Permanent Protection Status Badge */}
            <div className="hidden lg:flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl bg-emerald-50 text-emerald-800 text-[11px] font-bold border border-emerald-200">
              <ShieldCheck className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
              <span>डेटाबेसमध्ये कायमस्वरूपी सुरक्षित</span>
            </div>

            <input
              type="file"
              ref={fileInputRef}
              onChange={handleFileUpload}
              accept=".xlsx,.xls,.csv,.pdf,.png,.jpg,.jpeg"
              className="hidden"
            />

            {/* Single Clean Upload Button in English */}
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={isUploading}
              className="w-full sm:w-auto flex items-center justify-center gap-2 bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-2 rounded-xl text-xs font-black transition shadow-sm disabled:opacity-50 cursor-pointer"
              title="Upload Price List (Excel / PDF / Image)"
            >
              {isUploading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>Uploading & Saving...</span>
                </>
              ) : (
                <>
                  <Upload className="w-4 h-4" />
                  <span>Upload Price List</span>
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

      {/* ========================================================================= */}
      {/* BACKUP & RESTORE MODAL                                                   */}
      {/* ========================================================================= */}
      {showBackupModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4 no-print">
          <div className="bg-white rounded-3xl max-w-2xl w-full p-5 sm:p-6 shadow-2xl border border-slate-200 max-h-[90vh] flex flex-col">
            <div className="flex items-center justify-between pb-3.5 border-b border-slate-200">
              <div className="flex items-center gap-2">
                <Database className="w-5 h-5 text-emerald-600" />
                <h3 className="text-base font-bold text-slate-900">प्राईस लिस्ट बॅकअप आणि सुरक्षित रिस्टोर</h3>
              </div>
              <button 
                onClick={() => setShowBackupModal(false)}
                className="p-1 text-slate-400 hover:text-slate-600 rounded-lg hover:bg-slate-100 transition cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-3.5 bg-emerald-50/70 border border-emerald-200 rounded-2xl my-3 text-xs space-y-1">
              <div className="flex items-center gap-1.5 font-bold text-emerald-900">
                <ShieldCheck className="w-4 h-4 text-emerald-600 shrink-0" />
                <span>कायमस्वरूपी डेटा संरक्षण (Permanent Storage Guarantee)</span>
              </div>
              <p className="text-emerald-800 leading-relaxed text-[11px]">
                प्रत्येक नवीन अपलोडपूर्वी मागील प्राईस लिस्टचा ऑटोमॅटिक बॅकअप डेटाबेसमध्ये सेव्ह केला जातो. रिफ्रेश किंवा लॉगआउट केल्यास डेटा कधीही नष्ट होणार नाही. आवश्यकतेनुसार तुम्ही कोणत्याही मागील आवृत्तीवरून त्वरित डेटा रिस्टोर करू शकता.
              </p>
            </div>

            {/* Quick Export Actions */}
            <div className="flex flex-wrap gap-2 mb-3">
              <button
                onClick={handleDownloadTemplate}
                className="flex items-center gap-1.5 px-3 py-2 bg-slate-900 hover:bg-black text-white text-xs font-bold rounded-xl transition cursor-pointer shadow-2xs"
              >
                <Download className="w-3.5 h-3.5" />
                <span>सध्याची लिस्ट एक्सेल (Excel)</span>
              </button>
              <button
                onClick={handleDownloadBackupJson}
                className="flex items-center gap-1.5 px-3 py-2 bg-emerald-700 hover:bg-emerald-800 text-white text-xs font-bold rounded-xl transition cursor-pointer shadow-2xs"
              >
                <Download className="w-3.5 h-3.5" />
                <span>पूर्ण डेटा बॅकअप (JSON)</span>
              </button>
            </div>

            {/* Historical Backups list */}
            <div className="flex-1 overflow-y-auto space-y-2 pr-1 min-h-[160px] max-h-[300px]">
              <div className="flex items-center justify-between text-xs font-bold text-slate-700 pb-1">
                <span>सेव्ह झालेले ऑटोमॅटिक बॅकअप्स ({backupList.length})</span>
                {isLoadingBackups && <Loader2 className="w-3.5 h-3.5 animate-spin text-emerald-600" />}
              </div>

              {backupList.map((b) => (
                <div key={b.id} className="p-2.5 bg-slate-50 border border-slate-200 rounded-xl flex items-center justify-between gap-3 text-xs">
                  <div>
                    <div className="font-bold text-slate-900 flex items-center gap-1.5 text-xs">
                      <span className="w-2 h-2 rounded-full bg-emerald-500 shrink-0" />
                      <span>{new Date(b.createdAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}</span>
                    </div>
                    <div className="text-[11px] text-slate-500 mt-0.5">
                      {b.previousProductsCount || b.previousProducts?.length || 0} प्रॉडक्ट्स • स्रोत: {b.source || 'Upload'} • युजर: {b.performedByName || 'Admin'}
                    </div>
                  </div>

                  <button
                    onClick={() => handleRestoreFromBackup(b)}
                    disabled={isRestoringBackup}
                    className="flex items-center gap-1 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white font-bold rounded-lg transition disabled:opacity-50 text-[11px] cursor-pointer shrink-0"
                  >
                    <RotateCcw className="w-3 h-3" />
                    <span>रिस्टोर करा</span>
                  </button>
                </div>
              ))}

              {backupList.length === 0 && !isLoadingBackups && (
                <div className="p-8 text-center text-slate-400 font-bold text-xs bg-slate-50 rounded-xl">
                  अद्याप कोणतेही अतिरिक्त बॅकअप्स उपलब्ध नाहीत. सध्याची मूळ प्राईस लिस्ट डेटाबेसमध्ये सुरक्षित आहे.
                </div>
              )}
            </div>

            <div className="pt-3.5 border-t border-slate-200 mt-3 flex justify-end">
              <button
                onClick={() => setShowBackupModal(false)}
                className="px-4 py-2 bg-slate-200 hover:bg-slate-300 text-slate-800 text-xs font-bold rounded-xl transition cursor-pointer"
              >
                बंद करा
              </button>
            </div>
          </div>
        </div>
      )}

      <CustomDialogModal {...dialogConfig} />
    </div>
  );
};
