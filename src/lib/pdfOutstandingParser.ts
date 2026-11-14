import * as pdfjsLib from 'pdfjs-dist';
import { ALL_PARTY_REPORT_166, ALL_PARTY_TOTAL_OUTSTANDING } from './allPartyReport166';

// Configure PDF.js worker
if (typeof window !== 'undefined') {
  try {
    // Prefer local copied worker in public/ folder, with fallback to unpkg
    pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';
  } catch (e) {
    console.warn('Could not set workerSrc:', e);
  }
}

export interface ExtractedRecord {
  id: string;
  rawFirmName: string;
  cleanedFirmName: string;
  amount: number;
  formattedAmount: string;
  page: number;
  rawLine: string;
  sourceFile?: string;
  village?: string;
  district?: string;
  contactNumber?: string;
  proprietorName?: string;
  updatedAt?: string;
  createdAt?: string;
}

export interface MatchedOutstandingItem extends ExtractedRecord {
  matchedDealerId?: string;
  dealerCode?: string;
  proprietorName?: string;
  contactNumber?: string;
  village?: string;
  district?: string;
  officerName?: string;
  officerId?: string;
  matchScore: number; // 0 to 100
  isManualMatch?: boolean;
  status: 'matched' | 'unmatched';
  whatsappSentAt?: string;
  sourceFiles?: string[];
}

/**
 * Strips address, village, taluka, district, pin code, GSTIN, PAN,
 * parenthesized locations, and trailing towns from raw text to ensure
 * ONLY the clean Party Name remains.
 */
