import * as pdfjsLib from 'pdfjs-dist';

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
 * Normalizes firm names for fuzzy matching by stripping legal suffixes,
 * business types, punctuation, excessive whitespace in English and Marathi.
 */
export function normalizeFirmName(name: string): string {
  if (!name) return '';
  return name
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

  const cleanAmount = amountFormatted.replace(/^₹\s*/, '').trim();

  const message = `${firmName}
Rajarambapu Sahakari Bank
Br - Miraj
Acc No. 035330268109560
IFSC - RRBP0000035

*NEFT Total Amount - ₹${cleanAmount}/-*`;

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
function isIgnoredHeaderRow(text: string): boolean {
  const t = text.toLowerCase().trim();
  if (t.length < 3) return true;
  if (/^(page\s+\d+|printed\s+on|blackworm|report\s+date|as\s+on\s+date)/i.test(t)) return true;
  if (
    t.includes('particulars') &&
    (t.includes('debit') || t.includes('credit') || t.includes('balance') || t.includes('amount'))
  ) {
    return true;
  }
  if (t === 'sr no' || t === 'party name' || t === 'dealer name' || t === 'closing balance') {
    return true;
  }
  if (/^(total|grand total|sub total|net total)\b/i.test(t)) return true;
  return false;
}

/**
 * Reads and parses PDF file array buffer to extract firm names and outstanding balances.
 */
export async function parseOutstandingPdf(
  fileBuffer: ArrayBuffer,
  sourceFileName?: string
): Promise<ExtractedRecord[]> {
  try {
    // If worker fails in some iframe environment, try loading without worker
    const loadingTask = pdfjsLib.getDocument({
      data: new Uint8Array(fileBuffer),
      useSystemFonts: true,
    });

    const pdfDoc = await loadingTask.promise;
    const numPages = pdfDoc.numPages;
    const extractedList: ExtractedRecord[] = [];

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

        // Find existing close line bucket
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

      // Sort lines top-to-bottom (PDF Y goes from bottom to top, so descending Y = top to bottom)
      const sortedY = Array.from(linesMap.keys()).sort((a, b) => b - a);

      for (const y of sortedY) {
        const lineItems = linesMap.get(y)!;
        lineItems.sort((a, b) => a.x - b.x);

        const fullLine = lineItems.map(it => it.str).join(' ').trim();
        if (isIgnoredHeaderRow(fullLine)) continue;

        // Pattern 1: Table row with Firm Name and Amounts
        // E.g. "1  Kisan Krushi Seva Kendra   Sangli  1,45,200.00 Dr"
        // E.g. "Shree Ganesh Agro  45,000"
        
        // Find monetary numbers in line:
        // Match numbers like 1,45,200 or 1,45,200.00 or 45000 with optional Dr / /-
        const amountRegex = /(?:₹|Rs\.?)?\s*([0-9]{1,3}(?:,[0-9]{2,3})+(?:\.[0-9]{1,2})?|[0-9]{3,8}(?:\.[0-9]{1,2})?)\s*(?:Dr|dr|\/-)?/g;
        
        const amountMatches: Array<{ match: string; value: number; index: number }> = [];
        let match: RegExpExecArray | null;

        while ((match = amountRegex.exec(fullLine)) !== null) {
          const val = parseIndianAmount(match[0]);
          if (val && val >= 100) {
            amountMatches.push({ match: match[0], value: val, index: match.index });
          }
        }

        if (amountMatches.length > 0) {
          // Typically the last amount on the line is Closing Balance / Outstanding
          const targetAmount = amountMatches[amountMatches.length - 1];

          // Text before the amount is the party / firm name
          let candidateName = fullLine.substring(0, targetAmount.index).trim();

          // Strip leading serial numbers: "1.", "1 ", "1)", "#1"
          candidateName = candidateName.replace(/^[\d#\(\)\[\]\.\-]+\s+/, '').trim();

          // If there are other numbers at the beginning (like dealer code e.g. "D-102"), preserve candidate name
          // Strip unwanted prefixes/suffixes or trailing dashes
          candidateName = candidateName.replace(/[:\|\-–]+$/, '').trim();

          // Validate candidate name (supports English and Devanagari/Marathi characters)
          const hasLetters = /[a-zA-Z\u0900-\u097F]/.test(candidateName);
          const isNotHeader = !isIgnoredHeaderRow(candidateName);

          if (candidateName.length >= 3 && hasLetters && isNotHeader && targetAmount.value > 0) {
            extractedList.push({
              id: `rec_${pageNum}_${y}_${Math.random().toString(36).substring(2, 7)}`,
              rawFirmName: candidateName,
              cleanedFirmName: candidateName,
              amount: targetAmount.value,
              formattedAmount: targetAmount.value.toLocaleString('en-IN'),
              page: pageNum,
              rawLine: fullLine,
              sourceFile: sourceFileName || 'PDF Document',
            });
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

/**
 * Merges newly extracted records into an existing list of records while strictly
 * deduplicating (by exact normalized name and fuzzy similarity >= 85).
 * Prevents double entries across multiple uploaded PDFs.
 */
export function mergeAndDeduplicateRecords(
  existingRecords: ExtractedRecord[],
  incomingRecords: ExtractedRecord[],
  sourceFileName?: string
): { merged: ExtractedRecord[]; addedCount: number; duplicateCount: number } {
  let duplicateCount = 0;
  let addedCount = 0;

  // Clone existing array to avoid direct mutation
  const list: ExtractedRecord[] = existingRecords.map(item => ({ ...item }));

  for (const incoming of incomingRecords) {
    const item: ExtractedRecord = {
      ...incoming,
      sourceFile: incoming.sourceFile || sourceFileName || 'PDF Document',
    };

    const normIncoming = normalizeFirmName(item.cleanedFirmName);

    // Look for duplicate in existing list:
    let matchIndex = -1;
    for (let i = 0; i < list.length; i++) {
      const existing = list[i];
      const normExisting = normalizeFirmName(existing.cleanedFirmName);

      // 1. Normalized exact match (ignores punctuation, case, company words like agro, agency, etc.)
      if (normIncoming && normExisting && normIncoming === normExisting) {
        matchIndex = i;
        break;
      }

      // 2. High similarity match (score >= 85)
      const score = getFirmNameMatchScore(item.cleanedFirmName, existing.cleanedFirmName);
      if (score >= 85) {
        matchIndex = i;
        break;
      }
    }

    if (matchIndex >= 0) {
      // DUPLICATE DETECTED!
      duplicateCount++;
      const existing = list[matchIndex];

      // Update amount: keep latest/higher amount from statement
      const newAmount = item.amount > 0 ? item.amount : existing.amount;
      
      // Merge source files if from distinct PDFs
      const existingSources = (existing.sourceFile || '').split(', ').map(s => s.trim()).filter(Boolean);
      const newSource = (item.sourceFile || sourceFileName || '').trim();
      if (newSource && !existingSources.includes(newSource)) {
        existingSources.push(newSource);
      }

      list[matchIndex] = {
        ...existing,
        amount: newAmount,
        formattedAmount: newAmount.toLocaleString('en-IN'),
        // Prefer longer/cleaner firm name
        cleanedFirmName: item.cleanedFirmName.length > existing.cleanedFirmName.length ? item.cleanedFirmName : existing.cleanedFirmName,
        sourceFile: existingSources.join(', ') || existing.sourceFile,
      };
    } else {
      // NEW UNIQUE RECORD
      addedCount++;
      list.push(item);
    }
  }

  return { merged: list, addedCount, duplicateCount };
}
