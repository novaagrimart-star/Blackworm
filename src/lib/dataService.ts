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
    console.error('Failed to write audit log:', err);
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
  updatedCenter?: string
) {
  if (!userId || !updatedName) return;

  const cleanNameUpper = updatedName.trim().toUpperCase();
  const cleanDesigUpper = (updatedDesignation || '').trim().toUpperCase();
  const cleanCenterUpper = (updatedCenter || '').trim().toUpperCase();

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
        data.ownerId === userId;

      if (isLinked) {
        updates.push(
          updateDoc(doc(db, 'dealers_application', d.id), {
            officerName: cleanNameUpper,
            created_by_name: cleanNameUpper,
            createdByName: cleanNameUpper,
            ...(cleanDesigUpper ? { designation: cleanDesigUpper } : {}),
            updatedAt: new Date().toISOString(),
          }).catch((e) => console.warn(`Sync failed for dealer ${d.id}:`, e))
        );
      }
    });
    if (updates.length > 0) {
      await Promise.all(updates);
    }
  } catch (err) {
    console.error('Error syncing officer in dealers_application:', err);
  }

  // 2. Sync Orders (orders)
  try {
    const ordersSnap = await getDocs(collection(db, 'orders'));
    const updates: Promise<any>[] = [];
    ordersSnap.forEach((o) => {
      const data = o.data();
      const isLinked = data.userId === userId || data.ownerId === userId;
      if (isLinked) {
        updates.push(
          updateDoc(doc(db, 'orders', o.id), {
            createdByName: updatedName.trim(),
            updatedAt: new Date().toISOString(),
          }).catch((e) => console.warn(`Sync failed for order ${o.id}:`, e))
        );
      }
    });
    if (updates.length > 0) {
      await Promise.all(updates);
    }
  } catch (err) {
    console.error('Error syncing officer in orders:', err);
  }

  // 3. Sync Collection Entries (collection_entries)
  try {
    const collSnap = await getDocs(collection(db, 'collection_entries'));
    const updates: Promise<any>[] = [];
    collSnap.forEach((c) => {
      const data = c.data();
      const isLinked = data.userId === userId || data.ownerId === userId;
      if (isLinked) {
        updates.push(
          updateDoc(doc(db, 'collection_entries', c.id), {
            createdByName: updatedName.trim(),
            officerName: updatedName.trim(),
            updatedAt: new Date().toISOString(),
          }).catch((e) => console.warn(`Sync failed for collection ${c.id}:`, e))
        );
      }
    });
    if (updates.length > 0) {
      await Promise.all(updates);
    }
  } catch (err) {
    console.error('Error syncing officer in collection_entries:', err);
  }

  // 4. Sync Travel Sheets (travel_sheets)
  try {
    const travelSnap = await getDocs(collection(db, 'travel_sheets'));
    const updates: Promise<any>[] = [];
    travelSnap.forEach((t) => {
      const data = t.data();
      const isLinked = data.userId === userId || t.id.startsWith(`travel_${userId}`);
      if (isLinked) {
        updates.push(
          updateDoc(doc(db, 'travel_sheets', t.id), {
            officerName: cleanNameUpper,
            ...(cleanDesigUpper ? { designation: cleanDesigUpper } : {}),
            updatedAt: new Date().toISOString(),
          }).catch((e) => console.warn(`Sync failed for travel_sheet ${t.id}:`, e))
        );
      }
    });
    if (updates.length > 0) {
      await Promise.all(updates);
    }
  } catch (err) {
    console.error('Error syncing officer in travel_sheets:', err);
  }

  // 5. Sync Yearly Targets (yearly_targets)
  try {
    const targetSnap = await getDocs(collection(db, 'yearly_targets'));
    const updates: Promise<any>[] = [];
    targetSnap.forEach((tg) => {
      const data = tg.data();
      const isLinked = data.userId === userId || tg.id.startsWith(`yearly_${userId}`);
      if (isLinked) {
        updates.push(
          updateDoc(doc(db, 'yearly_targets', tg.id), {
            fullName: cleanNameUpper,
            ...(cleanDesigUpper ? { designation: cleanDesigUpper } : {}),
            ...(cleanCenterUpper ? { center: cleanCenterUpper } : {}),
            updatedAt: new Date().toISOString(),
          }).catch((e) => console.warn(`Sync failed for yearly_target ${tg.id}:`, e))
        );
      }
    });
    if (updates.length > 0) {
      await Promise.all(updates);
    }
  } catch (err) {
    console.error('Error syncing officer in yearly_targets:', err);
  }

  // 6. Sync Targets (targets)
  try {
    const oldTargetsSnap = await getDocs(collection(db, 'targets'));
    const updates: Promise<any>[] = [];
    oldTargetsSnap.forEach((ot) => {
      const data = ot.data();
      if (data.userId === userId) {
        updates.push(
          updateDoc(doc(db, 'targets', ot.id), {
            userName: cleanNameUpper,
            updatedAt: new Date().toISOString(),
          }).catch((e) => console.warn(`Sync failed for target ${ot.id}:`, e))
        );
      }
    });
    if (updates.length > 0) {
      await Promise.all(updates);
    }
  } catch (err) {
    console.error('Error syncing officer in targets:', err);
  }
}