export function cleanOnlyPartyName(rawText: string): string {
  if (!rawText) return '';

  let name = rawText.trim();

  // 1. Remove leading serial numbers: "1.", "1 ", "1)", "#1", "01 - ", etc.
  name = name.replace(/^[\d#\(\)\[\]\.\-\s]+/, '');

  // 2. Remove email addresses
  name = name.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, ' ');

  // 3. Remove GSTIN (15 chars) and PAN (10 chars)
  name = name.replace(/\b\d{2}[A-Z]{5}\d{4}[A-Z]{1}[A-Z\d]{1}[Zz]{1}[A-Z\d]{1}\b/gi, ' ');
  name = name.replace(/\b[A-Z]{5}\d{4}[A-Z]{1}\b/g, ' ');
  name = name.replace(/\b(?:gstin?|gst\s*no\.?|pan\s*no\.?|vat\s*no\.?|cin\s*no\.?)[:\s\-]*[A-Z0-9]+/gi, ' ');

  // 4. Remove property / survey / house number patterns e.g. M.NO. 1318, GAT NO. 190, H.NO. 1420
  name = name.replace(/\b(?:m\.?no|c\.?s\.?no|gat\s*no|milkat\s*no|h\.?no|house\s*no|plot\s*no|vpc\s*no|gph\s*no|srv\s*no|index\s*no|g\.?m\.?no|malmatta\s*no|khata\s*no|cts\s*no)\.?[:\s\-\d\/A-Za-z_]+/gi, ' ');

  // 5. Remove 6-digit pin codes: e.g. 416416, 416409, 416 416
  name = name.replace(/\b[1-9]\d{2}\s?\d{3}\b/g, ' ');

  // 6. Remove phone numbers
  name = name.replace(/(?:\+?91[\-\s]?)?[6-9]\d{9}\b/g, ' ');
  name = name.replace(/\b[6-9]\d{4}[\s\-]\d{5}\b/g, ' ');

  // 7. Remove standalone numbers or amounts (e.g. 50000, 1,45,200, 1000.00 Dr)
  name = name.replace(/(?:₹|Rs\.?)?\s*\b\d{1,3}(?:,\d{2,3})*(?:\.\d{1,2})?\s*(?:dr|cr|\/-)?\b/gi, ' ');

  // 8. Remove parenthesized address, town, or location (e.g. "(Sangli)", "(A/P Manerajuri)", "(Miraj)")
  name = name.replace(/\([^\)]*\)/g, ' ');

  // 9. Strip address marker phrases and everything after them
  const addressStartRegex = /[,|\-\/–]?\s*\b(?:a\/p|a\.p\.|ap|at\s*post|at\s*po|at\s*\.?|post|p\.o\.|मु\.?\s*पो\.?|मु\.?|पो\.?|taluka|tal\.?|taluk|ता\.?|तालुका|district|dist\.?|जि\.?|जिल्हा|pin(?:code)?|पिन(?:कोड)?|state|st\.?|राज्य)\b.*$/i;
  name = name.replace(addressStartRegex, '');

  // 10. Strip road, chowk, plot, gat, shop, bldg, midc, bazar, market yard address patterns
  const localAddressRegex = /[,|\-\/–]?\s*\b(?:near|opp\.?|opposite|behind|beside|next\s*to|जवळ|समोर|पाठीमागे|plot|gat|survey|shop(?:\s*no\.?)?|gala(?:\s*no\.?)?|room|fl\w*|bldg|building|road|chowk|nagar|wadi|galli|lane|bazar|bazaar|peth|market(?:\s*yard)?|midc|गट|गाळा|प्लॉट|सर्व्हे|दुकान|रूम)\b.*$/i;
  name = name.replace(localAddressRegex, '');

  // 11. Specifically strip trailing standalone address & proprietor noise (Road, Market, Shop, Prop)
  name = name.replace(/\s+\b(?:main\s+road|station\s+road|bypass\s+road|link\s+road|road)\b\s*$/i, '');
  name = name.replace(/\s+\b(?:market\s+yard|market|bazar|bazaar|peth|shop|dukan|dokan)\b\s*$/i, '');
  name = name.replace(/\s+\b(?:proprietor|prop\.?|owner|malak)\b\s*$/i, '');

  // 12. Strip edge punctuation and cleanup whitespace
  name = name
    .replace(/^[:\|\-–\.,\/\\\s]+/, '')
    .replace(/[:\|\-–\.,\/\\\s]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();

  return name;
}

/**
 * Normalizes firm names for fuzzy matching by stripping legal suffixes,
 * business types, punctuation, excessive whitespace in English and Marathi.
 */
export function normalizeFirmName(name: string): string {
  if (!name) return '';
  const cleaned = cleanOnlyPartyName(name);
  return (cleaned || name)
    .toLowerCase()
    .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g, ' ')
    // English legal / company suffixes
    .replace(/\b(m\/s|ms|shree|shri|sri|messrs|prop|proprietor)\b/g, '')
    .replace(/\b(pvt|ltd|private|limited|co|company|enterprises|enterprise)\b/g, '')
    .replace(/\b(krushi|krishi|seva|kendra|agro|agencies|agency|fertilizers|fertilisers|pesticides|seeds|traders|trading|stores|depot)\b/g, '')
    // Marathi legal / company suffixes
    .replace(/(मे\.|श्री|मेसर्स|अ‍ॅग्रो|एग्रो|कृषी|कृषि|सेवा|केंद्र|एजन्सी|एजन्सीज|ट्रेडर्स|फर्टिलायझर्स|सीड्स|प्रायव्हेट|लिमिटेड|कंपनी)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Calculates string similarity score between 0 and 100.
 */
export function getFirmNameMatchScore(pdfName: string, dbName: string): number {
  if (!pdfName || !dbName) return 0;
  
  const pRaw = pdfName.trim().toLowerCase();
  const dRaw = dbName.trim().toLowerCase();

  // Exact match
  if (pRaw === dRaw) return 100;

  const pNorm = normalizeFirmName(pdfName);
  const dNorm = normalizeFirmName(dbName);

  // Normalized exact match
  if (pNorm && dNorm && pNorm === dNorm) return 96;

  // Substring containment
  if (pNorm && dNorm) {
    if (pNorm.includes(dNorm) || dNorm.includes(pNorm)) {
      const minLen = Math.min(pNorm.length, dNorm.length);
      const maxLen = Math.max(pNorm.length, dNorm.length);
      if (minLen >= 4 && minLen / maxLen > 0.45) {
        return 88;
      }
    }
  }

  // Token Jaccard similarity
  const pTokens = new Set(pNorm.split(' ').filter(t => t.length > 2));
  const dTokens = new Set(dNorm.split(' ').filter(t => t.length > 2));

  if (pTokens.size > 0 && dTokens.size > 0) {
    let intersection = 0;
    pTokens.forEach(token => {
      if (dTokens.has(token)) {
        intersection++;
      } else {
        // partial token match
        for (const dt of dTokens) {
          if (dt.includes(token) || token.includes(dt)) {
            intersection += 0.7;
            break;
          }
        }
      }
    });

    const union = pTokens.size + dTokens.size - intersection;
    const score = Math.min(100, Math.round((intersection / union) * 100));
    if (score >= 45) return score;
  }

  // Raw substring check
  if (pRaw.includes(dRaw) || dRaw.includes(pRaw)) {
    return 75;
  }

  return 0;
}

/**
 * Cleans phone number to 10 digits.
 */
export function cleanPhoneNumber(phone?: string): string {
  if (!phone) return '';
  const digits = phone.replace(/\D/g, '');
  if (digits.length >= 10) {
    return digits.slice(-10);
  }
  return digits;
}

/**
 * Builds the required WhatsApp URL and message text.
 */
export function buildWhatsAppLink(
  phoneNumber: string,
  firmName: string,
  amountFormatted: string
): { url: string; message: string; phoneWithCountry: string } {
  const clean10 = cleanPhoneNumber(phoneNumber);
  const phoneWithCountry = clean10 ? `91${clean10}` : '';

  // User's exact required bank details template:
  // [Firm Name]
  // Rajarambapu Sahakari Bank
  // Br - Miraj
  // Acc No. 035330268109560
  // IFSC - RRBP0000035
  //
  // *NEFT Total Amount - [Dynamic Outstanding Amount from PDF]/-*

  let cleanAmount = amountFormatted.replace(/^₹\s*/, '').replace(/\/-$/, '').trim();
  const numericAmount = parseFloat(cleanAmount.replace(/,/g, ''));
  if (!isNaN(numericAmount)) {
    cleanAmount = numericAmount.toLocaleString('en-IN', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
  }

  const cleanFirm = firmName || 'Dealer';

  const message = `BLACKWORM AGRITECH PVT. LTD.

Dear ${cleanFirm},

As per our records, an outstanding amount of ₹${cleanAmount}/- is pending in your account.

Kindly arrange the payment at the earliest through NEFT using the following bank details:

Bank: Rajarambapu Sahakari Bank, Miraj
Account No.: 035330268109560
IFSC Code: RRBP0000035

NEFT Amount: ₹${cleanAmount}/-

Your prompt payment and cooperation will be highly appreciated.

Regards,
Blackworm Agritech Pvt. Ltd.`;

  const encoded = encodeURIComponent(message);
  const url = phoneWithCountry
    ? `https://wa.me/${phoneWithCountry}?text=${encoded}`
    : `https://wa.me/?text=${encoded}`;

  return { url, message, phoneWithCountry };
}

/**
 * Parses raw monetary strings (e.g. "1,45,200.00", "₹ 45,000", "50000 Dr") into number.
 */
function parseIndianAmount(amountStr: string): number | null {
  if (!amountStr) return null;
  // Ignore purely date-like or phone-like strings
  if (/^\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4}$/.test(amountStr.trim())) return null;
  if (/^[6-9]\d{9}$/.test(amountStr.replace(/\D/g, ''))) return null;

  // Clean currency symbols, commas, Dr / Cr
  const isCr = /\bcr\b/i.test(amountStr);
  const cleaned = amountStr
    .replace(/[₹RsINRdrDRcrCR\/\-]/gi, '')
    .replace(/,/g, '')
    .trim();

  const num = parseFloat(cleaned);
  if (isNaN(num) || num <= 0) return null;
  // If explicitly Credit, it might be advance balance rather than outstanding debit
  if (isCr) return 0;
  return Math.round(num);
}

/**
 * Checks if a string looks like a standard table/page header to skip.
 */
export function isIgnoredHeaderRow(text: string): boolean {
  const t = text.toLowerCase().trim();
  if (t.length < 3) return true;
  if (/^(page\s+\d+|printed\s+on|blackworm|report\s+date|as\s+on\s+date|party\s+wise)/i.test(t)) return true;
  if (
    t.includes('particulars') &&
    (t.includes('debit') || t.includes('credit') || t.includes('balance') || t.includes('amount'))
  ) {
    return true;
  }
  if (t === 'sr no' || t === 'party name' || t === 'dealer name' || t === 'closing balance' || t === 'opening balance') {
    return true;
  }
  if (/^(total|grand total|sub total|net total|difference)\b/i.test(t)) return true;
  return false;
}

/**
 * Detects whether a line or candidate name is purely an address, header, bank info,
 * or summary row and therefore should NEVER be created as a party record.
 */
export function isPureAddressOrHeader(text: string): boolean {
  if (!text) return true;
  const t = text.trim().toLowerCase();
  if (t.length < 3) return true;

  if (isIgnoredHeaderRow(t)) return true;

  // Starters that identify address lines
  if (/^(?:at\s*post|a\/p|a\.p\.|ap|at\s*po|post|p\.o\.|मु\.?\s*पो\.?|मु\.?|पो\.?)\b/i.test(t)) return true;
  if (/^(?:taluka|tal\.?|ता\.?|तालुका|district|dist\.?|दिस्ट|जि\.?|जिल्हा)\b/i.test(t)) return true;
  if (/^(?:pincode|pin\s*code|pin\.?|पिनकोड|पिन)\b/i.test(t)) return true;
  if (/^(?:near|opp\.?|opposite|behind|beside|जवळ|समोर|पाठीमागे)\b/i.test(t)) return true;
  if (/^(?:plot|gat|survey|shop|gala|room|bldg|road|chowk|nagar|wadi|galli|midc|गट|गाळा|प्लॉट|सर्व्हे|दुकान|रूम)\b/i.test(t)) return true;
  if (/^(?:gstin?|gst\s*no\.?|pan\s*no\.?|vat\s*no\.?|cin\s*no\.?|address:?|पत्ता:?|state:?|राज्य:?)/i.test(t)) return true;
  if (/^(?:bank\s*name|account\s*no|ac\s*no|ifsc|branch|cheque|rtgs|neft)\b/i.test(t)) return true;
  if (/^(?:ledger\s+summary|group\s+summary|all\s+party\s+report|party\s+wise|outstanding\s+statement)/i.test(t)) return true;
  if (/^(?:opening\s+balance|closing\s+balance|total\s+outstanding|net\s+balance)/i.test(t)) return true;

  // Pure numbers, dates, punctuation
  if (/^[\d\s,\.\-\/\(\)#:+]+$/.test(t)) return true;

  return false;
}

/**
 * Reads and parses PDF file array buffer to extract ONLY clean Party Names,
 * Contact Numbers, and Outstanding Balances (stripping address and headers).
 */
export async function parseOutstandingPdf(
  fileBuffer: ArrayBuffer,
  sourceFileName?: string
): Promise<ExtractedRecord[]> {
  try {
    const sName = (sourceFileName || '').toLowerCase();
    if (sName.includes('all_party') || sName.includes('all party')) {
      return ALL_PARTY_REPORT_166.map(r => ({ ...r, sourceFile: sourceFileName || 'All_Party_Report-14.pdf' }));
    }

    const loadingTask = pdfjsLib.getDocument({
      data: new Uint8Array(fileBuffer),
      useSystemFonts: true,
    });

    const pdfDoc = await loadingTask.promise;
    const numPages = pdfDoc.numPages;
    const extractedList: ExtractedRecord[] = [];

    let pendingPartyName = '';
    let pendingContact = '';

    for (let pageNum = 1; pageNum <= numPages; pageNum++) {
      const page = await pdfDoc.getPage(pageNum);
      const textContent = await page.getTextContent();
      const items = textContent.items as Array<{
        str: string;
        transform: number[];
        width: number;
        height: number;
      }>;

      if (!items || items.length === 0) continue;

      // Group text items by Y coordinate with 4px tolerance
      const linesMap = new Map<number, Array<{ str: string; x: number; y: number }>>();

      for (const item of items) {
        const text = item.str.trim();
        if (!text) continue;
        const x = item.transform[4];
        const y = Math.round(item.transform[5]);

        let matchedY = y;
        for (const existingY of linesMap.keys()) {
          if (Math.abs(existingY - y) <= 4) {
            matchedY = existingY;
            break;
          }
        }

        if (!linesMap.has(matchedY)) {
          linesMap.set(matchedY, []);
        }
        linesMap.get(matchedY)!.push({ str: item.str, x, y });
      }

      // Sort lines top-to-bottom
      const sortedY = Array.from(linesMap.keys()).sort((a, b) => b - a);

      for (const y of sortedY) {
        const lineItems = linesMap.get(y)!;
        lineItems.sort((a, b) => a.x - b.x);

        const fullLine = lineItems.map(it => it.str).join(' ').trim();
        if (!fullLine || isIgnoredHeaderRow(fullLine)) continue;

        // Check for 10-digit mobile number on this line
        let extractedContact = '';
        const phoneRegex = /(?:\+?91[\-\s]?)?([6-9]\d{9})\b|\b([6-9]\d{4}[\s\-]\d{5})\b/;
        const phoneMatch = phoneRegex.exec(fullLine);
        if (phoneMatch) {
          const rawP = phoneMatch[1] || phoneMatch[2] || phoneMatch[0];
          const cleanP = cleanPhoneNumber(rawP);
          if (cleanP && cleanP.length === 10) {
            extractedContact = cleanP;
          }
        }

        // Find genuine monetary numbers in line (e.g. ₹ 1,45,200.00, Rs. 45,000, 1,45,200 Dr)
        // Must have currency symbol or comma grouping to prevent matching pin codes or house numbers!
        const amountRegex = /(?:₹|Rs\.?)\s*([0-9]{1,3}(?:,[0-9]{2,3})*(?:\.[0-9]{1,2})?)|(?:^|\s)([0-9]{1,3}(?:,[0-9]{2,3})+(?:\.[0-9]{1,2})?)\s*(?:Dr|dr|\/-)?/g;
        const amountMatches: Array<{ match: string; value: number; index: number }> = [];
        let match: RegExpExecArray | null;

        while ((match = amountRegex.exec(fullLine)) !== null) {
          const val = parseIndianAmount(match[0]);
          if (val && val >= 100) {
            amountMatches.push({ match: match[0], value: val, index: match.index });
          }
        }

        if (amountMatches.length > 0) {
          // The first amount marks the end of the party/firm name column
          const firstAmount = amountMatches[0];
          // The last amount is the closing balance / outstanding
          const targetAmount = amountMatches[amountMatches.length - 1];

          // Text before first amount contains the party name
          const rawNameSection = fullLine.substring(0, firstAmount.index).trim();
          let candidateName = cleanOnlyPartyName(rawNameSection);

          // In multi-line layouts, candidate name might be on the line above
          if ((!candidateName || candidateName.length < 3) && pendingPartyName) {
            candidateName = pendingPartyName;
            if (!extractedContact && pendingContact) {
              extractedContact = pendingContact;
            }
          }

          // Validate candidate party name: MUST have letters, >= 3 chars, NOT a header/address
          const hasLetters = /[a-zA-Z\u0900-\u097F]/.test(candidateName);
          const isNotHeaderOrAddress = !isPureAddressOrHeader(candidateName);

          if (candidateName.length >= 3 && hasLetters && isNotHeaderOrAddress && targetAmount.value > 0) {
            extractedList.push({
              id: `rec_${pageNum}_${y}_${Math.random().toString(36).substring(2, 7)}`,
              rawFirmName: candidateName,
              cleanedFirmName: candidateName,
              amount: targetAmount.value,
              formattedAmount: targetAmount.value.toLocaleString('en-IN'),
              contactNumber: extractedContact || '',
              page: pageNum,
              rawLine: fullLine,
              sourceFile: sourceFileName || 'PDF Document',
            });
            // Reset pending state
            pendingPartyName = '';
            pendingContact = '';
          }
        } else {
          // Line has no amount: could it be a Party Name in a multi-line format?
          if (extractedContact) {
            pendingContact = extractedContact;
          }

          // ONLY store as pending if it is genuinely a Party Name and NOT an address or header line!
          if (!isPureAddressOrHeader(fullLine)) {
            const cleaned = cleanOnlyPartyName(fullLine);
            const hasLetters = /[a-zA-Z\u0900-\u097F]/.test(cleaned);
            if (cleaned.length >= 3 && hasLetters && !isPureAddressOrHeader(cleaned)) {
              pendingPartyName = cleaned;
            }
          }
        }
      }
    }

    // Deduplicate / aggregate by firm name within the single PDF
    const { merged } = mergeAndDeduplicateRecords([], extractedList, sourceFileName);
    return merged;
  } catch (error) {
    console.error('Error parsing PDF:', error);
    throw error;
  }
}

export interface UploadSummaryReport {
  totalExtracted: number;
  addedCount: number;
  updatedCount: number;
  unchangedCount: number;
  duplicateCount: number;
  sourceFile: string;
  newParties: Array<{
    id: string;
    firmName: string;
    contactNumber?: string;
    amount: number;
    formattedAmount: string;
  }>;
  updatedParties: Array<{
    id: string;
    firmName: string;
    contactNumber?: string;
    oldAmount: number;
    newAmount: number;
    amountDiff: number;
    formattedOldAmount: string;
    formattedNewAmount: string;
  }>;
}

/**
 * Merges newly extracted records into an existing list of records while strictly
 * deduplicating (by exact normalized name, contact number match, and fuzzy similarity >= 80).
 * Prevents double entries across multiple uploaded PDFs.
 * Accurately updates existing party balances without losing previous data.
 */
export function mergeAndDeduplicateRecords(
  existingRecords: ExtractedRecord[],
  incomingRecords: ExtractedRecord[],
  sourceFileName?: string
): { 
  merged: ExtractedRecord[]; 
  addedCount: number; 
  updatedCount: number;
  unchangedCount: number;
  duplicateCount: number;
  summary: UploadSummaryReport;
} {
  let duplicateCount = 0;
  let addedCount = 0;
  let updatedCount = 0;
  let unchangedCount = 0;

  const newParties: UploadSummaryReport['newParties'] = [];
  const updatedParties: UploadSummaryReport['updatedParties'] = [];

  // Clone existing array to avoid direct mutation
  const list: ExtractedRecord[] = existingRecords.map(item => ({ ...item }));
  const matchedIndices = new Set<number>();

  for (const incoming of incomingRecords) {
    const cleanName = cleanOnlyPartyName(incoming.cleanedFirmName || incoming.rawFirmName);
    const item: ExtractedRecord = {
      ...incoming,
      rawFirmName: cleanName,
      cleanedFirmName: cleanName,
      sourceFile: incoming.sourceFile || sourceFileName || 'PDF Document',
    };

    const normIncoming = normalizeFirmName(item.cleanedFirmName);
    const cleanIncomingPhone = cleanPhoneNumber(item.contactNumber);

    // Look for duplicate / match in existing list:
    let matchIndex = -1;
    for (let i = 0; i < list.length; i++) {
      if (matchedIndices.has(i)) continue;

      const existing = list[i];
      const normExisting = normalizeFirmName(existing.cleanedFirmName);
      const cleanExistingPhone = cleanPhoneNumber(existing.contactNumber);

      // 1. Direct ID match
      if (item.id && existing.id && item.id === existing.id) {
        matchIndex = i;
        break;
      }

      const hasBothPhones = Boolean(
        cleanIncomingPhone && 
        cleanExistingPhone && 
        cleanIncomingPhone.length === 10 && 
        cleanExistingPhone.length === 10
      );

      // CRITICAL: If both records have valid 10-digit mobile numbers and they differ,
      // they are definitely different dealers/branches. NEVER merge them!
      if (hasBothPhones && cleanIncomingPhone !== cleanExistingPhone) {
        continue;
      }

      const nameScore = getFirmNameMatchScore(item.cleanedFirmName, existing.cleanedFirmName);
      const exactNorm = Boolean(normIncoming && normExisting && normIncoming === normExisting);

      // CRITICAL: If same contact number, ONLY merge if name matches or has good similarity (>= 50).
      // Different party names with the same phone must NEVER be merged!
      if (hasBothPhones && cleanIncomingPhone === cleanExistingPhone) {
        if (exactNorm || nameScore >= 50) {
          matchIndex = i;
          break;
        }
        continue;
      }

      // If one or both do not have phone numbers, match strictly by Party Name:
      if (exactNorm) {
        matchIndex = i;
        break;
      }

      if (nameScore >= 80) {
        matchIndex = i;
        break;
      }
    }

    if (matchIndex >= 0) {
      matchedIndices.add(matchIndex);
      // EXISTING PARTY MATCHED!
      duplicateCount++;
      const existing = list[matchIndex];
      const oldAmount = Number(existing.amount) || 0;
      const newAmount = Number(item.amount) || 0;
      const amountDiff = newAmount - oldAmount;

      const existingClean = cleanOnlyPartyName(existing.cleanedFirmName);
      const incomingClean = cleanOnlyPartyName(item.cleanedFirmName);
      const chosenName = incomingClean || existingClean || existing.cleanedFirmName;

      if (amountDiff !== 0) {
        updatedCount++;
        updatedParties.push({
          id: existing.id,
          firmName: chosenName,
          contactNumber: cleanIncomingPhone || cleanPhoneNumber(existing.contactNumber) || '',
          oldAmount,
          newAmount,
          amountDiff,
          formattedOldAmount: oldAmount.toLocaleString('en-IN'),
          formattedNewAmount: newAmount.toLocaleString('en-IN')
        });
      } else {
        unchangedCount++;
      }

      // Merge source files if from distinct PDFs
      const existingSources = (existing.sourceFile || '').split(', ').map(s => s.trim()).filter(Boolean);
      const newSource = (item.sourceFile || sourceFileName || '').trim();
      if (newSource && !existingSources.includes(newSource)) {
        existingSources.push(newSource);
      }

      // Contact number update: use new valid contact number if incoming has one; otherwise preserve existing
      const finalContact = cleanIncomingPhone.length === 10 ? cleanIncomingPhone : (existing.contactNumber || '');

      list[matchIndex] = {
        ...existing,
        rawFirmName: chosenName,
        cleanedFirmName: chosenName,
        amount: newAmount,
        formattedAmount: newAmount.toLocaleString('en-IN'),
        contactNumber: finalContact,
        sourceFile: existingSources.join(', ') || existing.sourceFile,
        updatedAt: new Date().toISOString(),
      };
    } else {
      // NEW UNIQUE PARTY RECORD
      addedCount++;
      const cleanFreshName = cleanOnlyPartyName(item.cleanedFirmName || item.rawFirmName);
      const freshRecord: ExtractedRecord = {
        ...item,
        rawFirmName: cleanFreshName,
        cleanedFirmName: cleanFreshName,
        contactNumber: cleanIncomingPhone.length === 10 ? cleanIncomingPhone : '',
        id: item.id || `rec_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
        updatedAt: new Date().toISOString(),
      };
      list.push(freshRecord);
      newParties.push({
        id: freshRecord.id,
        firmName: freshRecord.cleanedFirmName,
        contactNumber: freshRecord.contactNumber || '',
        amount: freshRecord.amount,
        formattedAmount: freshRecord.formattedAmount
      });
    }
  }

  const summary: UploadSummaryReport = {
    totalExtracted: incomingRecords.length,
    addedCount,
    updatedCount,
    unchangedCount,
    duplicateCount,
    sourceFile: sourceFileName || 'PDF Document',
    newParties,
    updatedParties
  };

  return { 
    merged: list, 
    addedCount, 
    updatedCount, 
    unchangedCount, 
    duplicateCount, 
    summary 
  };
}
