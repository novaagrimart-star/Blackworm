import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { 
  initializeFirestore, 
  getFirestore, 
  persistentLocalCache, 
  persistentMultipleTabManager,
  doc, 
  getDocFromServer 
} from 'firebase/firestore';
import firebaseConfig from '../firebase-applet-config.json';

const app = initializeApp(firebaseConfig);

let firestoreDb;
try {
  // Robust persistence with multi-tab support for seamless data sync across devices
  firestoreDb = initializeFirestore(app, {
    localCache: persistentLocalCache({
      tabManager: persistentMultipleTabManager()
    })
  }, firebaseConfig.firestoreDatabaseId);
} catch (e) {
  console.warn('Firestore persistence init failed, falling back to basic init:', e);
  firestoreDb = getFirestore(app, firebaseConfig.firestoreDatabaseId);
}

export const db = firestoreDb;
export const auth = getAuth(app);

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function isQuotaExceededError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return (
    msg.toLowerCase().includes('quota') ||
    msg.toLowerCase().includes('resource-exhausted') ||
    msg.toLowerCase().includes('daily read units') ||
    msg.toLowerCase().includes('free tier database')
  );
}

export function getFriendlyErrorMessage(error: unknown, fallbackMessage = 'डेटा सध्या उपलब्ध नाही. कृपया काही वेळाने पुन्हा प्रयत्न करा.'): string {
  if (isQuotaExceededError(error)) {
    return 'डेटा सध्या उपलब्ध नाही. कृपया काही वेळाने पुन्हा प्रयत्न करा.';
  }
  const msg = error instanceof Error ? error.message : String(error);
  if (msg.includes('offline') || msg.includes('network') || msg.includes('unavailable')) {
    return 'इंटरनेट कनेक्शन उपलब्ध नाही. ऑफलाइन कॅश डेटा दर्शवला जात आहे.';
  }
  if (msg.includes('permission') || msg.includes('PERMISSION_DENIED')) {
    return 'या माहितीसाठी आवश्यक परवानगी उपलब्ध नाही.';
  }
  return fallbackMessage;
}

export function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const rawMsg = error instanceof Error ? error.message : String(error);
  const isQuota = isQuotaExceededError(error);

  const errInfo: FirestoreErrorInfo = {
    error: rawMsg,
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo: auth.currentUser?.providerData?.map(provider => ({
        providerId: provider.providerId,
        email: provider.email,
      })) || []
    },
    operationType,
    path
  };

  // Safe developer-only console warning without exposing raw stack to UI
  if (isQuota) {
    console.warn('Firestore notice: daily free quota threshold active. Offline cache is serving data.');
  } else {
    console.warn('Firestore notice [safe]:', rawMsg);
  }

  return {
    ...errInfo,
    userMessage: getFriendlyErrorMessage(error),
    isQuota
  };
}

export async function testFirestoreConnection(): Promise<boolean> {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
    return true;
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.warn('Firebase client is offline, using cached persistence.');
    }
    return false;
  }
}
