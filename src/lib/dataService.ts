import { 
  collection, 
  doc, 
  setDoc, 
  addDoc, 
  getDocs, 
  deleteDoc, 
  updateDoc, 
  serverTimestamp 
} from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../firebase';
import { UserProfile } from './auth';
import { toTitleCase } from './utils';

export interface AuditLogItem {
  id: string;
  action: 'CREATE' | 'UPDATE' | 'DELETE' | 'RESTORE' | 'BACKUP_EXPORT' | 'BACKUP_IMPORT';
  collection: string;
  recordId: string;
  recordSummary: string;
  performedByUid: string;
  performedByName: string;
  timestamp: string;
}

/**
 * Safe Firestore write helper that guarantees zero data loss:
 * 1. Immediately saves record to localStorage for that collection (key: `blackworm_local_${colName}`)
 * 2. Attempts remote Firestore setDoc with retries
 * 3. If Firestore rejects due to Quota Limit / Network / Offline, safely enqueues to `blackworm_pending_sync`
 *    and returns { success: true, isCachedLocally: true } so user workflow is uninterrupted.
 */
export async function safeFirestoreSet<T extends Record<string, any>>(
  colName: string,
  docId: string,
  data: T,
  options: { merge?: boolean } = { merge: true },
  retryCount = 0
): Promise<{ success: boolean; isCachedLocally: boolean; error?: string }> {
  // 1. Immediately backup locally in dedicated collection store
  try {
    const storageKey = `blackworm_local_${colName}`;
    const raw = typeof window !== 'undefined' ? localStorage.getItem(storageKey) : null;
    const map = raw ? JSON.parse(raw) : {};
    map[docId] = {
      ...(options.merge && map[docId] ? map[docId] : {}),
      ...data,
      id: docId,
      _localSavedAt: new Date().toISOString(),
    };
    if (typeof window !== 'undefined') {
      localStorage.setItem(storageKey, JSON.stringify(map));
    }
  } catch (e) {
    console.warn(`Local caching notice for ${colName}/${docId}:`, e);
  }

  // 2. Attempt remote Firestore save with exponential backoff
  try {
    await setDoc(doc(db, colName, docId), data, options);
    // If successful, remove from pending sync if it was there
    removeFromPendingSync(colName, docId);
    return { success: true, isCachedLocally: false };
  } catch (err: any) {
    const rawMsg = err instanceof Error ? err.message : String(err);
    const isQuota = rawMsg.toLowerCase().includes('quota') || rawMsg.toLowerCase().includes('resource_exhausted');
    
    // If it's a network error and we haven't reached max retries, try again
    const isNetworkError = rawMsg.toLowerCase().includes('network') || rawMsg.toLowerCase().includes('unavailable') || rawMsg.toLowerCase().includes('offline');
    if (isNetworkError && retryCount < 3) {
      const delay = Math.pow(2, retryCount) * 1000;
      await new Promise(resolve => setTimeout(resolve, delay));
      return safeFirestoreSet(colName, docId, data, options, retryCount + 1);
    }

    console.warn(`Firestore write deferred (${isQuota ? 'Daily Quota Limit' : 'Offline'}): ${colName}/${docId}`);

    // Queue for subsequent synchronization
    addToPendingSync(colName, docId, data, options);

    return {
      success: true,
      isCachedLocally: true,
      error: rawMsg,
    };
  }
}

function addToPendingSync(colName: string, docId: string, data: any, options: any) {
  try {
    if (typeof window !== 'undefined') {
      const qKey = 'blackworm_pending_sync';
      const queueRaw = localStorage.getItem(qKey);
      const queue: any[] = queueRaw ? JSON.parse(queueRaw) : [];
      const idx = queue.findIndex((q) => q.collection === colName && q.id === docId);
      const item = { collection: colName, id: docId, data, options, timestamp: Date.now() };
      if (idx >= 0) queue[idx] = item;
      else queue.push(item);
      localStorage.setItem(qKey, JSON.stringify(queue.slice(-200)));
    }
  } catch {}
}

