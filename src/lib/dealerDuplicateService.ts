import { 
  collection, 
  doc, 
  getDoc, 
  getDocs, 
  deleteDoc,
  query, 
  where, 
  runTransaction,
  writeBatch
} from 'firebase/firestore';
import { db } from '../firebase';
import { DealershipFormItem } from '../components/modules/DealerView';

/**
 * Normalization helpers to ensure consistent duplicate detection
 */
export const normalizePhone = (phone?: string): string => {
  if (!phone) return '';
  const digits = phone.replace(/\D/g, '');
  // For Indian phone numbers, take the last 10 digits
  return digits.length >= 10 ? digits.slice(-10) : digits;
};

export const normalizeGst = (gst?: string): string => {
  if (!gst) return '';
  return gst.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
};

export const normalizePan = (pan?: string): string => {
  if (!pan) return '';
  return pan.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
};

export const normalizeAadhaar = (aadhaar?: string): string => {
  if (!aadhaar) return '';
  return aadhaar.replace(/\D/g, '');
};

export const normalizeString = (str?: string): string => {
  if (!str) return '';
  return str
    .trim()
    .toLowerCase()
    .replace(/[\s\-_.,/\\()&]+/g, '')
    .normalize('NFKD');
};

export interface DuplicateCheckResult {
  isDuplicate: boolean;
  reason?: string;
  matchedDealer?: {
    id: string;
    firmName: string;
    dealerCode: string;
    village?: string;
    contactNumber?: string;
    officerName?: string;
  };
}

/**
 * Generate unique registry keys for a dealer
 */
export const generateDealerRegistryKeys = (dealer: {
  contactNumber?: string;
  responsibleContact?: string;
  gstNo?: string;
  panNo?: string;
  aadhaarNo?: string;
  firmName?: string;
  village?: string;
}): string[] => {
  const keys: string[] = [];

  const phone = normalizePhone(dealer.contactNumber);
  if (phone.length === 10) {
    keys.push(`phone_${phone}`);
  }

  const respPhone = normalizePhone(dealer.responsibleContact);
  if (respPhone.length === 10 && respPhone !== phone) {
    keys.push(`phone_${respPhone}`);
  }

  const gst = normalizeGst(dealer.gstNo);
  if (gst.length >= 10) {
    keys.push(`gst_${gst}`);
  }

  const pan = normalizePan(dealer.panNo);
  if (pan.length === 10) {
    keys.push(`pan_${pan}`);
  }

  const aadhaar = normalizeAadhaar(dealer.aadhaarNo);
  if (aadhaar.length === 12) {
    keys.push(`aadhaar_${aadhaar}`);
  }

  const firm = normalizeString(dealer.firmName);
  const village = normalizeString(dealer.village);
  if (firm && village) {
    keys.push(`firm_vil_${firm}_${village}`);
  }

  return keys;
};

/**
 * Comprehensive duplicate check against all existing dealers across ALL users.
 * Checks both the unique registry and the full dealers_application collection.
 */
