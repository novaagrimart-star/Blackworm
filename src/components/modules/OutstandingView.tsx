import React, { useState, useEffect, useMemo, useRef } from 'react';
import { 
  collection, 
  query, 
  onSnapshot, 
  limit,
  doc,
  setDoc,
  deleteDoc,
  writeBatch
} from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../../firebase';
import { UserProfile, isAdmin, isUserRecord } from '../../lib/auth';
import { Language } from '../../lib/i18n';
import { cn, toTitleCase } from '../../lib/utils';
import { useBranding } from '../../lib/branding';
import { 
  parseOutstandingPdf, 
  ExtractedRecord, 
  MatchedOutstandingItem, 
  getFirmNameMatchScore, 
  buildWhatsAppLink, 
  cleanPhoneNumber,
  mergeAndDeduplicateRecords,
  normalizeFirmName
} from '../../lib/pdfOutstandingParser';
import { DealershipFormItem } from './DealerView';
import { 
  FileUp, 
  FileText, 
  Search, 
  Phone, 
  AlertCircle, 
  Download, 
  Sparkles, 
  Printer, 
  CheckCircle2, 
  MessageSquare, 
  Plus, 
  X, 
  Mail, 
  Send,
  Building2,
  RefreshCw,
  ExternalLink,
  Copy,
  Files,
  Trash2,
  FileCheck
} from 'lucide-react';

export interface UploadedPdfFile {
  id: string;
  name: string;
  size: number;
  recordCount: number;
  uploadedAt: string;
}

interface Props {
  profile: UserProfile;
  lang: Language;
}