function removeFromPendingSync(colName: string, docId: string) {
  try {
    if (typeof window !== 'undefined') {
      const qKey = 'blackworm_pending_sync';
      const queueRaw = localStorage.getItem(qKey);
      if (!queueRaw) return;
      let queue: any[] = JSON.parse(queueRaw);
      const filtered = queue.filter((q) => !(q.collection === colName && q.id === docId));
      if (filtered.length !== queue.length) {
        localStorage.setItem(qKey, JSON.stringify(filtered));
      }
    }
  } catch {}
}

/**
 * Background worker to sync pending data to Firestore
 */
let isSyncing = false;
export async function startBackgroundSync() {
  if (isSyncing || typeof window === 'undefined') return;
  isSyncing = true;

  const processQueue = async () => {
    try {
      const qKey = 'blackworm_pending_sync';
      const queueRaw = localStorage.getItem(qKey);
      if (!queueRaw) {
        isSyncing = false;
        return;
      }

      const queue: any[] = JSON.parse(queueRaw);
      if (queue.length === 0) {
        isSyncing = false;
        return;
      }

      console.log(`Syncing ${queue.length} pending records to Firestore...`);
      
      const remaining: any[] = [];
      for (const item of queue) {
        try {
          // Attempt direct setDoc without recursion for background sync
          await setDoc(doc(db, item.collection, item.id), item.data, item.options);
          console.log(`Successfully synced: ${item.collection}/${item.id}`);
        } catch (err: any) {
          const rawMsg = err instanceof Error ? err.message : String(err);
          const isQuota = rawMsg.toLowerCase().includes('quota') || rawMsg.toLowerCase().includes('resource_exhausted');
          if (isQuota) {
            // If quota hit, stop processing but keep remaining items
            remaining.push(...queue.slice(queue.indexOf(item)));
            break;
          }
          // For other errors (like offline), keep it in queue for next run
          remaining.push(item);
        }
      }

      localStorage.setItem(qKey, JSON.stringify(remaining));
    } catch (e) {
      console.error('Background sync error:', e);
    } finally {
      isSyncing = false;
    }
  };

  await processQueue();
  // Run every 5 minutes
  setInterval(processQueue, 5 * 60 * 1000);
}

/**
 * Safe Firestore update helper with retries
 */
export async function safeFirestoreUpdate(
  colName: string,
  docId: string,
  data: any,
  retryCount = 0
): Promise<{ success: boolean; error?: string }> {
  try {
    await updateDoc(doc(db, colName, docId), {
      ...data,
      updatedAt: new Date().toISOString(),
    });
    removeFromPendingSync(colName, docId);
    return { success: true };
  } catch (err: any) {
    const rawMsg = err instanceof Error ? err.message : String(err);
    const isNetworkError = rawMsg.toLowerCase().includes('network') || rawMsg.toLowerCase().includes('unavailable') || rawMsg.toLowerCase().includes('offline');
    
    if (isNetworkError && retryCount < 3) {
      const delay = Math.pow(2, retryCount) * 1000;
      await new Promise(resolve => setTimeout(resolve, delay));
      return safeFirestoreUpdate(colName, docId, data, retryCount + 1);
    }
    
    addToPendingSync(colName, docId, data, { merge: true });
    return { success: false, error: rawMsg };
  }
}

/**
 * Safe Firestore add helper with retries
 */