export const checkDealerDuplicate = async (
  candidate: {
    firmName: string;
    contactNumber?: string;
    responsibleContact?: string;
    gstNo?: string;
    panNo?: string;
    aadhaarNo?: string;
    village?: string;
    proprietorName?: string;
    district?: string;
  },
  currentDealerId?: string
): Promise<DuplicateCheckResult> => {
  const normPhone = normalizePhone(candidate.contactNumber);
  const normRespPhone = normalizePhone(candidate.responsibleContact);
  const normGst = normalizeGst(candidate.gstNo);
  const normPan = normalizePan(candidate.panNo);
  const normAadhaar = normalizeAadhaar(candidate.aadhaarNo);
  const normFirm = normalizeString(candidate.firmName);
  const normVillage = normalizeString(candidate.village);
  const normProprietor = normalizeString(candidate.proprietorName);

  // 1. First check the fast atomic registry
  const candidateKeys = generateDealerRegistryKeys(candidate);
  for (const key of candidateKeys) {
    try {
      const regDoc = await getDoc(doc(db, 'dealer_unique_registry', key));
      if (regDoc.exists()) {
        const regData = regDoc.data();
        if (regData && regData.dealerId && regData.dealerId !== currentDealerId) {
          return {
            isDuplicate: true,
            reason: `हा डीलर आधीच ॲड केलेला आहे (${key.startsWith('phone_') ? 'मोबाईल नंबर' : key.startsWith('gst_') ? 'GST नंबर' : 'फर्म व गाव'}).`,
            matchedDealer: {
              id: regData.dealerId,
              firmName: regData.firmName || candidate.firmName,
              dealerCode: regData.dealerCode || '',
              village: regData.village || candidate.village,
              contactNumber: regData.contactNumber,
            },
          };
        }
      }
    } catch (e) {
      console.warn(`Error reading registry key ${key}:`, e);
    }
  }

  // 2. Query dealers_application across all users to catch legacy records and deep criteria
  try {
    const snap = await getDocs(collection(db, 'dealers_application'));
    for (const d of snap.docs) {
      if (d.id === currentDealerId) continue;

      const data = d.data() as DealershipFormItem;
      if (data.isArchived) continue;

      const existPhone = normalizePhone(data.contactNumber);
      const existRespPhone = normalizePhone(data.responsibleContact);
      const existGst = normalizeGst(data.gstNo);
      const existPan = normalizePan(data.panNo);
      const existAadhaar = normalizeAadhaar(data.aadhaarNo);
      const existFirm = normalizeString(data.firmName);
      const existVillage = normalizeString(data.village);
      const existProprietor = normalizeString(data.proprietorName);

      // Check Mobile Number match (10 digits)
      if (normPhone && normPhone.length === 10) {
        if (normPhone === existPhone || normPhone === existRespPhone) {
          return {
            isDuplicate: true,
            reason: `हा डीलर आधीच ॲड केलेला आहे (मोबाईल नंबर: ${candidate.contactNumber} आधीपासून नोंदणीकृत आहे).`,
            matchedDealer: {
              id: d.id,
              firmName: data.firmName,
              dealerCode: data.dealerCode,
              village: data.village,
              contactNumber: data.contactNumber,
              officerName: data.officerName || data.created_by_name,
            },
          };
        }
      }

      if (normRespPhone && normRespPhone.length === 10) {
        if (normRespPhone === existPhone || normRespPhone === existRespPhone) {
          return {
            isDuplicate: true,
            reason: `हा डीलर आधीच ॲड केलेला आहे (पर्यायी संपर्क क्रमांक: ${candidate.responsibleContact} आधीपासून नोंदणीकृत आहे).`,
            matchedDealer: {
              id: d.id,
              firmName: data.firmName,
              dealerCode: data.dealerCode,
              village: data.village,
              contactNumber: data.contactNumber,
              officerName: data.officerName || data.created_by_name,
            },
          };
        }
      }

      // Check GST match
      if (normGst && normGst.length >= 10 && existGst && normGst === existGst) {
        return {
          isDuplicate: true,
          reason: `हा डीलर आधीच ॲड केलेला आहे (GST क्रमांक: ${candidate.gstNo} आधीपासून नोंदणीकृत आहे).`,
          matchedDealer: {
            id: d.id,
            firmName: data.firmName,
            dealerCode: data.dealerCode,
            village: data.village,
            contactNumber: data.contactNumber,
            officerName: data.officerName || data.created_by_name,
          },
        };
      }

      // Check PAN match
      if (normPan && normPan.length === 10 && existPan && normPan === existPan) {
        return {
          isDuplicate: true,
          reason: `हा डीलर आधीच ॲड केलेला आहे (PAN क्रमांक: ${candidate.panNo} आधीपासून नोंदणीकृत आहे).`,
          matchedDealer: {
            id: d.id,
            firmName: data.firmName,
            dealerCode: data.dealerCode,
            village: data.village,
            contactNumber: data.contactNumber,
            officerName: data.officerName || data.created_by_name,
          },
        };
      }

      // Check Aadhaar match
      if (normAadhaar && normAadhaar.length === 12 && existAadhaar && normAadhaar === existAadhaar) {
        return {
          isDuplicate: true,
          reason: `हा डीलर आधीच ॲड केलेला आहे (आधार क्रमांक: ${candidate.aadhaarNo} आधीपासून नोंदणीकृत आहे).`,
          matchedDealer: {
            id: d.id,
            firmName: data.firmName,
            dealerCode: data.dealerCode,
            village: data.village,
            contactNumber: data.contactNumber,
            officerName: data.officerName || data.created_by_name,
          },
        };
      }

      // Check Firm Name AND Location/Proprietor match
      // If firm name matches, check if village or proprietor matches to confirm it's the exact same shop
      if (normFirm && existFirm && normFirm === existFirm) {
        const sameVillage = normVillage && existVillage && normVillage === existVillage;
        const sameProprietor = normProprietor && existProprietor && normProprietor === existProprietor;

        if (sameVillage || sameProprietor) {
          return {
            isDuplicate: true,
            reason: `हा डीलर आधीच ॲड केलेला आहे (फर्मचे नाव: "${data.firmName}" ${sameVillage ? `आणि गाव: "${data.village}"` : `आणि मालक: "${data.proprietorName}"`} आधीपासून नोंदणीकृत आहे).`,
            matchedDealer: {
              id: d.id,
              firmName: data.firmName,
              dealerCode: data.dealerCode,
              village: data.village,
              contactNumber: data.contactNumber,
              officerName: data.officerName || data.created_by_name,
            },
          };
        }
      }
    }
  } catch (err) {
    console.warn('Error querying all dealers for duplicate check:', err);
  }

  return { isDuplicate: false };
};

