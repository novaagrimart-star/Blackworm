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