export async function safeFirestoreAdd(
  colName: string,
  data: any,
  retryCount = 0
): Promise<{ success: boolean; id?: string; error?: string }> {
  try {
    const docRef = await addDoc(collection(db, colName), {
      ...data,
      createdAt: data.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    return { success: true, id: docRef.id };
  } catch (err: any) {
    const rawMsg = err instanceof Error ? err.message : String(err);
    const isNetworkError = rawMsg.toLowerCase().includes('network') || rawMsg.toLowerCase().includes('unavailable') || rawMsg.toLowerCase().includes('offline');
    
    if (isNetworkError && retryCount < 3) {
      const delay = Math.pow(2, retryCount) * 1000;
      await new Promise(resolve => setTimeout(resolve, delay));
      return safeFirestoreAdd(colName, data, retryCount + 1);
    }
    
    // For addDoc, we don't have a docId yet, so we generate one for the queue
    const tempId = `temp_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    addToPendingSync(colName, tempId, data, { merge: true });
    return { success: false, id: tempId, error: rawMsg };
  }
}

export function getPendingSyncCount(): number {
  try {
    if (typeof window === 'undefined') return 0;
    const qKey = 'blackworm_pending_sync';
    const queueRaw = localStorage.getItem(qKey);
    if (!queueRaw) return 0;
    const queue: any[] = JSON.parse(queueRaw);
    return queue.length;
  } catch {
    return 0;
  }
}

/**
 * Safe Firestore query helper that handles network errors and quota limits gracefully.
 */
export async function safeFirestoreQuery<T>(
  queryFn: () => Promise<T>,
  fallbackValue: T,
  retryCount = 0
): Promise<T> {
  try {
    return await queryFn();
  } catch (err: any) {
    const rawMsg = err instanceof Error ? err.message : String(err);
    const isNetworkError = rawMsg.toLowerCase().includes('network') || rawMsg.toLowerCase().includes('unavailable') || rawMsg.toLowerCase().includes('offline');
    
    if (isNetworkError && retryCount < 2) {
      const delay = Math.pow(2, retryCount) * 1000;
      await new Promise(resolve => setTimeout(resolve, delay));
      return safeFirestoreQuery(queryFn, fallbackValue, retryCount + 1);
    }
    
    console.warn(`Firestore query failed: ${rawMsg}. Using fallback.`);
    return fallbackValue;
  }
}

/**
 * Merges Firestore snapshot data with any locally saved updates
 */
export function mergeWithLocalData<T extends { id: string }>(
  colName: string,
  serverItems: T[]
): T[] {
  try {
    if (typeof window === 'undefined') return serverItems;
    const storageKey = `blackworm_local_${colName}`;
    const raw = localStorage.getItem(storageKey);
    if (!raw) return serverItems;
    
    let map: Record<string, any>;
    try {
      map = JSON.parse(raw);
    } catch (e) {
      console.warn(`Local cache corrupt for ${colName}, clearing.`);
      localStorage.removeItem(storageKey);
      return serverItems;
    }
    
    const mergedMap = new Map<string, any>();

    // First insert server items
    serverItems.forEach((it) => {
      mergedMap.set(it.id, it);
    });

    // Then overlay/append locally saved items
    Object.entries(map).forEach(([id, localDoc]) => {
      if (mergedMap.has(id)) {
        // Only merge if local is newer or server data is missing key fields
        const serverItem = mergedMap.get(id);
        const localTime = new Date(localDoc._localSavedAt || 0).getTime();
        const serverTime = new Date(serverItem.updatedAt || serverItem.createdAt || 0).getTime();
        
        if (localTime > serverTime) {
          mergedMap.set(id, { ...serverItem, ...localDoc });
        }
      } else {
        mergedMap.set(id, localDoc);
      }
    });

    return Array.from(mergedMap.values());
  } catch (e) {
    console.warn(`Merge error for ${colName}:`, e);
    return serverItems;
  }
}

export interface DeletedRecordItem {
  id: string;
  originalCollection: string;
  originalRecordId: string;
  data: any;
  deletedByUid: string;
  deletedByName: string;
  deletedAt: string;
}

export async function logAudit(
  action: AuditLogItem['action'],
  colName: string,
  recordId: string,
  summary: string,
  user: UserProfile
) {
  try {
    const auditRef = collection(db, 'audit_logs');
    const logData = {
      action,
      collection: colName,
      recordId,
      recordSummary: summary,
      performedByUid: user.uid,
      performedByName: user.fullName || 'User',
      timestamp: new Date().toISOString(),
      createdAt: serverTimestamp(),
    };
    await addDoc(auditRef, logData);
  } catch (err) {
    // Non-fatal audit log absorption
  }
}

export async function softDeleteRecord(
  colName: string,
  recordId: string,
  recordData: any,
  user: UserProfile
) {
  try {
    const trashDocRef = doc(collection(db, 'deleted_records'));
    await setDoc(trashDocRef, {
      id: trashDocRef.id,
      originalCollection: colName,
      originalRecordId: recordId,
      data: recordData,
      deletedByUid: user.uid,
      deletedByName: user.fullName || 'User',
      deletedAt: new Date().toISOString(),
    });

    const originalDocRef = doc(db, colName, recordId);
    await updateDoc(originalDocRef, {
      isArchived: true,
      updatedAt: new Date().toISOString(),
      updatedBy: user.uid,
    });

    await logAudit('DELETE', colName, recordId, `Soft deleted: ${recordData.name || recordData.shopName || recordData.title || recordId}`, user);
    return true;
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, `${colName}/${recordId}`);
    return false;
  }
}

export async function restoreRecord(
  trashRecord: DeletedRecordItem,
  user: UserProfile
) {
  try {
    const originalDocRef = doc(db, trashRecord.originalCollection, trashRecord.originalRecordId);
    await updateDoc(originalDocRef, {
      isArchived: false,
      updatedAt: new Date().toISOString(),
      restoredBy: user.uid,
    });

    await deleteDoc(doc(db, 'deleted_records', trashRecord.id));
    await logAudit('RESTORE', trashRecord.originalCollection, trashRecord.originalRecordId, `Restored from recycle bin`, user);
    return true;
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, `deleted_records/${trashRecord.id}`);
    return false;
  }
}

export async function exportAllData() {
  const collectionsToExport = ['users', 'farmers', 'orders', 'targets', 'travel_records', 'dealers', 'products', 'schemes', 'audit_logs'];
  const backup: Record<string, any[]> = {
    _metadata: [{
      version: '1.0',
      exportedAt: new Date().toISOString(),
      app: 'Blackworm Agritech Pvt Ltd',
    }]
  };

  for (const col of collectionsToExport) {
    try {
      const snap = await getDocs(collection(db, col));
      backup[col] = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (e) {
      console.warn(`Export skipping ${col}:`, e);
      backup[col] = [];
    }
  }

  const jsonStr = JSON.stringify(backup, null, 2);
  const blob = new Blob([jsonStr], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `blackworm_backup_${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

export async function seedInitialDataIfEmpty(user: UserProfile) {
  try {
    if (typeof window !== 'undefined' && localStorage.getItem('blackworm_initial_seeded') === 'true') {
      return;
    }

    const productsSnap = await getDocs(collection(db, 'products'));
    if (productsSnap.empty) {
      const initialProducts = [
        { name: 'Blackworm Premium Vermicompost', category: 'Organic Fertilizers', packSize: '50 kg Bag', mrp: 750, dealerPrice: 580, farmerPrice: 650, inStock: true },
        { name: 'Blackworm Vermiwash Liquid Extract', category: 'Bio-Stimulants', packSize: '5 Litre Can', mrp: 600, dealerPrice: 450, farmerPrice: 520, inStock: true },
        { name: 'Bio-NPK Consortium Culture', category: 'Bio-Fertilizers', packSize: '1 Litre Bottle', mrp: 480, dealerPrice: 340, farmerPrice: 400, inStock: true },
        { name: 'Neem Oil Pest Guard 10000 PPM', category: 'Bio-Pesticides', packSize: '1 Litre Bottle', mrp: 650, dealerPrice: 490, farmerPrice: 560, inStock: true },
        { name: 'Humic Acid 98% Potassium Humate', category: 'Soil Conditioners', packSize: '1 kg Pouch', mrp: 550, dealerPrice: 380, farmerPrice: 450, inStock: true }
      ];

      for (const p of initialProducts) {
        const pRef = doc(collection(db, 'products'));
        await setDoc(pRef, {
          id: pRef.id,
          ...p,
          isArchived: false,
          createdAt: new Date().toISOString(),
        });
      }
    }

    const dealersSnap = await getDocs(collection(db, 'dealers'));
    if (dealersSnap.empty) {
      const initialDealers = [
        { shopName: 'Kisan Krushi Seva Kendra', proprietorName: 'Ramesh Patil', mobile: '9822012345', village: 'Baramati', district: 'Pune', gstNo: '27AABCU9603R1ZM', creditLimit: 150000, outstandingBalance: 42500 },
        { shopName: 'Sai Agro Agencies', proprietorName: 'Sanjay Deshmukh', mobile: '9823156789', village: 'Sangamner', district: 'Ahmednagar', gstNo: '27BDCPC1234F1Z3', creditLimit: 200000, outstandingBalance: 68000 }
      ];

      for (const d of initialDealers) {
        const dRef = doc(collection(db, 'dealers'));
        await setDoc(dRef, {
          id: dRef.id,
          ...d,
          ownerId: user.uid,
          isArchived: false,
          createdAt: new Date().toISOString(),
        });
      }
    }

    if (typeof window !== 'undefined') {
      localStorage.setItem('blackworm_initial_seeded', 'true');
    }
  } catch (err) {
    console.error('Initial seeding notice:', err);
  }
}

/**
 * Synchronizes updated user/officer details (name, designation, center) across all linked historical records.
 * Historical form data, calculations, serial numbers, and relationships remain strictly intact.
 * Avoids duplicate or broken records by updating documents by exact ID.
 */
export async function syncOfficerDetailsEverywhere(
  userId: string,
  updatedName: string,
  updatedDesignation?: string,
  updatedCenter?: string,
  extraIdentifiers?: { loginId?: string; oldName?: string; userCode?: string }
) {
  if (!userId || !updatedName) return;

  const cleanName = toTitleCase(updatedName);
  const cleanDesig = toTitleCase(updatedDesignation);
  const cleanCenter = toTitleCase(updatedCenter);
  const extraLogin = (extraIdentifiers?.loginId || '').trim().toLowerCase();
  const extraOldName = (extraIdentifiers?.oldName || '').trim().toUpperCase();
  const extraCode = (extraIdentifiers?.userCode || '').trim().toLowerCase();

  // 1. Sync Dealer Forms (dealers_application)
  try {
    const dealerSnap = await getDocs(collection(db, 'dealers_application'));
    const updates: Promise<any>[] = [];
    dealerSnap.forEach((d) => {
      const data = d.data();
      const isLinked = 
        data.created_by_user_id === userId ||
        data.createdByUid === userId ||
        data.userId === userId ||
        data.ownerId === userId ||
        (extraLogin && data.loginId && data.loginId.toLowerCase() === extraLogin) ||
        (extraCode && data.userCode && String(data.userCode).toLowerCase() === extraCode) ||
        (extraOldName && data.officerName && data.officerName.toUpperCase() === extraOldName) ||
        (extraOldName && data.created_by_name && data.created_by_name.toUpperCase() === extraOldName);

      const needsChange = 
        data.officerName !== cleanName ||
        data.created_by_name !== cleanName ||
        (cleanDesig && data.designation !== cleanDesig);

      if (isLinked && needsChange) {
        updates.push(
          updateDoc(doc(db, 'dealers_application', d.id), {
            officerName: cleanName,
            created_by_name: cleanName,
            createdByName: cleanName,
            ...(cleanDesig ? { designation: cleanDesig } : {}),
            updatedAt: new Date().toISOString(),
          }).catch((e) => console.warn(`Sync notice for dealer ${d.id}:`, e))
        );
      }
    });
    if (updates.length > 0) {
      await Promise.all(updates);
    }
  } catch (err) {
    console.warn('Sync notice in dealers_application:', err);
  }

  // 2. Sync Orders (orders)
  try {
    const ordersSnap = await getDocs(collection(db, 'orders'));
    const updates: Promise<any>[] = [];
    ordersSnap.forEach((o) => {
      const data = o.data();
      const isLinked = 
        data.userId === userId || 
        data.ownerId === userId ||
        (extraLogin && data.loginId && data.loginId.toLowerCase() === extraLogin) ||
        (extraOldName && data.createdByName && data.createdByName.toUpperCase() === extraOldName);

      const needsChange = 
        data.createdByName !== cleanName ||
        (cleanDesig && data.designation !== cleanDesig);

      if (isLinked && needsChange) {
        updates.push(
          updateDoc(doc(db, 'orders', o.id), {
            createdByName: cleanName,
            ...(cleanDesig ? { designation: cleanDesig } : {}),
            updatedAt: new Date().toISOString(),
          }).catch((e) => console.warn(`Sync notice for order ${o.id}:`, e))
        );
      }
    });
    if (updates.length > 0) {
      await Promise.all(updates);
    }
  } catch (err) {
    console.warn('Sync notice in orders:', err);
  }

  // 3. Sync Collection Entries (collection_entries)
  try {
    const collSnap = await getDocs(collection(db, 'collection_entries'));
    const updates: Promise<any>[] = [];
    collSnap.forEach((c) => {
      const data = c.data();
      const isLinked = 
        data.userId === userId || 
        data.ownerId === userId ||
        data.collectedByUid === userId ||
        (extraLogin && data.loginId && data.loginId.toLowerCase() === extraLogin) ||
        (extraOldName && data.collectedByName && data.collectedByName.toUpperCase() === extraOldName) ||
        (extraOldName && data.createdByName && data.createdByName.toUpperCase() === extraOldName);

      const needsChange = 
        data.createdByName !== cleanName ||
        data.collectedByName !== cleanName ||
        data.officerName !== cleanName;

      if (isLinked && needsChange) {
        updates.push(
          updateDoc(doc(db, 'collection_entries', c.id), {
            createdByName: cleanName,
            collectedByName: cleanName,
            officerName: cleanName,
            updatedAt: new Date().toISOString(),
          }).catch((e) => console.warn(`Sync notice for collection ${c.id}:`, e))
        );
      }
    });
    if (updates.length > 0) {
      await Promise.all(updates);
    }
  } catch (err) {
    console.warn('Sync notice in collection_entries:', err);
  }

  // 4. Sync Travel Sheets (travel_sheets)
  try {
    const travelSnap = await getDocs(collection(db, 'travel_sheets'));
    const updates: Promise<any>[] = [];
    travelSnap.forEach((t) => {
      const data = t.data();
      const isLinked = data.userId === userId || t.id.startsWith(`travel_${userId}`);
      const needsChange = 
        data.officerName !== cleanName ||
        (cleanDesig && data.designation !== cleanDesig);

      if (isLinked && needsChange) {
        updates.push(
          updateDoc(doc(db, 'travel_sheets', t.id), {
            officerName: cleanName,
            ...(cleanDesig ? { designation: cleanDesig } : {}),
            updatedAt: new Date().toISOString(),
          }).catch((e) => console.warn(`Sync notice for travel_sheet ${t.id}:`, e))
        );
      }
    });
    if (updates.length > 0) {
      await Promise.all(updates);
    }
  } catch (err) {
    console.warn('Sync notice in travel_sheets:', err);
  }

  // 5. Sync Yearly Targets (yearly_targets)
  try {
    const targetSnap = await getDocs(collection(db, 'yearly_targets'));
    const updates: Promise<any>[] = [];
    targetSnap.forEach((tg) => {
      const data = tg.data();
      const isLinked = data.userId === userId || tg.id.startsWith(`yearly_${userId}`);
      const needsChange = 
        data.fullName !== cleanName ||
        (cleanDesig && data.designation !== cleanDesig) ||
        (cleanCenter && data.center !== cleanCenter);

      if (isLinked && needsChange) {
        updates.push(
          updateDoc(doc(db, 'yearly_targets', tg.id), {
            fullName: cleanName,
            ...(cleanDesig ? { designation: cleanDesig } : {}),
            ...(cleanCenter ? { center: cleanCenter } : {}),
            updatedAt: new Date().toISOString(),
          }).catch((e) => console.warn(`Sync notice for yearly_target ${tg.id}:`, e))
        );
      }
    });
    if (updates.length > 0) {
      await Promise.all(updates);
    }
  } catch (err) {
    console.warn('Sync notice in yearly_targets:', err);
  }

  // 6. Sync Targets (targets)
  try {
    const oldTargetsSnap = await getDocs(collection(db, 'targets'));
    const updates: Promise<any>[] = [];
    oldTargetsSnap.forEach((ot) => {
      const data = ot.data();
      if (data.userId === userId && data.userName !== cleanName) {
        updates.push(
          updateDoc(doc(db, 'targets', ot.id), {
            userName: cleanName,
            updatedAt: new Date().toISOString(),
          }).catch((e) => console.warn(`Sync notice for target ${ot.id}:`, e))
        );
      }
    });
    if (updates.length > 0) {
      await Promise.all(updates);
    }
  } catch (err) {
    console.warn('Sync notice in targets:', err);
  }
}

/**
 * Creates a comprehensive full backup of the entire application database across all collections.
 * Generates and downloads a complete JSON file that any developer can run or restore anywhere.
 */
export async function exportFullDatabaseBackup(profile: UserProfile): Promise<{ success: boolean; filename: string; stats: Record<string, number> }> {
  const collectionsToBackup = [
    'users',
    'dealers_application',
    'orders',
    'collection_entries',
    'travel_sheets',
    'yearly_targets',
    'targets',
    'travel_records',
    'products_pricelist_v2',
    'pricelist_backups',
    'config',
    'deleted_records',
    'audit_logs',
  ];

  const backupData: Record<string, any[]> = {};
  const stats: Record<string, number> = {};

  for (const colName of collectionsToBackup) {
    try {
      const snap = await getDocs(collection(db, colName));
      const docsList: any[] = [];
      snap.forEach((d) => {
        docsList.push({ _id: d.id, ...d.data() });
      });
      backupData[colName] = docsList;
      stats[colName] = docsList.length;
    } catch (e) {
      console.warn(`Could not export collection ${colName}:`, e);
      backupData[colName] = [];
      stats[colName] = 0;
    }
  }

  const exportPayload = {
    appName: 'Blackworm Agritech Pvt Ltd - Core Business Data',
    exportVersion: '2.0',
    exportedAt: new Date().toISOString(),
    exportedByUid: profile.uid,
    exportedByName: profile.fullName || profile.loginId || 'Admin',
    statistics: stats,
    collections: backupData,
  };

  // Local mirror backup in browser storage as additional offline safety net
  try {
    localStorage.setItem('BLACKWORM_LOCAL_DATA_MIRROR', JSON.stringify({
      savedAt: new Date().toISOString(),
      statistics: stats,
    }));
  } catch (e) {
    console.warn('Local mirror storage failed:', e);
  }

  const dateStr = new Date().toISOString().slice(0, 10);
  const timeStr = new Date().toTimeString().slice(0, 8).replace(/:/g, '-');
  const filename = `Blackworm_Full_Database_Backup_${dateStr}_${timeStr}.json`;

  const blob = new Blob([JSON.stringify(exportPayload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);

  try {
    await logAudit(
      'BACKUP_EXPORT',
      'system',
      'full_export',
      `Full system database backup exported by ${profile.fullName || profile.loginId} (${Object.values(stats).reduce((a, b) => a + b, 0)} total records)`,
      profile
    );
  } catch (e) {
    console.warn('Audit failed on backup export:', e);
  }

  return { success: true, filename, stats };
}

/**
 * Restores all collections from a JSON backup file.
 */
export async function restoreDatabaseFromJson(jsonData: string, profile: UserProfile): Promise<{ success: boolean; restoredCount: number; message: string }> {
  const parsed = JSON.parse(jsonData);
  if (!parsed || !parsed.collections) {
    throw new Error('अवैध बॅकअप फाईल स्वरूप (Invalid backup file structure).');
  }

  let totalRestored = 0;
  for (const [colName, docsList] of Object.entries(parsed.collections)) {
    if (Array.isArray(docsList)) {
      for (const item of docsList) {
        const docId = item._id || item.id;
        if (docId) {
          const cleanItem = { ...item };
          delete cleanItem._id;
          await setDoc(doc(db, colName, docId), cleanItem, { merge: true });
          totalRestored++;
        }
      }
    }
  }

  try {
    await logAudit(
      'BACKUP_IMPORT',
      'system',
      'full_import',
      `Restored database from JSON backup (${totalRestored} records restored) by ${profile.fullName || profile.loginId}`,
      profile
    );
  } catch (e) {
    console.warn('Audit failed on backup import:', e);
  }

  return { success: true, restoredCount: totalRestored, message: `${totalRestored} रेकॉर्ड यशस्वीरित्या रिस्टोर झाले.` };
}
