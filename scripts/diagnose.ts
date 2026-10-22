import { initializeApp } from 'firebase/app';
import { getFirestore, collection, getDocs } from 'firebase/firestore';
import firebaseConfig from '../firebase-applet-config.json';

const app = initializeApp(firebaseConfig);
const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);

async function run() {
  console.log('--- DIAGNOSTIC START ---');
  console.log('Database ID:', firebaseConfig.firestoreDatabaseId);

  // 1. Users
  const userSnap = await getDocs(collection(db, 'users'));
  console.log('Total users in Firestore:', userSnap.size);
  userSnap.forEach(d => {
    const data = d.data();
    console.log(`User [${d.id}]: fullName="${data.fullName}", loginId="${data.loginId}", userCode="${data.userCode}", role="${data.role}", designation="${data.designation}"`);
  });

  // 2. Dealers
  const dealerSnap = await getDocs(collection(db, 'dealers_application'));
  console.log('Total dealers_application in Firestore:', dealerSnap.size);
  dealerSnap.forEach(d => {
    const data = d.data();
    const photoLen = data.dealershipAddressPhoto ? data.dealershipAddressPhoto.length : 0;
    console.log(`Dealer [${d.id}]: code="${data.dealerCode}", firm="${data.firmName}", creatorId="${data.created_by_user_id || data.userId}", creatorName="${data.created_by_name || data.officerName}", photoBytes=${photoLen}`);
  });

  // 3. Orders
  const orderSnap = await getDocs(collection(db, 'orders'));
  console.log('Total orders in Firestore:', orderSnap.size);

  console.log('--- DIAGNOSTIC END ---');
  process.exit(0);
}

run().catch(err => {
  console.error('Diagnostic error:', err);
  process.exit(1);
});
