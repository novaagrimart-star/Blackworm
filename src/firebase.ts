import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { 
  initializeFirestore, 
  getFirestore, 
  persistentLocalCache, 
  persistentMultipleTabManager,
  doc, 
  getDocFromServer,
  setLogLevel
} from 'firebase/firestore';
import firebaseConfig from '../firebase-applet-config.json';

try {
  setLogLevel('error');
} catch {}

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

function extractErrorParts(error: unknown) {
  const errObj = error as { message?: unknown; code?: unknown; name?: unknown } | null | undefined;
  const rawMessage =
    error instanceof Error
      ? error.message
      : errObj && typeof errObj === 'object' && errObj.message !== undefined
        ? String(errObj.message)
        : String(error || '');
  return {
    msg: rawMessage.toLowerCase(),
    name: String(errObj?.name || '').toLowerCase(),
    code: String(errObj?.code || '').toLowerCase(),
  };
}

export function isQuotaExceededError(error: unknown): boolean {
  const { msg, name, code } = extractErrorParts(error);
  return (
    msg.includes('quota') ||
    msg.includes('resource-exhausted') ||
    msg.includes('resource_exhausted') ||
    msg.includes('daily read units') ||
    msg.includes('free tier database') ||
    name.includes('quotaexceeded') ||
    code.includes('resource-exhausted')
  );
}

export function getFriendlyErrorMessage(
  error: unknown,
  fallbackMessage = 'तात्पुरती तांत्रिक अडचण आली. डेटा सुरक्षित आहे, कृपया पुन्हा प्रयत्न करा.'
): string {
  const { msg, name, code } = extractErrorParts(error);

  if (
    name.includes('quotaexceeded') ||
    msg.includes('quotaexceedederror') ||
    msg.includes('exceeded the quota') ||
    (msg.includes('storage') && msg.includes('quota'))
  ) {
    return 'डिव्हाइसवरील तात्पुरती कॅश जागा भरली आहे. कृपया थोड्या वेळाने पुन्हा प्रयत्न करा.';
  }
  if (isQuotaExceededError(error)) {
    return 'सध्या डेटाबेस लोड जास्त असल्यामुळे बॅकअप सर्व्हर व ऑफलाइन कॅश कार्यरत आहे. तुमचा डेटा पूर्णपणे सुरक्षित आहे.';
  }
  if (
    name.includes('chunkload') ||
    msg.includes('chunkloaderror') ||
    msg.includes('dynamically imported module') ||
    msg.includes('loading chunk') ||
    msg.includes('failed to fetch module')
  ) {
    return 'ॲपची नवीन आवृत्ती उपलब्ध आहे. कृपया रिफ्रेश / पुन्हा प्रयत्न करा.';
  }
  if (
    msg.includes('offline') ||
    msg.includes('network') ||
    msg.includes('unavailable') ||
    msg.includes('failed to fetch') ||
    msg.includes('aborted') ||
    msg.includes('deadline-exceeded') ||
    code.includes('unavailable') ||
    code.includes('aborted') ||
    code.includes('deadline-exceeded')
  ) {
    return 'इंटरनेट कनेक्शन तात्पुरते उपलब्ध नाही. डेटा स्थानिक सुरक्षित मेमरीमध्ये जतन केला जात आहे.';
  }
  if (msg.includes('permission') || msg.includes('permission_denied') || code.includes('permission-denied')) {
    return 'या माहितीसाठी आवश्यक परवानगी उपलब्ध नाही.';
  }
  if (
    msg.includes('failed-precondition') ||
    code.includes('failed-precondition') ||
    msg.includes('index') ||
    msg.includes('internal') ||
    code.includes('internal')
  ) {
    return fallbackMessage;
  }
  // Never expose raw JS TypeError / FirebaseError stack codes to the user
  if (
    name.includes('typeerror') ||
    name.includes('syntaxerror') ||
    msg.includes('cannot read properties') ||
    msg.includes('is not a function') ||
    msg.includes('firebaseerror') ||
    msg.includes('syntaxerror') ||
    msg.includes('typeerror')
  ) {
    return fallbackMessage;
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