/**
 * Save dealer with Database-Level Concurrency Protection using Firestore Transaction.
 * Atomically reserves unique keys in `dealer_unique_registry` and saves to `dealers_application`.
 * If another user attempts to save the same dealer at the exact same millisecond,
 * one will succeed and the second will fail atomically with a duplicate lock error.
 */
export const saveDealerWithAtomicRegistry = async (
  id: string,
  payload: DealershipFormItem,
  isNewRecord: boolean
): Promise<{ success: boolean; error?: string; matchedDealer?: any }> => {
  const keys = generateDealerRegistryKeys(payload);

  try {
    await runTransaction(db, async (transaction) => {
      // 1. In transaction, check all registry keys
      for (const key of keys) {
        const regRef = doc(db, 'dealer_unique_registry', key);
        const regSnap = await transaction.get(regRef);
        if (regSnap.exists()) {
          const data = regSnap.data();
          if (data && data.dealerId && data.dealerId !== id) {
            throw new Error(`DUPLICATE_REGISTRY:${key}:${data.firmName || ''}:${data.dealerCode || ''}`);
          }
        }
      }

      // 2. Write the dealer document
      const dealerRef = doc(db, 'dealers_application', id);
      transaction.set(dealerRef, payload, { merge: true });

      // 3. Register the unique keys pointing to this dealer
      const nowIso = new Date().toISOString();
      for (const key of keys) {
        const regRef = doc(db, 'dealer_unique_registry', key);
        transaction.set(
          regRef,
          {
            key,
            dealerId: id,
            dealerCode: payload.dealerCode,
            firmName: payload.firmName,
            village: payload.village || '',
            contactNumber: payload.contactNumber || '',
            gstNo: payload.gstNo || '',
            ownerId: payload.ownerId || payload.userId || '',
            updatedAt: nowIso,
            isArchived: false,
          },
          { merge: true }
        );
      }
    });

    return { success: true };
  } catch (err: any) {
    const msg = err.message || '';
    if (msg.includes('DUPLICATE_REGISTRY')) {
      const parts = msg.split(':');
      const keyName = parts[1] || '';
      const firmName = parts[2] || payload.firmName;
      const dealerCode = parts[3] || '';
      return {
        success: false,
        error: 'हा डीलर आधीच ॲड केलेला आहे',
        matchedDealer: {
          firmName,
          dealerCode,
          keyName,
        },
      };
    }

    // Fallback: if transaction failed for another reason, bubble it up
    throw err;
  }
};

/**
 * Remove unique registry keys when a dealer is deleted
 */
export const removeDealerRegistryKeys = async (dealer: {
  contactNumber?: string;
  responsibleContact?: string;
  gstNo?: string;
  panNo?: string;
  aadhaarNo?: string;
  firmName?: string;
  village?: string;
}) => {
  const keys = generateDealerRegistryKeys(dealer);
  for (const k of keys) {
    try {
      await deleteDoc(doc(db, 'dealer_unique_registry', k));
    } catch (e) {
      console.warn('Failed to delete registry key:', k, e);
    }
  }
};