export const OutstandingView: React.FC<Props> = ({ profile }) => {
  const isUserAdmin = isAdmin(profile);
  const { logoUrl } = useBranding();

  // Raw dealers from dealers_application
  const [dealers, setDealers] = useState<DealershipFormItem[]>([]);
  const [loadingDealers, setLoadingDealers] = useState(true);

  // Multi-PDF Parsing & File state (Persisted in Firestore & LocalStorage)
  const [isParsing, setIsParsing] = useState(false);
  const [uploadedFiles, setUploadedFiles] = useState<UploadedPdfFile[]>([]);
  const [duplicatesPreventedCount, setDuplicatesPreventedCount] = useState<number>(0);
  const [rawRecords, setRawRecords] = useState<ExtractedRecord[]>(() => {
    try {
      const saved = localStorage.getItem('blackworm_saved_outstanding_records');
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });
  const [parseError, setParseError] = useState<string>('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const printableSheetRef = useRef<HTMLDivElement>(null);

  // Manual Add Dealer Modal state
  const [showAddDealerModal, setShowAddDealerModal] = useState(false);
  const [newFirmName, setNewFirmName] = useState('');
  const [newVillage, setNewVillage] = useState('');
  const [newContact, setNewContact] = useState('');
  const [newAmount, setNewAmount] = useState('');
  const [newProprietor, setNewProprietor] = useState('');
  const [isSavingDealer, setIsSavingDealer] = useState(false);

  // Officer filter for Admin
  const [selectedOfficer, setSelectedOfficer] = useState<string>('all');

  // Search & Sorting in table
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [sortBy, setSortBy] = useState<'amount-desc' | 'amount-asc' | 'name-asc'>('amount-desc');

  // Manual phone number overrides for PDF records without matched mobile
  const [phoneOverrides, setPhoneOverrides] = useState<Record<string, string>>(() => {
    try {
      const saved = sessionStorage.getItem('blackworm_outstanding_phones');
      return saved ? JSON.parse(saved) : {};
    } catch {
      return {};
    }
  });

  // Active inline phone editing record ID
  const [editingPhoneId, setEditingPhoneId] = useState<string | null>(null);
  const [tempPhoneInput, setTempPhoneInput] = useState<string>('');

  // WhatsApp sent tracking (persisted in session)
  const [sentMap, setSentMap] = useState<Record<string, string>>(() => {
    try {
      const saved = sessionStorage.getItem('blackworm_outstanding_sent');
      return saved ? JSON.parse(saved) : {};
    } catch {
      return {};
    }
  });

  // Modal for entering phone if missing when clicking amount
  const [missingPhoneModalItem, setMissingPhoneModalItem] = useState<MatchedOutstandingItem | null>(null);
  const [manualPhoneInput, setManualPhoneInput] = useState<string>('');

  // Toast notification
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'info' } | null>(null);

  const showToast = (message: string, type: 'success' | 'info' = 'success') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3500);
  };

  // Seed default outstanding records (including user's exact example: Ganesh Krushi Seva Kendra Manerajuri 9897594653)
  const seedDefaultOutstandingRecords = async () => {
    try {
      const defaultData: ExtractedRecord[] = [
        {
          id: 'rec_ganesh_manerajuri',
          rawFirmName: 'Ganesh Krushi Seva Kendra',
          cleanedFirmName: 'Ganesh Krushi Seva Kendra',
          amount: 84500,
          formattedAmount: '84,500',
          page: 1,
          rawLine: 'Ganesh Krushi Seva Kendra Manerajuri 84,500 Dr',
          contactNumber: '9897594653',
          village: 'Manerajuri',
          district: 'Sangli',
          proprietorName: 'Ganesh Patil',
          sourceFile: 'Standing Statement',
        },
        {
          id: 'rec_kisan_sangli',
          rawFirmName: 'Kisan Krushi Seva Kendra',
          cleanedFirmName: 'Kisan Krushi Seva Kendra',
          amount: 145200,
          formattedAmount: '1,45,200',
          page: 1,
          rawLine: 'Kisan Krushi Seva Kendra Sangli 1,45,200 Dr',
          contactNumber: '9822456789',
          village: 'Sangli',
          district: 'Sangli',
          proprietorName: 'Sachin Patil',
          sourceFile: 'Standing Statement',
        },
        {
          id: 'rec_balaji_miraj',
          rawFirmName: 'Balaji Fertilisers & Seeds',
          cleanedFirmName: 'Balaji Fertilisers & Seeds',
          amount: 210800,
          formattedAmount: '2,10,800',
          page: 1,
          rawLine: 'Balaji Fertilisers & Seeds Miraj 2,10,800 Dr',
          contactNumber: '9423871234',
          village: 'Miraj',
          district: 'Sangli',
          proprietorName: 'Balaji Shinde',
          sourceFile: 'Standing Statement',
        },
        {
          id: 'rec_mahalaxmi_jat',
          rawFirmName: 'Mahalaxmi Krishi Vikas',
          cleanedFirmName: 'Mahalaxmi Krishi Vikas',
          amount: 63500,
          formattedAmount: '63,500',
          page: 1,
          rawLine: 'Mahalaxmi Krishi Vikas Jat 63,500 Dr',
          contactNumber: '9860123456',
          village: 'Jat',
          district: 'Sangli',
          proprietorName: 'Ramesh Sawant',
          sourceFile: 'Standing Statement',
        },
        {
          id: 'rec_shivaji_tasgaon',
          rawFirmName: 'Shivaji Agro Services',
          cleanedFirmName: 'Shivaji Agro Services',
          amount: 115000,
          formattedAmount: '1,15,000',
          page: 1,
          rawLine: 'Shivaji Agro Services Tasgaon 1,15,000 Dr',
          contactNumber: '9765432109',
          village: 'Tasgaon',
          district: 'Sangli',
          proprietorName: 'Shivaji Yadav',
          sourceFile: 'Standing Statement',
        }
      ];

      const batch = writeBatch(db);
      defaultData.forEach((item) => {
        const docRef = doc(db, 'outstanding_records', item.id);
        batch.set(docRef, {
          ...item,
          updatedAt: new Date().toISOString(),
          updatedBy: profile.fullName || 'System'
        });
      });
      await batch.commit();

      setRawRecords(defaultData);
      try {
        localStorage.setItem('blackworm_saved_outstanding_records', JSON.stringify(defaultData));
      } catch {}
    } catch (e) {
      console.warn('Failed to seed default outstanding records:', e);
    }
  };

  // Real-time synchronization of persistent outstanding records from Firestore
  useEffect(() => {
    const qOut = query(
      collection(db, 'outstanding_records'),
      limit(1000)
    );

    const unsubOut = onSnapshot(
      qOut,
      { includeMetadataChanges: true },
      (snap) => {
        if (!snap.empty) {
          const list: ExtractedRecord[] = [];
          snap.forEach((d) => {
            const data = d.data() as ExtractedRecord;
            list.push({ ...data, id: d.id });
          });
          setRawRecords(list);
          try {
            localStorage.setItem('blackworm_saved_outstanding_records', JSON.stringify(list));
          } catch {}
        } else {
          // If Firestore is empty, seed initial records including user's exact example
          seedDefaultOutstandingRecords();
        }
      },
      (error) => {
        handleFirestoreError(error, OperationType.LIST, 'outstanding_records');
      }
    );

    return () => unsubOut();
  }, []);

  // Real-time synchronization of dealer applications from Firestore
  useEffect(() => {
    setLoadingDealers(true);
    const q = query(
      collection(db, 'dealers_application'),
      limit(1000)
    );

    const unsub = onSnapshot(
      q,
      { includeMetadataChanges: true },
      (snap) => {
        const list: DealershipFormItem[] = [];
        snap.forEach((d) => {
          const data = d.data() as DealershipFormItem;
          list.push({ ...data, id: d.id });
        });
        setDealers(list);
        setLoadingDealers(false);
      },
      (error) => {
        handleFirestoreError(error, OperationType.LIST, 'dealers_application');
        setLoadingDealers(false);
      }
    );

    return () => unsub();
  }, []);

  // Filter dealers accessible to current user / selected officer
  const accessibleDealers = useMemo(() => {
    if (isUserAdmin) {
      if (selectedOfficer === 'all') return dealers;
      return dealers.filter(d => {
        const officer = (d.officerName || d.created_by_name || '').toLowerCase();
        return officer.includes(selectedOfficer.toLowerCase()) || 
               d.created_by_user_id === selectedOfficer;
      });
    } else {
      // Non-admin Officer: Strictly ONLY dealers submitted by this logged-in officer
      return dealers.filter(d => isUserRecord(d, profile));
    }
  }, [dealers, isUserAdmin, selectedOfficer, profile]);

  // List of distinct officers for Admin dropdown
  const distinctOfficers = useMemo(() => {
    const map = new Map<string, string>();
    dealers.forEach(d => {
      const name = (d.officerName || d.created_by_name || '').trim();
      const id = d.created_by_user_id || name;
      if (name && !map.has(name)) {
        map.set(name, id);
      }
    });
    return Array.from(map.entries()).map(([name, id]) => ({ name, id }));
  }, [dealers]);

  // Handle Multi-PDF file upload and deduplication
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = e.target.files ? Array.from(e.target.files) : [];
    if (fileList.length === 0) return;

    // Filter valid PDFs
    const validPdfFiles = fileList.filter(f => 
      f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf')
    );

    if (validPdfFiles.length === 0) {
      setParseError('कृपया वैध PDF डॉक्युमेंट (.pdf) फाईल्स निवडा.');
      return;
    }

    try {
      setIsParsing(true);
      setParseError('');

      let currentRecords = [...rawRecords];
      let totalNewAdded = 0;
      let totalDuplicatesMerged = 0;
      const newlyProcessedFiles: UploadedPdfFile[] = [];

      for (const file of validPdfFiles) {
        const buffer = await file.arrayBuffer();
        const extracted = await parseOutstandingPdf(buffer, file.name);

        if (extracted.length > 0) {
          const { merged, addedCount, duplicateCount } = mergeAndDeduplicateRecords(
            currentRecords,
            extracted,
            file.name
          );

          currentRecords = merged;
          totalNewAdded += addedCount;
          totalDuplicatesMerged += duplicateCount;

          newlyProcessedFiles.push({
            id: `${file.name}_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
            name: file.name,
            size: file.size,
            recordCount: extracted.length,
            uploadedAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          });
        }
      }

      if (newlyProcessedFiles.length === 0) {
        setParseError('निवडलेल्या PDF फाईल्समधून कोणताही डेटा काढता आला नाही. कृपया टेक्स्ट-बेस्ड आउटस्टँडिंग PDF असल्याची खात्री करा.');
      } else {
        setRawRecords(currentRecords);
        setUploadedFiles(prev => {
          const existingNames = new Set(prev.map(f => f.name));
          const filteredNew = newlyProcessedFiles.filter(f => !existingNames.has(f.name));
          return [...prev, ...filteredNew];
        });
        setDuplicatesPreventedCount(prev => prev + totalDuplicatesMerged);

        // Persist all extracted records to Firestore permanently so they are never lost on reload
        try {
          const batch = writeBatch(db);
          currentRecords.forEach((rec) => {
            const docRef = doc(db, 'outstanding_records', rec.id);
            batch.set(docRef, {
              ...rec,
              updatedAt: new Date().toISOString(),
              updatedBy: profile.fullName || 'User'
            }, { merge: true });
          });
          await batch.commit();
        } catch (dbErr) {
          console.warn('Failed to persist to Firestore:', dbErr);
        }

        try {
          localStorage.setItem('blackworm_saved_outstanding_records', JSON.stringify(currentRecords));
        } catch {}

        if (totalDuplicatesMerged > 0) {
          showToast(`${newlyProcessedFiles.length} PDF जोडल्या! एकूण ${currentRecords.length} डीलर्स (ज्यात ${totalDuplicatesMerged} डुप्लिकेट्स आपोआप एकत्र केले).`);
        } else {
          showToast(`${newlyProcessedFiles.length} PDF फाईल(्स) मधून एकूण ${currentRecords.length} डीलर्स लोड झाले.`);
        }
      }
    } catch (err: any) {
      console.error('PDF parsing error:', err);
      setParseError('PDF वाचताना त्रुटी आली: ' + (err.message || 'Unknown error.'));
    } finally {
      setIsParsing(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  // Add new dealer outstanding record manually (e.g. Ganesh Krushi Seva Kendra Manerajuri 9897594653)
  const handleSaveNewDealer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newFirmName.trim()) {
      alert('कृपया डीलर / फर्मचे नाव टाका.');
      return;
    }
    const cleanAmount = parseFloat(newAmount.replace(/,/g, ''));
    if (isNaN(cleanAmount) || cleanAmount <= 0) {
      alert('कृपया वैध थकीत येणेबाकी रक्कम टाका.');
      return;
    }

    setIsSavingDealer(true);
    try {
      const cleanPhone = cleanPhoneNumber(newContact);
      const newId = `rec_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
      const newRec: ExtractedRecord = {
        id: newId,
        rawFirmName: newFirmName.trim(),
        cleanedFirmName: newFirmName.trim(),
        amount: Math.round(cleanAmount),
        formattedAmount: Math.round(cleanAmount).toLocaleString('en-IN'),
        page: 1,
        rawLine: `${newFirmName} ${newVillage} ${cleanAmount} Dr`,
        contactNumber: cleanPhone,
        village: newVillage.trim(),
        proprietorName: newProprietor.trim(),
        sourceFile: 'Manual Entry',
      };

      // Save to Firestore permanently so it's always there for everyone
      await setDoc(doc(db, 'outstanding_records', newId), {
        ...newRec,
        updatedAt: new Date().toISOString(),
        updatedBy: profile.fullName || 'User'
      });

      const updated = [newRec, ...rawRecords];
      setRawRecords(updated);
      try {
        localStorage.setItem('blackworm_saved_outstanding_records', JSON.stringify(updated));
      } catch {}

      showToast(`'${newFirmName}' ची थकीत रक्कम ₹${newRec.formattedAmount} सेव्ह झाली!`);
      setShowAddDealerModal(false);
      setNewFirmName('');
      setNewVillage('');
      setNewContact('');
      setNewAmount('');
      setNewProprietor('');
    } catch (err: any) {
      console.error('Failed to save manual dealer:', err);
      alert('डीलर सेव्ह करताना त्रुटी आली: ' + (err.message || 'Unknown error'));
    } finally {
      setIsSavingDealer(false);
    }
  };

  // Delete a dealer outstanding record from Firestore
  const handleDeleteRecord = async (recordId: string, firmName: string) => {
    if (!confirm(`तुम्हाला खरोखर '${firmName}' ची थकीत नोंद काढून टाकायची आहे का?`)) return;
    try {
      await deleteDoc(doc(db, 'outstanding_records', recordId));
      setRawRecords(prev => prev.filter(r => r.id !== recordId));
      showToast(`'${firmName}' ची नोंद काढली.`);
    } catch (err) {
      console.error('Failed to delete record:', err);
    }
  };

  // Remove a specific PDF file and its records
  const handleRemoveFile = (fileNameToRemove: string) => {
    setUploadedFiles(prev => prev.filter(f => f.name !== fileNameToRemove));

    setRawRecords(prev => {
      const remaining = prev.filter(record => {
        const sources = (record.sourceFile || '').split(', ').map(s => s.trim()).filter(Boolean);
        // If this record only came from this file, remove it
        if (sources.length <= 1 && (sources[0] === fileNameToRemove || !record.sourceFile)) {
          return false;
        }
        // If it came from multiple files, keep it but remove this source
        if (sources.includes(fileNameToRemove)) {
          record.sourceFile = sources.filter(s => s !== fileNameToRemove).join(', ');
        }
        return true;
      });
      try {
        localStorage.setItem('blackworm_saved_outstanding_records', JSON.stringify(remaining));
      } catch {}
      return remaining;
    });

    showToast(`"${fileNameToRemove}" फाईल आणि तिचा डेटा शीटमधून काढला.`);
  };

  // Load Sample / Demo Statement for instant testing
  const handleLoadDemoData = () => {
    setParseError('');
    const demoFileName = 'Dealer_Standing_Amount_Statement.pdf';
    
    const demoItems: ExtractedRecord[] = [];
    const sampleAmounts = [145200, 84500, 42000, 210800, 63500, 115000, 92000, 178000];

    const targetDealers = accessibleDealers.length > 0 ? accessibleDealers : dealers;
    if (targetDealers.length > 0) {
      const sample = targetDealers.slice(0, 8);
      sample.forEach((d, idx) => {
        const val = sampleAmounts[idx % sampleAmounts.length];
        demoItems.push({
          id: `demo_${d.id}`,
          rawFirmName: d.firmName,
          cleanedFirmName: d.firmName,
          amount: val,
          formattedAmount: val.toLocaleString('en-IN'),
          page: 1,
          rawLine: `${idx + 1} ${d.firmName} ${val.toLocaleString('en-IN')} Dr`,
          contactNumber: d.contactNumber || d.responsibleContact || '',
          village: d.village || '',
          district: d.district || '',
          proprietorName: d.proprietorName || '',
          sourceFile: demoFileName,
        });
      });
    }

    if (demoItems.length < 4) {
      const fallbackData = [
        { name: 'Ganesh Krushi Seva Kendra', village: 'Manerajuri', contact: '9897594653', amount: 84500 },
        { name: 'Kisan Krushi Seva Kendra', village: 'Sangli', contact: '9822456789', amount: 145200 },
        { name: 'Balaji Fertilisers & Seeds', village: 'Miraj', contact: '9423871234', amount: 210800 },
        { name: 'Mahalaxmi Krishi Vikas', village: 'Jat', contact: '9860123456', amount: 63500 },
        { name: 'Shivaji Agro Services', village: 'Tasgaon', contact: '9765432109', amount: 115000 }
      ];
      fallbackData.forEach((item, idx) => {
        demoItems.push({
          id: `demo_fallback_${idx}`,
          rawFirmName: item.name,
          cleanedFirmName: item.name,
          amount: item.amount,
          formattedAmount: item.amount.toLocaleString('en-IN'),
          page: 1,
          rawLine: `${idx + 1} ${item.name} ${item.amount.toLocaleString('en-IN')} Dr`,
          contactNumber: item.contact,
          village: item.village,
          sourceFile: demoFileName,
        });
      });
    }

    const { merged, duplicateCount } = mergeAndDeduplicateRecords(rawRecords, demoItems, demoFileName);
    setRawRecords(merged);
    try {
      localStorage.setItem('blackworm_saved_outstanding_records', JSON.stringify(merged));
    } catch {}

    setUploadedFiles(prev => {
      if (prev.some(f => f.name === demoFileName)) return prev;
      return [...prev, {
        id: `demo_${Date.now()}`,
        name: demoFileName,
        size: 45000,
        recordCount: demoItems.length,
        uploadedAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      }];
    });
    setDuplicatesPreventedCount(prev => prev + duplicateCount);
    showToast('डेमो आउटस्टँडिंग शीट यशस्वीरीत्या लोड झाली!');
  };

  const handleClearData = async () => {
    if (!confirm('तुम्हाला खरोखर सर्व थकीत येणेबाकी डेटा साफ करायचा आहे का?')) return;
    try {
      const batch = writeBatch(db);
      rawRecords.forEach((r) => {
        batch.delete(doc(db, 'outstanding_records', r.id));
      });
      await batch.commit();
    } catch (e) {}

    setRawRecords([]);
    setUploadedFiles([]);
    setDuplicatesPreventedCount(0);
    setParseError('');
    try {
      localStorage.removeItem('blackworm_saved_outstanding_records');
    } catch {}
    showToast('सर्व डेटा साफ केला.');
  };

  // Cross-reference extracted PDF records with dealers in dealers_application
  // and apply strict deduplication so identical firms/dealers NEVER appear twice!
  const processedRecords = useMemo<MatchedOutstandingItem[]>(() => {
    if (rawRecords.length === 0) return [];

    const matchedList: MatchedOutstandingItem[] = [];

    rawRecords.forEach((rec) => {
      // Best fuzzy match against registered dealers
      let bestMatch: DealershipFormItem | null = null;
      let highestScore = 0;

      for (const d of accessibleDealers) {
        const score = getFirmNameMatchScore(rec.cleanedFirmName, d.firmName);
        if (score > highestScore) {
          highestScore = score;
          bestMatch = d;
        }
      }

      // Check if user manually saved an override phone for this record
      const overridePhone = phoneOverrides[rec.id];

      if (bestMatch && highestScore >= 55) {
        matchedList.push({
          ...rec,
          matchedDealerId: bestMatch.id,
          dealerCode: bestMatch.dealerCode,
          proprietorName: bestMatch.proprietorName || rec.proprietorName,
          contactNumber: overridePhone || rec.contactNumber || bestMatch.contactNumber || bestMatch.responsibleContact || '',
          village: bestMatch.village || rec.village,
          district: bestMatch.district || rec.district,
          officerName: bestMatch.officerName || bestMatch.created_by_name,
          officerId: bestMatch.created_by_user_id,
          matchScore: highestScore,
          status: 'matched',
          whatsappSentAt: sentMap[rec.id],
        });
      } else {
        matchedList.push({
          ...rec,
          contactNumber: overridePhone || rec.contactNumber || '',
          village: rec.village || '',
          district: rec.district || '',
          proprietorName: rec.proprietorName || '',
          matchScore: highestScore,
          status: 'unmatched',
          whatsappSentAt: sentMap[rec.id],
        });
      }
    });

    // STRICT DEDUPLICATION:
    // Guarantee that NO firm appears twice in the sheet:
    // If multiple records match the same registered dealer in Firestore, OR share the exact same normalized firm name,
    // consolidate them into a single row with the latest/higher outstanding balance!
    const deduplicatedMap = new Map<string, MatchedOutstandingItem>();

    matchedList.forEach((item) => {
      const dedupKey = item.matchedDealerId
        ? `dealer_${item.matchedDealerId}`
        : `firm_${normalizeFirmName(item.cleanedFirmName) || item.cleanedFirmName.toLowerCase()}`;

      if (!deduplicatedMap.has(dedupKey)) {
        deduplicatedMap.set(dedupKey, item);
      } else {
        // DUPLICATE DETECTED: Merge without adding another row!
        const existing = deduplicatedMap.get(dedupKey)!;
        const higherAmount = Math.max(existing.amount, item.amount);

        const existingSources = (existing.sourceFile || '').split(', ').map(s => s.trim()).filter(Boolean);
        const itemSources = (item.sourceFile || '').split(', ').map(s => s.trim()).filter(Boolean);
        const mergedSources = Array.from(new Set([...existingSources, ...itemSources]));

        deduplicatedMap.set(dedupKey, {
          ...existing,
          amount: higherAmount,
          formattedAmount: higherAmount.toLocaleString('en-IN'),
          contactNumber: existing.contactNumber || item.contactNumber || '',
          proprietorName: existing.proprietorName || item.proprietorName,
          village: existing.village || item.village,
          district: existing.district || item.district,
          sourceFile: mergedSources.join(', ') || existing.sourceFile,
        });
      }
    });

    return Array.from(deduplicatedMap.values());
  }, [rawRecords, accessibleDealers, phoneOverrides, sentMap]);

  // Filter according to search and officer permissions
  const filteredRecords = useMemo(() => {
    let list = processedRecords;

    // Search query
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      list = list.filter(item => 
        (item.cleanedFirmName || '').toLowerCase().includes(q) ||
        (item.dealerCode || '').toLowerCase().includes(q) ||
        (item.proprietorName || '').toLowerCase().includes(q) ||
        (item.contactNumber || '').toLowerCase().includes(q) ||
        (item.village || '').toLowerCase().includes(q) ||
        (item.district || '').toLowerCase().includes(q) ||
        (item.formattedAmount || '').includes(q)
      );
    }

    // Sorting
    list = [...list].sort((a, b) => {
      if (sortBy === 'amount-desc') return b.amount - a.amount;
      if (sortBy === 'amount-asc') return a.amount - b.amount;
      if (sortBy === 'name-asc') return (a.cleanedFirmName || '').localeCompare(b.cleanedFirmName || '');
      return 0;
    });

    return list;
  }, [processedRecords, searchQuery, sortBy]);

  // Total Standing Amount
  const totalStanding = useMemo(() => {
    return filteredRecords.reduce((acc, curr) => acc + curr.amount, 0);
  }, [filteredRecords]);

  // Record WhatsApp Sent action
  const markAsSent = (recordId: string) => {
    const now = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const updated = { ...sentMap, [recordId]: now };
    setSentMap(updated);
    try {
      sessionStorage.setItem('blackworm_outstanding_sent', JSON.stringify(updated));
    } catch {}
  };

  // Save phone number override
  const savePhoneOverride = (recordId: string, phone: string) => {
    const clean10 = cleanPhoneNumber(phone);
    if (!clean10 || clean10.length !== 10) {
      alert('कृपया वैध १० अंकी मोबाईल नंबर टाका.');
      return false;
    }
    const updated = { ...phoneOverrides, [recordId]: clean10 };
    setPhoneOverrides(updated);
    try {
      sessionStorage.setItem('blackworm_outstanding_phones', JSON.stringify(updated));
    } catch {}
    setEditingPhoneId(null);
    setTempPhoneInput('');
    showToast(`मोबाईल नंबर +91 ${clean10} सेव्ह केला!`);
    return clean10;
  };

  /**
   * CRITICAL USER REQUIREMENT:
   * "त्या औषधाने [आउटस्टँडिंग] अमाऊंटला क्लिक केल्यानंतर डायरेक्ट ओउटस्टँडिंग अमाऊंट त्याची मेसेज व्हाट्सअप ला पाठवलं जाईल"
   * Directly triggers WhatsApp with pre-filled bank statement and dynamic outstanding amount!
   */
  const handleAmountClickToSendWhatsApp = (item: MatchedOutstandingItem) => {
    const firm = item.cleanedFirmName || item.rawFirmName;
    const phone = item.contactNumber || phoneOverrides[item.id] || '';
    const clean10 = cleanPhoneNumber(phone);

    // If phone number is not available, open the quick prompt modal to enter phone and send immediately
    if (!clean10 || clean10.length !== 10) {
      setMissingPhoneModalItem(item);
      setManualPhoneInput('');
      return;
    }

    // Build WhatsApp message with Rajarambapu Sahakari Bank details & outstanding amount
    const { url } = buildWhatsAppLink(clean10, firm, item.formattedAmount);
    
    // Mark as sent
    markAsSent(item.id);

    // Directly open WhatsApp
    window.open(url, '_blank', 'noopener,noreferrer');
    showToast(`${firm} साठी WhatsApp मेसेज उघडला!`);
  };

  // Handle manual phone modal submit
  const handleModalPhoneSubmit = () => {
    if (!missingPhoneModalItem) return;
    const clean10 = savePhoneOverride(missingPhoneModalItem.id, manualPhoneInput);
    if (clean10) {
      const firm = missingPhoneModalItem.cleanedFirmName || missingPhoneModalItem.rawFirmName;
      const { url } = buildWhatsAppLink(clean10, firm, missingPhoneModalItem.formattedAmount);
      markAsSent(missingPhoneModalItem.id);
      window.open(url, '_blank', 'noopener,noreferrer');
      setMissingPhoneModalItem(null);
      setManualPhoneInput('');
    }
  };

  // Print Sheet
  const handlePrintSheet = () => {
    window.print();
  };

  // Export to CSV
  const handleExportCSV = () => {
    if (filteredRecords.length === 0) return;

    const headers = ['Sr', 'Dealer / Firm Name', 'Contact Number', 'Outstanding Amount (INR)'];
    const rows = filteredRecords.map((r, i) => {
      const phone = r.contactNumber || phoneOverrides[r.id] || '';
      return [
        i + 1,
        `"${r.cleanedFirmName.replace(/"/g, '""')}"`,
        `"${phone ? '+91 ' + phone : 'NA'}"`,
        r.amount
      ];
    });

    const csvContent = 'data:text/csv;charset=utf-8,' + [headers.join(','), ...rows.map(e => e.join(','))].join('\n');
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `Dealer_Standing_Amount_Statement_${new Date().toISOString().slice(0, 10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div className="space-y-4 max-w-5xl mx-auto pb-32">
      {/* Print Styles: Exact match with Collection Sheet format */}
      <style dangerouslySetInnerHTML={{ __html: `
        @media print {
          @page {
            size: A4 portrait;
            margin: 8mm;
          }
          body {
            background: white !important;
            padding: 0 !important;
            margin: 0 !important;
          }
          .no-print {
            display: none !important;
          }
          #dealer-standing-sheet {
            display: block !important;
            border: 2px solid #000 !important;
            padding: 0 !important;
            width: 100% !important;
          }
        }
      `}} />

      {/* Top Header Card (Controls & Actions) */}
      <div className="bg-white p-3.5 sm:p-4 rounded-2xl border border-slate-200 shadow-xs flex flex-wrap sm:flex-nowrap items-center justify-between gap-3 no-print">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-9 h-9 sm:w-10 sm:h-10 rounded-xl bg-red-50 text-red-600 flex items-center justify-center shrink-0 border border-red-200 shadow-2xs">
            <FileText className="w-5 h-5 stroke-[2.5]" />
          </div>
          <div className="min-w-0">
            <h2 className="text-base sm:text-lg font-black text-slate-900 tracking-tight">
              Outstanding (थकीत येणेबाकी)
            </h2>
            <p className="text-[11px] text-slate-500 font-medium">
              Dealer Standing Amount Statement & Direct WhatsApp
            </p>
          </div>
        </div>

        {/* Action Buttons: Upload Statement PDF(s), Demo Data, Print Sheet */}
        <div className="flex items-center gap-1.5 shrink-0 ml-auto flex-wrap">
          <input
            type="file"
            ref={fileInputRef}
            onChange={handleFileUpload}
            multiple
            accept=".pdf,application/pdf"
            className="hidden"
            id="outstanding-pdf-upload"
          />

          <label
            htmlFor="outstanding-pdf-upload"
            className="flex items-center gap-1.5 bg-red-600 hover:bg-red-700 active:scale-95 text-white font-bold text-xs px-3 py-1.5 rounded-lg shadow-2xs transition cursor-pointer whitespace-nowrap"
            title="Upload one or more Outstanding Statement PDFs"
          >
            <FileUp className="w-3.5 h-3.5" />
            <span>{isParsing ? 'वाचत आहे...' : '+ PDF जोडा'}</span>
          </label>

          <button
            type="button"
            onClick={() => setShowAddDealerModal(true)}
            className="flex items-center gap-1.5 bg-emerald-600 hover:bg-emerald-700 active:scale-95 text-white font-bold text-xs px-3 py-1.5 rounded-lg shadow-2xs transition cursor-pointer whitespace-nowrap"
            title="नवीन डीलर थकीत नोंद जोडा"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>+ डीलर जोडा</span>
          </button>

          <button
            type="button"
            onClick={handleLoadDemoData}
            className="flex items-center gap-1 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold text-xs px-2.5 py-1.5 rounded-lg border border-slate-200 shadow-2xs transition active:scale-95 cursor-pointer whitespace-nowrap"
            title="Load Sample Statement"
          >
            <Sparkles className="w-3.5 h-3.5 text-amber-500" />
            <span>डेमो डेटा</span>
          </button>

          {rawRecords.length > 0 && (
            <>
              <button
                type="button"
                onClick={handlePrintSheet}
                className="flex items-center gap-1 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold text-xs px-2.5 py-1.5 rounded-lg border border-slate-200 shadow-2xs transition active:scale-95 cursor-pointer whitespace-nowrap"
                title="Print Sheet"
              >
                <Printer className="w-3.5 h-3.5 text-slate-600" />
                <span className="hidden sm:inline">Print Sheet</span>
              </button>

              <button
                type="button"
                onClick={handleClearData}
                className="p-1.5 text-slate-400 hover:text-rose-600 rounded-lg hover:bg-slate-100 transition"
                title="Clear Data"
              >
                <RefreshCw className="w-3.5 h-3.5" />
              </button>
            </>
          )}
        </div>
      </div>

      {/* Toast Notification */}
      {toast && (
        <div className="p-3 bg-emerald-50 border border-emerald-200 text-emerald-900 text-xs rounded-xl flex items-center justify-between no-print animate-fade-in shadow-2xs font-semibold">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
            <span>{toast.message}</span>
          </div>
          <button onClick={() => setToast(null)} className="text-emerald-700 hover:text-emerald-900">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Parse Error Notification */}
      {parseError && (
        <div className="p-3 bg-rose-50 border border-rose-200 text-rose-800 text-xs rounded-xl flex items-center gap-2 no-print">
          <AlertCircle className="w-4 h-4 text-rose-600 shrink-0" />
          <span>{parseError}</span>
        </div>
      )}

      {/* Multi-PDF Files Management & Strict Deduplication Strip */}
      {uploadedFiles.length > 0 && (
        <div className="bg-white p-3 rounded-2xl border border-slate-200 shadow-2xs space-y-2.5 no-print">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="flex items-center justify-center w-6 h-6 rounded-lg bg-red-100 text-red-700">
                <Files className="w-3.5 h-3.5" />
              </span>
              <span className="text-xs font-black text-slate-900">
                जोडलेल्या PDF फाईल्स ({uploadedFiles.length}):
              </span>
              <span className="text-[11px] font-bold text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded-full border border-emerald-200 flex items-center gap-1">
                <FileCheck className="w-3 h-3 text-emerald-600" />
                <span>डुप्लिकेट-मुक्त शीट ({processedRecords.length} युनिक डीलर्स)</span>
              </span>
              {duplicatesPreventedCount > 0 && (
                <span className="text-[10px] font-bold text-amber-800 bg-amber-50 px-2 py-0.5 rounded-full border border-amber-200">
                  {duplicatesPreventedCount} डबल नोंदी आपोआप एकत्र केल्या
                </span>
              )}
            </div>

            <div className="flex items-center gap-2 ml-auto">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex items-center gap-1 text-[11px] font-bold text-red-600 hover:text-red-700 bg-red-50 hover:bg-red-100 px-2.5 py-1 rounded-lg border border-red-200 transition active:scale-95 cursor-pointer"
                title="आणखी एक PDF फाईल जोडा"
              >
                <Plus className="w-3 h-3" />
                <span>+ आणखी PDF जोडा</span>
              </button>

              <button
                type="button"
                onClick={handleClearData}
                className="inline-flex items-center gap-1 text-[11px] font-bold text-slate-500 hover:text-rose-600 bg-slate-50 hover:bg-rose-50 px-2 py-1 rounded-lg border border-slate-200 transition cursor-pointer"
                title="सर्व फाईल्स काढून टाका"
              >
                <Trash2 className="w-3 h-3" />
                <span>सर्व साफ करा</span>
              </button>
            </div>
          </div>

          {/* Individual PDF File Pills */}
          <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-slate-100">
            {uploadedFiles.map((file) => (
              <div 
                key={file.id} 
                className="inline-flex items-center gap-1.5 bg-slate-50 border border-slate-200 text-slate-800 rounded-lg px-2.5 py-1 text-xs font-semibold hover:border-slate-300 transition"
              >
                <FileText className="w-3.5 h-3.5 text-red-500 shrink-0" />
                <span className="truncate max-w-[180px] sm:max-w-[260px]" title={file.name}>
                  {file.name}
                </span>
                <span className="text-[10px] font-mono text-slate-500 bg-white px-1.5 py-0.2 rounded border border-slate-200">
                  {file.recordCount} नोंदी
                </span>
                <button
                  type="button"
                  onClick={() => handleRemoveFile(file.name)}
                  className="text-slate-400 hover:text-rose-600 p-0.5 rounded transition cursor-pointer"
                  title={`"${file.name}" काढून टाका`}
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Empty State / Upload Callout if No PDF is Loaded */}
      {rawRecords.length === 0 && !isParsing && (
        <div 
          onClick={() => fileInputRef.current?.click()}
          className="border-2 border-dashed border-red-300 hover:border-red-500 bg-red-50/30 hover:bg-red-50/50 transition p-8 sm:p-10 rounded-2xl text-center cursor-pointer space-y-3 no-print"
        >
          <div className="w-16 h-16 bg-white rounded-2xl shadow-sm border border-red-200 flex items-center justify-center mx-auto text-red-600">
            <FileUp className="w-8 h-8" />
          </div>
          <div>
            <h3 className="text-sm sm:text-base font-black text-slate-900">
              Dealer Standing Statement PDF(s) अपलोड करा
            </h3>
            <p className="text-xs text-slate-500 max-w-md mx-auto mt-1">
              तुम्ही एकाच वेळी किंवा एकामागून एक अनेक PDFs अपलोड करू शकता. सर्व PDF मधील डेटा एकत्र जोडला जाईल आणि कोणताही डेटा डबल (Duplicate) होणार नाही!
            </p>
          </div>
          <div className="pt-2 flex items-center justify-center gap-2 flex-wrap">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setShowAddDealerModal(true);
              }}
              className="inline-flex items-center gap-1.5 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs rounded-xl shadow-xs transition"
            >
              <Plus className="w-4 h-4" />
              + डीलर नोंद जोडा
            </button>
            <span className="inline-flex items-center gap-1.5 px-4 py-2 bg-red-600 hover:bg-red-700 text-white font-bold text-xs rounded-xl shadow-xs transition">
              <FileUp className="w-4 h-4" />
              किंवा PDF अपलोड करा
            </span>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                handleLoadDemoData();
              }}
              className="inline-flex items-center gap-1.5 px-3 py-2 bg-white border border-slate-300 hover:bg-slate-50 text-slate-700 font-bold text-xs rounded-xl shadow-2xs transition"
            >
              <Sparkles className="w-3.5 h-3.5 text-amber-500" />
              सॅम्पल डेटा पहा
            </button>
          </div>
        </div>
      )}

      {/* Parsing Spinner */}
      {isParsing && (
        <div className="bg-white border border-slate-200 rounded-2xl p-10 text-center space-y-3 shadow-xs no-print">
          <div className="w-10 h-10 border-4 border-red-600 border-t-transparent rounded-full animate-spin mx-auto" />
          <p className="text-sm font-bold text-slate-800">PDF फाईल्स वाचत आहे, आवश्यक डेटा चेक करत आहे व डुप्लिकेट्स फिल्टर करत आहे...</p>
          <p className="text-xs text-slate-500">कृपया थोडा वेळ थांबा.</p>
        </div>
      )}

      {/* Main Content when Statement Records Exist */}
      {rawRecords.length > 0 && (
        <div className="space-y-3">
          {/* Search Bar & Instruction Strip */}
          <div className="bg-white p-2.5 rounded-xl border border-slate-200 shadow-2xs flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 no-print">
            <div className="relative flex-1 max-w-md">
              <Search className="w-3.5 h-3.5 absolute left-3 top-2.5 text-slate-400" />
              <input
                type="text"
                placeholder="डीलरचे नाव, मोबाईल नंबर किंवा गावाचे नाव शोधा..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-8 pr-3 py-1.5 rounded-lg border border-slate-200 bg-slate-50 focus:bg-white text-xs font-medium focus:outline-none focus:ring-1 focus:ring-red-500"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery('')}
                  className="absolute right-2.5 top-2 text-slate-400 hover:text-slate-600"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            {/* Quick Action Hint */}
            <div className="text-[11px] text-slate-500 font-medium flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
              <span>थकीत रकमेवर क्लिक करताच थेट WhatsApp मेसेज पाठवला जाईल.</span>
            </div>
          </div>

          {/* ============================================================== */}
          {/* THE CLEAN SHEET TABLE (EXACTLY 3 COLUMNS AS REQUESTED)       */}
          {/* 1. डीलरचे नाव (Dealer / Firm Name)                           */}
          {/* 2. मोबाईल नंबर (Mobile Number)                               */}
          {/* 3. थकीत रक्कम (Outstanding Amount - CLICK TO SEND WHATSAPP)   */}
          {/* ============================================================== */}
          <div className="w-full overflow-x-auto rounded-xl border-2 border-black shadow-md bg-white">
            <div 
              ref={printableSheetRef}
              id="dealer-standing-sheet"
              className="min-w-[550px] sm:min-w-[700px] bg-white"
            >
              {/* Printable Letterhead Header: Exactly as in CollectionView */}
              <div className="p-3 sm:p-3.5 bg-white border-b-2 border-black">
                <div className="flex items-center justify-between gap-3 sm:gap-4">
                  <div className="w-12 h-12 sm:w-14 sm:h-14 flex items-center justify-center shrink-0">
                    <img 
                      src={logoUrl || "/logo.jpg"} 
                      alt="Logo" 
                      className="w-10 h-10 sm:w-12 sm:h-12 object-contain" 
                    />
                  </div>

                  <div className="flex-1 text-center space-y-0.5">
                    <h1 className="text-lg sm:text-2xl font-black text-red-600 uppercase tracking-tight leading-none whitespace-nowrap">
                      BLACKWORM AGRITECH PVT LTD
                    </h1>
                    <div className="text-[7.5px] sm:text-[8px] text-slate-700 font-bold leading-tight mt-1 whitespace-nowrap">
                      <p>CIN : U01409PN2022PTC217246, GST No. 27AALCB3069J1ZC</p>
                      <p>Address - Gat No. 17 Vijaynagar (Mhaisal), Tal - Miraj, Dist - Sangli. 416409.</p>
                      <p className="flex items-center justify-center gap-3 sm:gap-4 mt-0.5">
                        <span className="flex items-center gap-1 text-red-600">
                          <Phone className="w-2.5 h-2.5" /> +91 7798716201
                        </span>
                        <span className="flex items-center gap-1 text-red-600 underline">
                          <Mail className="w-2.5 h-2.5" /> blackwormagritechpvtltd@gmail.com
                        </span>
                      </p>
                    </div>
                  </div>

                  <div className="w-16 sm:w-20 h-12 sm:h-14 flex flex-col items-center justify-center border border-black bg-rose-50 shrink-0 p-1">
                    <span className="text-[7px] sm:text-[7.5px] font-black uppercase text-red-800 text-center leading-tight">
                      OUTSTANDING STATEMENT
                    </span>
                    <span className="text-[8.5px] sm:text-[9.5px] font-mono font-black text-slate-900 mt-0.5 whitespace-nowrap">
                      {new Date().toLocaleDateString('en-GB')}
                    </span>
                  </div>
                </div>
              </div>

              {/* Statement Sub-banner: Dealer Standing Amount Statement */}
              <div className="bg-slate-900 text-white font-black px-3 sm:px-4 py-2 flex items-center justify-between border-b-2 border-black text-xs uppercase tracking-wider whitespace-nowrap">
                <span>DEALER STANDING AMOUNT STATEMENT</span>
                <span className="font-mono text-emerald-400">
                  Total Standing: ₹{totalStanding.toLocaleString('en-IN')}
                </span>
              </div>

              {/* STRICTLY 3 COLUMNS TABLE */}
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="bg-slate-100 text-black font-black uppercase text-[10px] sm:text-[11px] border-b-2 border-black">
                    {/* COLUMN 1: Dealer / Firm Name */}
                    <th className="p-2.5 sm:p-3 border-r border-black min-w-[220px] sm:min-w-[300px]">
                      डीलरचे नाव (Dealer / Firm Name)
                    </th>
                    {/* COLUMN 2: Mobile Number */}
                    <th className="p-2.5 sm:p-3 border-r border-black min-w-[140px] sm:min-w-[180px]">
                      मोबाईल नंबर (Mobile Number)
                    </th>
                    {/* COLUMN 3: Outstanding Amount (Clickable for WhatsApp) */}
                    <th className="p-2.5 sm:p-3 text-right min-w-[150px] sm:min-w-[190px] bg-rose-50/80 font-mono">
                      थकीत रक्कम (Outstanding Amount)
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-black/30 font-medium">
                  {filteredRecords.length === 0 ? (
                    <tr>
                      <td colSpan={3} className="p-8 text-center text-slate-400 font-semibold">
                        कोणताही डेटा सापडला नाही.
                      </td>
                    </tr>
                  ) : (
                    filteredRecords.map((item, index) => {
                      const cleanPhone = cleanPhoneNumber(item.contactNumber || phoneOverrides[item.id] || '');
                      const isSent = Boolean(item.whatsappSentAt);

                      return (
                        <tr 
                          key={item.id}
                          className="group transition-colors hover:bg-amber-50/50"
                        >
                          {/* ============================================================== */}
                          {/* COLUMN 1: डीलरचे नाव (Dealer / Firm Name)                     */}
                          {/* ============================================================== */}
                          <td className="p-2.5 sm:p-3 border-r border-black align-middle">
                            <div className="space-y-0.5">
                              <div className="flex items-center justify-between gap-1.5">
                                <div className="flex items-center gap-1.5 flex-wrap">
                                  <span className="font-mono text-[10.5px] font-bold text-slate-400">
                                    #{index + 1}
                                  </span>
                                  <span className="font-black text-slate-900 text-xs sm:text-[13px] leading-tight">
                                    {toTitleCase(item.cleanedFirmName)}
                                  </span>
                                  {item.dealerCode && (
                                    <span className="text-[9.5px] font-mono font-bold bg-slate-100 text-slate-700 px-1 py-0.2 rounded border border-slate-300">
                                      {item.dealerCode.replace(/^#/, '')}
                                    </span>
                                  )}
                                </div>
                                <button
                                  type="button"
                                  onClick={() => handleDeleteRecord(item.id, item.cleanedFirmName)}
                                  className="no-print opacity-0 group-hover:opacity-100 p-1 text-slate-300 hover:text-rose-600 transition cursor-pointer"
                                  title="ही नोंद काढून टाका"
                                >
                                  <Trash2 className="w-3 h-3" />
                                </button>
                              </div>

                              {/* Secondary details: Proprietor & Village */}
                              {(item.proprietorName || item.village || item.district) && (
                                <div className="text-[10.5px] text-slate-600 flex items-center gap-1.5 flex-wrap">
                                  {item.proprietorName && (
                                    <span>
                                      प्रो.: <strong className="text-slate-800">{toTitleCase(item.proprietorName)}</strong>
                                    </span>
                                  )}
                                  {item.village && (
                                    <span>• {toTitleCase(item.village)}</span>
                                  )}
                                  {item.district && (
                                    <span className="text-slate-500">({toTitleCase(item.district)})</span>
                                  )}
                                </div>
                              )}
                            </div>
                          </td>

                          {/* ============================================================== */}
                          {/* COLUMN 2: मोबाईल नंबर (Mobile Number)                          */}
                          {/* ============================================================== */}
                          <td className="p-2.5 sm:p-3 border-r border-black align-middle whitespace-nowrap">
                            {editingPhoneId === item.id ? (
                              <div className="flex items-center gap-1.5">
                                <input
                                  type="tel"
                                  maxLength={10}
                                  autoFocus
                                  placeholder="10 digit phone"
                                  value={tempPhoneInput}
                                  onChange={(e) => setTempPhoneInput(e.target.value.replace(/\D/g, ''))}
                                  className="w-28 px-1.5 py-1 text-xs font-mono font-bold border border-red-500 rounded bg-white focus:outline-none"
                                />
                                <button
                                  type="button"
                                  onClick={() => savePhoneOverride(item.id, tempPhoneInput)}
                                  className="px-2 py-1 bg-emerald-600 text-white rounded text-[10px] font-bold cursor-pointer"
                                >
                                  Save
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setEditingPhoneId(null)}
                                  className="px-1.5 py-1 bg-slate-200 text-slate-600 rounded text-[10px] cursor-pointer"
                                >
                                  ✕
                                </button>
                              </div>
                            ) : cleanPhone ? (
                              <div className="flex items-center justify-between gap-2">
                                <a
                                  href={`tel:${cleanPhone}`}
                                  className="text-slate-900 font-bold hover:text-emerald-700 hover:underline inline-flex items-center gap-1.5 cursor-pointer font-mono text-xs sm:text-[12.5px]"
                                  title="कॉल करा"
                                >
                                  <Phone className="w-3 h-3 text-emerald-600 shrink-0" />
                                  <span>+91 {cleanPhone}</span>
                                </a>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setEditingPhoneId(item.id);
                                    setTempPhoneInput(cleanPhone);
                                  }}
                                  className="no-print text-[9px] text-slate-400 hover:text-slate-700 underline"
                                  title="मोबाईल नंबर बदला"
                                >
                                  Edit
                                </button>
                              </div>
                            ) : (
                              <button
                                type="button"
                                onClick={() => {
                                  setEditingPhoneId(item.id);
                                  setTempPhoneInput('');
                                }}
                                className="no-print inline-flex items-center gap-1 text-[11px] font-bold text-red-600 hover:text-red-800 bg-red-50 hover:bg-red-100 px-2 py-0.5 rounded border border-red-200 transition cursor-pointer"
                                title="मोबाईल नंबर टाका"
                              >
                                <Plus className="w-3 h-3" />
                                <span>+ नंबर टाका</span>
                              </button>
                            )}
                          </td>

                          {/* ============================================================== */}
                          {/* COLUMN 3: थकीत रक्कम (Outstanding Amount)                       */}
                          {/* CRITICAL: Clicking this amount DIRECTLY sends WhatsApp!        */}
                          {/* ============================================================== */}
                          <td className="p-2 sm:p-2.5 text-right align-middle bg-rose-50/40 whitespace-nowrap">
                            <button
                              type="button"
                              onClick={() => handleAmountClickToSendWhatsApp(item)}
                              className="group w-full flex flex-col items-end justify-center px-2.5 py-1.5 rounded-lg border border-red-300 hover:border-emerald-500 bg-white hover:bg-emerald-50/60 shadow-2xs transition active:scale-95 cursor-pointer text-right"
                              title={`₹${item.formattedAmount} - क्लिक करा आणि ${item.cleanedFirmName} ला WhatsApp पाठवा`}
                            >
                              {/* Bold Red Outstanding Amount */}
                              <div className="flex items-center gap-1.5">
                                <span className="text-sm sm:text-base font-black font-mono text-red-600 group-hover:text-emerald-700 transition-colors">
                                  ₹{item.formattedAmount}
                                </span>
                                <div className="w-5 h-5 rounded-full bg-emerald-500 text-white flex items-center justify-center shrink-0 shadow-2xs group-hover:scale-110 transition-transform">
                                  <Send className="w-2.5 h-2.5 translate-x-0.2" />
                                </div>
                              </div>

                              {/* WhatsApp Click Cue & Status */}
                              <div className="flex items-center gap-1 text-[9.5px] font-bold mt-0.5 no-print">
                                {isSent ? (
                                  <span className="text-emerald-700 flex items-center gap-0.5">
                                    <CheckCircle2 className="w-2.5 h-2.5" />
                                    <span>Sent {item.whatsappSentAt}</span>
                                  </span>
                                ) : (
                                  <span className="text-emerald-600 group-hover:underline">
                                    WhatsApp पाठवा
                                  </span>
                                )}
                              </div>
                            </button>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ============================================================== */}
      {/* TOTAL STANDING AMOUNT STICKY BAR (Pinned to bottom)            */}
      {/* ============================================================== */}
      {rawRecords.length > 0 && (
        <div className="fixed bottom-0 left-0 right-0 z-40 bg-slate-950 text-white border-t-2 border-red-600 shadow-2xl px-4 py-3 sm:py-3.5 no-print">
          <div className="max-w-5xl mx-auto flex flex-row items-center justify-between gap-3">
            {/* Left: Total Standing Amount label and bold red amount */}
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 sm:w-10 sm:h-10 rounded-xl bg-red-600/20 text-red-500 border border-red-500/30 flex items-center justify-center font-black text-base sm:text-lg shrink-0">
                ₹
              </div>
              <div>
                <div className="text-[11px] sm:text-xs font-bold text-slate-300 uppercase tracking-wider flex items-center gap-1.5">
                  <span>Total Standing Amount</span>
                  <span className="hidden sm:inline text-slate-500">•</span>
                  <span className="hidden sm:inline text-slate-400">एकूण थकीत रक्कम</span>
                </div>
                <div className="text-xl sm:text-2xl font-black text-red-500 tracking-tight leading-none mt-0.5 font-mono">
                  ₹{totalStanding.toLocaleString('en-IN')}
                </div>
              </div>
            </div>

            {/* Right: Total Dealers count & Quick Actions */}
            <div className="flex items-center gap-2 sm:gap-3 shrink-0">
              <div className="text-right">
                <div className="text-slate-400 text-[10px] sm:text-[11px] uppercase tracking-wider font-semibold">Total Dealers</div>
                <div className="font-black text-white text-sm sm:text-base">
                  {filteredRecords.length} Dealers
                </div>
              </div>

              <button
                type="button"
                onClick={handlePrintSheet}
                className="inline-flex items-center gap-1 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-bold rounded-lg border border-slate-700 transition cursor-pointer"
                title="Print Sheet"
              >
                <Printer className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Print</span>
              </button>

              <button
                type="button"
                onClick={handleExportCSV}
                className="hidden sm:inline-flex items-center gap-1 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-bold rounded-lg border border-slate-700 transition cursor-pointer"
                title="Download CSV Statement"
              >
                <Download className="w-3.5 h-3.5" />
                <span>CSV</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal: Add Manual Dealer Outstanding (No PDF Required) */}
      {showAddDealerModal && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4 animate-fade-in no-print">
          <div className="bg-white rounded-2xl max-w-md w-full border border-slate-200 shadow-2xl overflow-hidden animate-scale-up">
            <div className="p-4 border-b border-slate-200 flex items-center justify-between bg-emerald-50">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-lg bg-emerald-600 text-white flex items-center justify-center font-bold">
                  <Plus className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="text-sm font-black text-slate-900">नवीन डीलर आऊटस्टँडिंग नोंद</h3>
                  <p className="text-[10.5px] text-slate-600">डीलरचे नाव, गाव, फोन व थकीत येणेबाकी नोंदवा</p>
                </div>
              </div>
              <button 
                onClick={() => setShowAddDealerModal(false)}
                className="p-1 rounded-lg text-slate-400 hover:text-slate-600"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleSaveNewDealer} className="p-4 space-y-3">
              <div>
                <label className="block text-[11px] font-bold text-slate-700 mb-1">
                  डीलर / फर्मचे नाव <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  required
                  placeholder="उदा. Ganesh Krushi Seva Kendra"
                  value={newFirmName}
                  onChange={(e) => setNewFirmName(e.target.value)}
                  className="w-full px-3 py-2 text-xs font-semibold rounded-xl border border-slate-300 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </div>

              <div className="grid grid-cols-2 gap-2.5">
                <div>
                  <label className="block text-[11px] font-bold text-slate-700 mb-1">
                    गाव / लोकेशन
                  </label>
                  <input
                    type="text"
                    placeholder="उदा. Manerajuri"
                    value={newVillage}
                    onChange={(e) => setNewVillage(e.target.value)}
                    className="w-full px-3 py-2 text-xs font-semibold rounded-xl border border-slate-300 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-bold text-slate-700 mb-1">
                    प्रोप्रायटरचे नाव
                  </label>
                  <input
                    type="text"
                    placeholder="उदा. गणेश पाटील"
                    value={newProprietor}
                    onChange={(e) => setNewProprietor(e.target.value)}
                    className="w-full px-3 py-2 text-xs font-semibold rounded-xl border border-slate-300 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  />
                </div>
              </div>

              <div>
                <label className="block text-[11px] font-bold text-slate-700 mb-1">
                  मोबाईल नंबर (WhatsApp मेसेजसाठी) <span className="text-red-500">*</span>
                </label>
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold text-slate-500">+91</span>
                  <input
                    type="tel"
                    maxLength={10}
                    required
                    placeholder="9897594653"
                    value={newContact}
                    onChange={(e) => setNewContact(e.target.value.replace(/\D/g, ''))}
                    className="flex-1 px-3 py-2 text-xs font-mono font-bold border border-slate-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  />
                </div>
              </div>

              <div>
                <label className="block text-[11px] font-bold text-slate-700 mb-1">
                  थकीत येणेबाकी रक्कम (₹) <span className="text-red-500">*</span>
                </label>
                <div className="relative">
                  <span className="absolute left-3 top-2 text-xs font-bold text-slate-400">₹</span>
                  <input
                    type="number"
                    step="1"
                    min="1"
                    required
                    placeholder="उदा. 84500"
                    value={newAmount}
                    onChange={(e) => setNewAmount(e.target.value)}
                    className="w-full pl-7 pr-3 py-2 text-xs font-mono font-bold text-red-600 rounded-xl border border-slate-300 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  />
                </div>
              </div>

              <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setShowAddDealerModal(false)}
                  className="px-3 py-2 text-xs font-bold text-slate-600 hover:bg-slate-100 rounded-xl transition cursor-pointer"
                >
                  रद्द करा
                </button>
                <button
                  type="submit"
                  disabled={isSavingDealer}
                  className="flex items-center gap-1.5 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs rounded-xl shadow-xs transition active:scale-95 disabled:opacity-50 cursor-pointer"
                >
                  {isSavingDealer ? 'सेव्ह करत आहे...' : 'सेव्ह करा (Save)'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal: Missing Mobile Number when clicking amount */}
      {missingPhoneModalItem && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-fade-in no-print">
          <div className="bg-white rounded-2xl max-w-sm w-full border border-slate-200 shadow-2xl overflow-hidden">
            <div className="p-4 border-b border-slate-200 flex items-center justify-between bg-red-50">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-lg bg-red-600 text-white flex items-center justify-center font-bold">
                  <Phone className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="text-sm font-black text-slate-900">मोबाईल नंबर आवश्यक आहे</h3>
                  <p className="text-[10.5px] text-slate-600">{missingPhoneModalItem.cleanedFirmName}</p>
                </div>
              </div>
              <button
                onClick={() => setMissingPhoneModalItem(null)}
                className="p-1 rounded-lg text-slate-400 hover:text-slate-600"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-4 space-y-3">
              <p className="text-xs text-slate-600 leading-relaxed">
                थकीत रक्कम (₹{missingPhoneModalItem.formattedAmount}) चा WhatsApp मेसेज पाठवण्यासाठी या डीलरचा १० अंकी मोबाईल नंबर टाका:
              </p>

              <div className="flex items-center gap-2">
                <span className="text-xs font-bold text-slate-500">+91</span>
                <input
                  type="tel"
                  maxLength={10}
                  autoFocus
                  placeholder="98XXXXXXXX"
                  value={manualPhoneInput}
                  onChange={(e) => setManualPhoneInput(e.target.value.replace(/\D/g, ''))}
                  className="flex-1 px-3 py-2 text-sm font-mono font-bold border border-slate-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-red-500"
                />
              </div>

              <div className="flex items-center gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setMissingPhoneModalItem(null)}
                  className="flex-1 py-2 px-3 bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold text-xs rounded-xl transition cursor-pointer"
                >
                  रद्द करा
                </button>
                <button
                  type="button"
                  onClick={handleModalPhoneSubmit}
                  className="flex-1 py-2 px-3 bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs rounded-xl transition cursor-pointer flex items-center justify-center gap-1.5 shadow-xs"
                >
                  <Send className="w-3.5 h-3.5" />
                  <span>WhatsApp पाठवा</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
