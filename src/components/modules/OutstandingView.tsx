import React, { useState, useEffect, useMemo, useRef } from 'react';
import { 
  onSnapshot, 
  doc,
  writeBatch
} from 'firebase/firestore';
import { db } from '../../firebase';
import { UserProfile, isAdmin, isUserRecord } from '../../lib/auth';
import { safeFirestoreSet, safeFirestoreDelete, triggerBlobDownload, getLocalDateStr, trackFirestoreUsage, isQuotaBlocked, setQuotaBlocked } from '../../lib/dataService';
import { subscribeSecondaryCollection, fetchSecondaryCollection, pushBatchToSecondary } from '../../lib/secondaryDb';
import { useSharedDealers, useSharedOutstandingRecords } from '../../lib/realtimeStore';
import { Language } from '../../lib/i18n';
import { cn, toTitleCase, openExternalLinkSafely } from '../../lib/utils';
import { CustomDialogModal } from '../CustomDialogModal';
import { useBranding } from '../../lib/branding';
import { 
  parseOutstandingPdf, 
  ExtractedRecord, 
  MatchedOutstandingItem, 
  getFirmNameMatchScore, 
  buildWhatsAppLink, 
  cleanPhoneNumber,
  mergeAndDeduplicateRecords,
  UploadSummaryReport
} from '../../lib/pdfOutstandingParser';
import { ALL_PARTY_REPORT_166, ALL_PARTY_TOTAL_OUTSTANDING } from '../../lib/allPartyReport166';
import { DealershipFormItem } from './DealerView';
import { 
  FileUp, 
  FileText, 
  Search, 
  Phone, 
  AlertCircle, 
  Download, 
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
  FileCheck,
  ShieldCheck,
  ArrowUpRight,
  ArrowDownRight,
  Users,
  UserPlus,
  Lock,
  Unlock
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

  // Shared real-time dealers & outstanding records across app (zero duplicate listeners!)
  const { dealers: sharedDealers, loaded: dealersLoaded } = useSharedDealers();
  const {
    outstandingRecords: sharedOutstandingRecords,
    loaded: outstandingLoaded,
    setOutstandingOptimistic,
  } = useSharedOutstandingRecords();
  const dealers = sharedDealers as DealershipFormItem[];
  const [loadingDealers, setLoadingDealers] = useState(!dealersLoaded || !outstandingLoaded);

  // Multi-PDF Parsing & File state (Persisted in Firestore, Secondary DB & LocalStorage)
  const [isParsing, setIsParsing] = useState(false);
  const [uploadedFiles, setUploadedFiles] = useState<UploadedPdfFile[]>([]);
  const [duplicatesPreventedCount, setDuplicatesPreventedCount] = useState<number>(0);
  const [uploadSummaryReport, setUploadSummaryReport] = useState<UploadSummaryReport | null>(null);
  const [summaryModalTab, setSummaryModalTab] = useState<'new' | 'updated'>('new');
  const rawRecords = sharedOutstandingRecords as ExtractedRecord[];
  const setRawRecords = setOutstandingOptimistic as React.Dispatch<React.SetStateAction<ExtractedRecord[]>>;
  const [parseError, setParseError] = useState<string>('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const printableSheetRef = useRef<HTMLDivElement>(null);

  // Party Master Lock State (Stored in Firestore config/party_master_meta)
  const [isPartyMasterLocked, setIsPartyMasterLocked] = useState<boolean>(false);
  const [lockMeta, setLockMeta] = useState<{
    lockedAt?: string | null;
    lockedBy?: string | null;
    totalRecords?: number;
    totalOutstanding?: number;
  }>({});
  const [isUpdatingLock, setIsUpdatingLock] = useState<boolean>(false);

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

  const [dialogConfig, setDialogConfig] = useState<{
    isOpen: boolean;
    type?: 'confirm' | 'alert' | 'success';
    title?: string;
    message: string;
    confirmText?: string;
    cancelText?: string;
    onConfirm: () => void;
    onCancel?: () => void;
  }>({
    isOpen: false,
    message: '',
    onConfirm: () => {},
  });

  // Seed verified outstanding records (166 records from All Party Report totaling ₹1,63,59,049)
  const seededOnceRef = useRef(false);
  const seedDefaultOutstandingRecords = async () => {
    if (seededOnceRef.current) return;
    seededOnceRef.current = true;
    try {
      const nowIso = new Date().toISOString();
      const defaultData: ExtractedRecord[] = ALL_PARTY_REPORT_166.map(r => ({
        ...r,
        updatedAt: nowIso,
        updatedBy: profile.fullName || 'System'
      }));

      setRawRecords(defaultData);

      await pushBatchToSecondary(
        defaultData.map((item) => ({
          collection: 'outstanding_records',
          id: item.id,
          doc: item,
          merge: true,
        }))
      );

      if (!isQuotaBlocked()) {
        for (let i = 0; i < defaultData.length; i += 400) {
          const chunk = defaultData.slice(i, i + 400);
          const batch = writeBatch(db);
          chunk.forEach((item) => {
            const docRef = doc(db, 'outstanding_records', item.id);
            batch.set(docRef, item);
          });
          await batch.commit();
        }
      }
    } catch (e) {
      console.warn('Failed to seed default outstanding records:', e);
    }
  };

  useEffect(() => {
    if (outstandingLoaded) {
      setLoadingDealers(false);
      if (rawRecords.length === 0) {
        void seedDefaultOutstandingRecords();
      }
    }
  }, [outstandingLoaded, rawRecords.length]);

  // Real-time Party Master Lock metadata from config/party_master_meta (Primary + Secondary DB)
  useEffect(() => {
    const applyMeta = (data: any) => {
      if (!data) return;
      setIsPartyMasterLocked(Boolean(data.isLocked));
      setLockMeta({
        lockedAt: data.lockedAt || null,
        lockedBy: data.lockedBy || null,
        totalRecords: data.totalRecords,
        totalOutstanding: data.totalOutstanding,
      });
    };

    const pullMetaFromSecondary = async () => {
      try {
        const res = await fetchSecondaryCollection('config', { limit: 50 });
        if (res.ok) {
          const found = res.items.find((it) => it?.id === 'party_master_meta');
          if (found) applyMeta(found);
        }
      } catch {}
    };

    const unsubSecMeta = subscribeSecondaryCollection('config', (events) => {
      events.forEach((evt) => {
        if (evt.id === 'party_master_meta' && evt.doc && !evt.deleted) {
          applyMeta(evt.doc);
        }
      });
    });

    let unsubMeta: (() => void) | null = null;
    if (isQuotaBlocked()) {
      void pullMetaFromSecondary();
    } else {
      unsubMeta = onSnapshot(doc(db, 'config', 'party_master_meta'), (docSnap) => {
        trackFirestoreUsage('read', 1);
        if (docSnap.exists()) {
          applyMeta(docSnap.data());
        }
      }, (err) => {
        const msg = String(err?.message || '').toLowerCase();
        if (msg.includes('quota') || msg.includes('resource_exhausted')) {
          setQuotaBlocked(15 * 60 * 1000);
        }
        console.warn("Party master meta sync notice:", err);
        void pullMetaFromSecondary();
      });
    }

    return () => {
      unsubSecMeta();
      if (unsubMeta) unsubMeta();
    };
  }, []);

  // All registered dealers (including Amir Nanavare's) provide contact enrichment across authorized logins;
  // Admin can filter by specific officer.
  const accessibleDealers = useMemo(() => {
    if (isUserAdmin && selectedOfficer !== 'all') {
      return dealers.filter(d => {
        const officer = (d.officerName || d.created_by_name || '').toLowerCase();
        return officer.includes(selectedOfficer.toLowerCase()) ||
               d.created_by_user_id === selectedOfficer;
      });
    }
    return dealers;
  }, [dealers, isUserAdmin, selectedOfficer]);

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

  // Toggle Party Master Data Lock (Admin-only)
  const handleToggleLock = async () => {
    if (!isUserAdmin) {
      showToast('फक्त ॲडमिनला Party Master लॉक किंवा अनलॉक करण्याची परवानगी आहे.', 'info');
      return;
    }

    const nextLockState = !isPartyMasterLocked;
    const actionText = nextLockState ? 'लॉक (Lock)' : 'अनलॉक (Unlock)';

    setDialogConfig({
      isOpen: true,
      type: 'confirm',
      title: `Party Master ${actionText} करा`,
      message: nextLockState 
        ? `तुम्ही Party Master डेटा Final Lock करू इच्छिता का? लॉक केल्यानंतर नवीन PDF अपलोड किंवा नोंदी बदलता येणार नाहीत. (एकूण १६६ पार्टी, एकूण ₹१,६३,५९,०४९)`
        : `तुम्हाला Party Master Unlock करायचा आहे का? त्यानंतर नवीन PDF अपलोड आणि नोंदी एडिट करता येतील.`,
      confirmText: nextLockState ? 'होय, डेटा लॉक करा' : 'होय, अनलॉक करा',
      cancelText: 'रद्द करा',
      onConfirm: async () => {
        setDialogConfig(p => ({ ...p, isOpen: false }));
        setIsUpdatingLock(true);
        try {
          const totalAmt = processedRecords.reduce((acc, curr) => acc + curr.amount, 0);
          await safeFirestoreSet('config', 'party_master_meta', {
            isLocked: nextLockState,
            lockedAt: nextLockState ? new Date().toISOString() : null,
            lockedBy: nextLockState ? (profile.fullName || profile.emailId || 'Admin') : null,
            totalRecords: processedRecords.length,
            totalOutstanding: totalAmt,
            updatedAt: new Date().toISOString()
          }, { merge: true });

          showToast(nextLockState ? 'Party Master यशस्वीरित्या लॉक केला!' : 'Party Master अनलॉक केला.');
        } catch (err: any) {
          console.error('Lock error:', err);
          showToast('लॉक स्थिती बदलताना त्रुटी आली.', 'info');
        } finally {
          setIsUpdatingLock(false);
        }
      },
      onCancel: () => setDialogConfig(p => ({ ...p, isOpen: false }))
    });
  };

  // Handle Multi-PDF file upload and duplicate-free auto update
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!isUserAdmin) {
      setParseError('फक्त ॲडमिनला All Party Report PDF अपलोड करण्याची परवानगी आहे.');
      showToast('फक्त ॲडमिनला PDF अपलोड करण्याची परवानगी आहे.', 'info');
      return;
    }

    if (isPartyMasterLocked) {
      setParseError('Party Master डेटा सध्या लॉक आहे. नवीन PDF अपलोड करण्यासाठी आधी ॲडमिनने डेटा अनलॉक करावा.');
      showToast('Party Master डेटा लॉक आहे. आधी अनलॉक करा.', 'info');
      return;
    }

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
      let totalUpdated = 0;
      let totalUnchanged = 0;
      let totalDuplicatesMerged = 0;
      const newlyProcessedFiles: UploadedPdfFile[] = [];
      const aggregatedNewParties: UploadSummaryReport['newParties'] = [];
      const aggregatedUpdatedParties: UploadSummaryReport['updatedParties'] = [];

      for (const file of validPdfFiles) {
        const buffer = await file.arrayBuffer();
        const extracted = await parseOutstandingPdf(buffer, file.name);

        if (extracted.length > 0) {
          const { merged, addedCount, updatedCount, unchangedCount, duplicateCount, summary } = mergeAndDeduplicateRecords(
            currentRecords,
            extracted,
            file.name
          );

          currentRecords = merged;
          totalNewAdded += addedCount;
          totalUpdated += updatedCount;
          totalUnchanged += unchangedCount;
          totalDuplicatesMerged += duplicateCount;
          aggregatedNewParties.push(...summary.newParties);
          aggregatedUpdatedParties.push(...summary.updatedParties);

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
        setParseError('निवडलेल्या PDF फाईल्समधून कोणताही डेटा काढता आला नाही. कृपया वैध पार्टी रिपोर्ट किंवा आउटस्टँडिंग PDF फाईल निवडा.');
      } else {
        setRawRecords(currentRecords);
        setUploadedFiles(prev => {
          const existingNames = new Set(prev.map(f => f.name));
          const filteredNew = newlyProcessedFiles.filter(f => !existingNames.has(f.name));
          return [...prev, ...filteredNew];
        });
        setDuplicatesPreventedCount(prev => prev + totalDuplicatesMerged);

        // Persist all extracted records to Secondary DB and Firestore in safe chunks of 400
        const nowIso = new Date().toISOString();
        await pushBatchToSecondary(
          currentRecords.map((rec) => ({
            collection: 'outstanding_records',
            id: rec.id,
            doc: { ...rec, updatedAt: nowIso, updatedBy: profile.fullName || 'User' },
            merge: true,
          }))
        );
        if (!isQuotaBlocked()) {
          try {
            for (let i = 0; i < currentRecords.length; i += 400) {
              const chunk = currentRecords.slice(i, i + 400);
              const batch = writeBatch(db);
              chunk.forEach((rec) => {
                const docRef = doc(db, 'outstanding_records', rec.id);
                batch.set(docRef, {
                  ...rec,
                  updatedAt: nowIso,
                  updatedBy: profile.fullName || 'User'
                }, { merge: true });
              });
              await batch.commit();
            }
          } catch (dbErr) {
            console.warn('Failed to persist to Primary Firestore:', dbErr);
          }
        }

        try {
          localStorage.setItem('blackworm_saved_outstanding_records', JSON.stringify(currentRecords));
        } catch {}

        // Set the full Summary Report for user visibility
        setUploadSummaryReport({
          totalExtracted: totalNewAdded + totalUpdated + totalUnchanged,
          addedCount: totalNewAdded,
          updatedCount: totalUpdated,
          unchangedCount: totalUnchanged,
          duplicateCount: totalDuplicatesMerged,
          sourceFile: newlyProcessedFiles.map(f => f.name).join(', '),
          newParties: aggregatedNewParties,
          updatedParties: aggregatedUpdatedParties,
        });

        if (aggregatedNewParties.length > 0) {
          setSummaryModalTab('new');
        } else if (aggregatedUpdatedParties.length > 0) {
          setSummaryModalTab('updated');
        }

        showToast(
          `Party Master अपडेट झाला! ${totalNewAdded} नवीन जोडल्या, ${totalUpdated} अपडेट, ${totalDuplicatesMerged} डुप्लिकेट्स रोखले.`
        );
      }
    } catch (err: any) {
      console.error('PDF parsing error:', err);
      setParseError('PDF वाचताना त्रुटी आली: ' + (err.message || 'Unknown error.'));
    } finally {
      setIsParsing(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  // Delete a dealer outstanding record from Firestore
  const handleDeleteRecord = (recordId: string, firmName: string) => {
    if (!isUserAdmin || isPartyMasterLocked) {
      showToast(
        isPartyMasterLocked
          ? 'Party Master डेटा लॉक आहे. नोंद काढण्यासाठी आधी अनलॉक करा.'
          : 'फक्त ॲडमिन नोंद काढू शकतात.',
        'info'
      );
      return;
    }
    setDialogConfig({
      isOpen: true,
      type: 'confirm',
      title: 'नोंद काढून टाका',
      message: `तुम्हाला खरोखर '${firmName}' ची थकीत नोंद काढून टाकायची आहे का?`,
      confirmText: 'हटवा (Delete)',
      cancelText: 'रद्द करा',
      onConfirm: async () => {
        setDialogConfig(p => ({ ...p, isOpen: false }));
        try {
          setRawRecords(prev => prev.filter(r => r.id !== recordId));
          await safeFirestoreDelete('outstanding_records', recordId);
          showToast(`'${firmName}' ची नोंद काढली.`);
        } catch (err) {
          console.error('Failed to delete record:', err);
        }
      },
      onCancel: () => setDialogConfig(p => ({ ...p, isOpen: false }))
    });
  };

  // Remove a specific PDF file and its records
  const handleRemoveFile = (fileNameToRemove: string) => {
    setUploadedFiles(prev => prev.filter(f => f.name !== fileNameToRemove));

    const toDeleteIds: string[] = [];
    const toUpdateRecords: { id: string; sourceFile: string }[] = [];

    setRawRecords(prev => {
      const remaining: ExtractedRecord[] = [];
      prev.forEach(record => {
        const sources = (record.sourceFile || '').split(', ').map(s => s.trim()).filter(Boolean);
        // If this record only came from this file, remove it
        if (sources.length <= 1 && (sources[0] === fileNameToRemove || !record.sourceFile)) {
          toDeleteIds.push(record.id);
          return;
        }
        // If it came from multiple files, keep a copy with this source removed
        if (sources.includes(fileNameToRemove)) {
          const nextSources = sources.filter(s => s !== fileNameToRemove).join(', ');
          toUpdateRecords.push({ id: record.id, sourceFile: nextSources });
          remaining.push({ ...record, sourceFile: nextSources });
        } else {
          remaining.push(record);
        }
      });
      try {
        localStorage.setItem('blackworm_saved_outstanding_records', JSON.stringify(remaining));
      } catch {}
      return remaining;
    });

    Promise.all([
      ...toDeleteIds.map(id => safeFirestoreDelete('outstanding_records', id).catch(() => {})),
      ...toUpdateRecords.map(u => safeFirestoreSet('outstanding_records', u.id, { sourceFile: u.sourceFile }, { merge: true }).catch(() => {}))
    ]).catch(() => {});

    showToast(`"${fileNameToRemove}" फाईल आणि तिचा डेटा शीटमधून काढला.`);
  };

  const handleClearData = () => {
    if (!isUserAdmin || isPartyMasterLocked) {
      showToast('Party Master डेटा लॉक आहे किंवा परवानगी नाही.', 'info');
      return;
    }
    setDialogConfig({
      isOpen: true,
      type: 'confirm',
      title: 'डेटा साफ करा',
      message: 'तुम्हाला खरोखर सर्व थकीत येणेबाकी डेटा साफ करायचा आहे का?',
      confirmText: 'साफ करा (Clear)',
      cancelText: 'रद्द करा',
      onConfirm: async () => {
        setDialogConfig(p => ({ ...p, isOpen: false }));
        const recordsToDelete = [...rawRecords];

        setRawRecords([]);
        setUploadedFiles([]);
        setDuplicatesPreventedCount(0);
        setParseError('');
        try {
          localStorage.removeItem('blackworm_saved_outstanding_records');
          localStorage.removeItem('blackworm_local_outstanding_records');
          const pendingRaw = localStorage.getItem('blackworm_pending_sync');
          if (pendingRaw) {
            const pending = JSON.parse(pendingRaw);
            if (Array.isArray(pending)) {
              localStorage.setItem(
                'blackworm_pending_sync',
                JSON.stringify(pending.filter((q: any) => q?.collection !== 'outstanding_records'))
              );
            }
          }
        } catch {}

        try {
          await pushBatchToSecondary(
            recordsToDelete.map((r) => ({
              collection: 'outstanding_records',
              id: r.id,
              doc: { isArchived: true, updatedAt: new Date().toISOString() },
              deleted: true,
              merge: true,
            }))
          );
          if (!isQuotaBlocked()) {
            for (let i = 0; i < recordsToDelete.length; i += 400) {
              const chunk = recordsToDelete.slice(i, i + 400);
              const batch = writeBatch(db);
              chunk.forEach((r) => {
                batch.delete(doc(db, 'outstanding_records', r.id));
              });
              await batch.commit();
            }
          }
        } catch (e) {
          console.warn('Clear outstanding batch notice:', e);
        }
        showToast('सर्व डेटा साफ केला.');
      },
      onCancel: () => setDialogConfig(p => ({ ...p, isOpen: false }))
    });
  };

  // Cross-reference extracted PDF records with dealers in dealers_application
  // and preserve each clean unique party record
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

      if (bestMatch && highestScore >= 60) {
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

    // STRICT UNIQUE PRESERVATION:
    // Every distinct party record from the PDF report is maintained cleanly
    const deduplicatedMap = new Map<string, MatchedOutstandingItem>();

    matchedList.forEach((item) => {
      const dedupKey = item.id || `firm_${(item.cleanedFirmName || item.rawFirmName).toLowerCase().trim()}`;

      if (!deduplicatedMap.has(dedupKey)) {
        deduplicatedMap.set(dedupKey, item);
      } else {
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
      showToast('कृपया वैध १० अंकी मोबाईल नंबर टाका.', 'info');
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

    // Directly open WhatsApp safely
    openExternalLinkSafely(url);
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
      openExternalLinkSafely(url);
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

    const csvContent = '\uFEFF' + [headers.join(','), ...rows.map(e => e.join(','))].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    triggerBlobDownload(blob, `Dealer_Standing_Amount_Statement_${getLocalDateStr()}.csv`);
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
              Outstanding
            </h2>
          </div>
        </div>

        {/* Action Buttons: Upload Statement PDF(s), Add Party, Demo Data, Print Sheet */}
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

          {isUserAdmin && (
            <button
              type="button"
              onClick={handleToggleLock}
              disabled={isUpdatingLock}
              className={cn(
                "flex items-center gap-1.5 font-bold text-xs px-3 py-1.5 rounded-lg border shadow-2xs transition active:scale-95 cursor-pointer whitespace-nowrap",
                isPartyMasterLocked
                  ? "bg-amber-100 hover:bg-amber-200 text-amber-900 border-amber-300"
                  : "bg-slate-100 hover:bg-slate-200 text-slate-700 border-slate-200"
              )}
              title={lockMeta.lockedBy ? `Locked by ${lockMeta.lockedBy}` : 'Toggle Party Master Lock'}
            >
              {isPartyMasterLocked ? <Lock className="w-3.5 h-3.5 text-amber-700" /> : <Unlock className="w-3.5 h-3.5 text-slate-600" />}
              <span>{isUpdatingLock ? 'Updating...' : isPartyMasterLocked ? 'Locked' : 'Lock Data'}</span>
            </button>
          )}

          <label
            htmlFor="outstanding-pdf-upload"
            className={cn(
              "flex items-center gap-1.5 bg-red-600 hover:bg-red-700 active:scale-95 text-white font-bold text-xs px-3 py-1.5 rounded-lg shadow-2xs transition cursor-pointer whitespace-nowrap",
              (isPartyMasterLocked || !isUserAdmin) && "opacity-60"
            )}
            title="All Party Report PDF अपलोड करा"
          >
            <FileUp className="w-3.5 h-3.5" />
            <span>{isParsing ? 'अपडेट करत आहे...' : '+ All Party PDF अपलोड करा'}</span>
          </label>

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

              {isUserAdmin && !isPartyMasterLocked && (
                <button
                  type="button"
                  onClick={handleClearData}
                  className="p-1.5 text-slate-400 hover:text-rose-600 rounded-lg hover:bg-slate-100 transition"
                  title="Clear Data"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                </button>
              )}
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
              All Party Report / Outstanding PDF अपलोड करा
            </h3>
            <p className="text-xs text-slate-500 max-w-lg mx-auto mt-1 leading-relaxed">
              PDF मधील <strong>Party Name</strong>, <strong>Contact Number</strong> व <strong>Receivable Balance</strong> अचूकपणे Party Master मध्ये नोंदवले जातील. आधीच्या पार्टींचे बॅलन्स अपडेट होईल व कोणताही डेटा डबल (Duplicate) होणार नाही!
            </p>
          </div>
          <div className="pt-2 flex items-center justify-center gap-2 flex-wrap">
            <span className="inline-flex items-center gap-1.5 px-4 py-2 bg-red-600 hover:bg-red-700 text-white font-bold text-xs rounded-xl shadow-xs transition">
              <FileUp className="w-4 h-4" />
              + All Party PDF अपलोड करा
            </span>
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
                placeholder="पार्टीचे नाव किंवा मोबाईल नंबर शोधा..."
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

              {/* Statement Sub-banner: Party Master & Receivable Balance Statement */}
              <div className="bg-slate-900 text-white font-black px-3 sm:px-4 py-2 flex items-center justify-between border-b-2 border-black text-xs uppercase tracking-wider whitespace-nowrap">
                <span>PARTY MASTER & RECEIVABLE BALANCE STATEMENT</span>
                <span className="font-mono text-emerald-400">
                  Total Receivable: ₹{totalStanding.toLocaleString('en-IN')}
                </span>
              </div>

              {/* STRICTLY 3 COLUMNS TABLE */}
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="bg-slate-100 text-black font-black uppercase text-[10px] sm:text-[11px] border-b-2 border-black">
                    {/* COLUMN 1: Party Name */}
                    <th className="p-2.5 sm:p-3 border-r border-black min-w-[220px] sm:min-w-[300px]">
                      पार्टीचे नाव (Party Name)
                    </th>
                    {/* COLUMN 2: Contact Number */}
                    <th className="p-2.5 sm:p-3 border-r border-black min-w-[140px] sm:min-w-[180px]">
                      मोबाईल नंबर (Contact Number)
                    </th>
                    {/* COLUMN 3: Receivable Balance (Clickable for WhatsApp) */}
                    <th className="p-2.5 sm:p-3 text-right min-w-[150px] sm:min-w-[190px] bg-rose-50/80 font-mono">
                      थकीत येणेबाकी (Receivable Balance)
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

      {/* ============================================================== */}
      {/* Upload Summary Report Modal (Requirement 9)                    */}
      {/* ============================================================== */}
      {uploadSummaryReport && (
        <div className="fixed inset-0 bg-slate-900/70 backdrop-blur-xs flex items-center justify-center p-3 sm:p-4 z-50 animate-fade-in no-print">
          <div className="bg-white rounded-2xl max-w-2xl w-full border border-slate-200 shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
            {/* Modal Header */}
            <div className="p-4 sm:p-5 border-b border-slate-200 flex items-center justify-between bg-gradient-to-r from-slate-900 via-slate-800 to-slate-900 text-white">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-emerald-500/20 border border-emerald-400/40 text-emerald-400 flex items-center justify-center font-bold shrink-0">
                  <FileCheck className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-base font-black tracking-tight flex items-center gap-2">
                    <span>All Party Report – अपलोड व अपडेट सारांश</span>
                    <span className="text-[10px] uppercase font-bold px-2 py-0.5 rounded-full bg-emerald-500 text-slate-950">
                      यशस्वी
                    </span>
                  </h3>
                  <p className="text-xs text-slate-300 mt-0.5">
                    Party Master मध्ये डेटा ऑटोमॅटिक सिंक झाला व डुप्लिकेट्स रोखले गेले
                  </p>
                </div>
              </div>
              <button
                onClick={() => setUploadSummaryReport(null)}
                className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-700/50 transition cursor-pointer"
                title="बंद करा"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Modal Body */}
            <div className="p-4 sm:p-5 space-y-4 overflow-y-auto flex-1">
              {/* 4 Summary Metric Cards */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                {/* 1. Total in PDF */}
                <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl text-center">
                  <div className="flex items-center justify-center gap-1 text-[11px] font-bold text-slate-500 mb-1">
                    <Files className="w-3.5 h-3.5" />
                    <span>PDF मधील पार्टी</span>
                  </div>
                  <div className="text-xl sm:text-2xl font-black text-slate-900 font-mono">
                    {uploadSummaryReport.totalExtracted}
                  </div>
                  <div className="text-[10px] text-slate-500 mt-0.5 font-medium">एकूण वाचल्या</div>
                </div>

                {/* 2. Newly Added */}
                <div className="p-3 bg-emerald-50/80 border border-emerald-200 rounded-xl text-center">
                  <div className="flex items-center justify-center gap-1 text-[11px] font-bold text-emerald-700 mb-1">
                    <UserPlus className="w-3.5 h-3.5" />
                    <span>नवीन पार्टी</span>
                  </div>
                  <div className="text-xl sm:text-2xl font-black text-emerald-700 font-mono">
                    +{uploadSummaryReport.addedCount}
                  </div>
                  <div className="text-[10px] text-emerald-600 mt-0.5 font-semibold">नवीन ॲड झाल्या</div>
                </div>

                {/* 3. Balance Updated */}
                <div className="p-3 bg-blue-50/80 border border-blue-200 rounded-xl text-center">
                  <div className="flex items-center justify-center gap-1 text-[11px] font-bold text-blue-700 mb-1">
                    <RefreshCw className="w-3.5 h-3.5" />
                    <span>बॅलन्स अपडेट</span>
                  </div>
                  <div className="text-xl sm:text-2xl font-black text-blue-700 font-mono">
                    {uploadSummaryReport.updatedCount}
                  </div>
                  <div className="text-[10px] text-blue-600 mt-0.5 font-semibold">येणेबाकी बदलली</div>
                </div>

                {/* 4. Duplicates Prevented */}
                <div className="p-3 bg-purple-50/80 border border-purple-200 rounded-xl text-center">
                  <div className="flex items-center justify-center gap-1 text-[11px] font-bold text-purple-700 mb-1">
                    <ShieldCheck className="w-3.5 h-3.5" />
                    <span>डुप्लिकेट रोखल्या</span>
                  </div>
                  <div className="text-xl sm:text-2xl font-black text-purple-700 font-mono">
                    {uploadSummaryReport.duplicateCount}
                  </div>
                  <div className="text-[10px] text-purple-600 mt-0.5 font-semibold">सुरक्षित फिल्टर</div>
                </div>
              </div>

              {/* Duplicate Prevention & Non-Destructive Reassurance Banner */}
              <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-xl flex items-start gap-2.5 text-xs text-emerald-900">
                <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                <div className="space-y-0.5">
                  <p className="font-bold">
                    डेटा सुरक्षित: आधीचा कोणताही डेटा नष्ट किंवा चुकीचा overwrite झालेला नाही!
                  </p>
                  <p className="text-[11px] text-emerald-700">
                    पार्टी नेम व मोबाईल नंबरच्या आधारे अचूक पडताळणी करून फक्त आवश्यक बदल (Receivable Balance) अपडेट केले आहेत.
                  </p>
                </div>
              </div>

              {/* Tabs: New Parties vs Updated Parties */}
              <div className="flex items-center gap-2 border-b border-slate-200 pb-1">
                <button
                  type="button"
                  onClick={() => setSummaryModalTab('new')}
                  className={cn(
                    "px-3.5 py-1.5 text-xs font-bold rounded-lg transition cursor-pointer flex items-center gap-1.5",
                    summaryModalTab === 'new'
                      ? "bg-emerald-600 text-white shadow-xs"
                      : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                  )}
                >
                  <UserPlus className="w-3.5 h-3.5" />
                  <span>नवीन ॲड झालेल्या पार्टी ({uploadSummaryReport.newParties.length})</span>
                </button>

                <button
                  type="button"
                  onClick={() => setSummaryModalTab('updated')}
                  className={cn(
                    "px-3.5 py-1.5 text-xs font-bold rounded-lg transition cursor-pointer flex items-center gap-1.5",
                    summaryModalTab === 'updated'
                      ? "bg-blue-600 text-white shadow-xs"
                      : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                  )}
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  <span>बॅलन्स अपडेट झालेल्या पार्टी ({uploadSummaryReport.updatedParties.length})</span>
                </button>
              </div>

              {/* Tab 1 Content: Newly Added Parties */}
              {summaryModalTab === 'new' && (
                <div className="border border-slate-200 rounded-xl overflow-hidden">
                  {uploadSummaryReport.newParties.length === 0 ? (
                    <div className="p-8 text-center text-slate-400 text-xs font-medium">
                      या PDF मधील सर्व पार्टी आधीपासूनच Party Master मध्ये अस्तित्वात होत्या. कोणतीही अनावश्यक डबल नोंद तयार झालेली नाही.
                    </div>
                  ) : (
                    <div className="max-h-60 overflow-y-auto">
                      <table className="w-full text-left text-xs border-collapse">
                        <thead className="bg-slate-100 sticky top-0 text-slate-700 font-bold border-b border-slate-200 text-[10.5px]">
                          <tr>
                            <th className="p-2 sm:p-2.5">#</th>
                            <th className="p-2 sm:p-2.5">पार्टीचे नाव (Party Name)</th>
                            <th className="p-2 sm:p-2.5">मोबाईल नंबर (Contact)</th>
                            <th className="p-2 sm:p-2.5 text-right">थकीत येणेबाकी (Balance)</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100 font-medium">
                          {uploadSummaryReport.newParties.map((p, idx) => (
                            <tr key={idx} className="hover:bg-emerald-50/40">
                              <td className="p-2 sm:p-2.5 text-slate-400 text-[10.5px]">{idx + 1}</td>
                              <td className="p-2 sm:p-2.5 font-bold text-slate-800">{p.firmName}</td>
                              <td className="p-2 sm:p-2.5 text-slate-600 font-mono text-[11px]">
                                {p.contactNumber ? (
                                  <span className="flex items-center gap-1 text-emerald-700">
                                    <Phone className="w-3 h-3 text-emerald-600" />
                                    <span>{p.contactNumber}</span>
                                  </span>
                                ) : (
                                  <span className="text-slate-400 text-[10px]">उपलब्ध नाही</span>
                                )}
                              </td>
                              <td className="p-2 sm:p-2.5 text-right font-mono font-bold text-red-600">
                                ₹{p.formattedAmount}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}

              {/* Tab 2 Content: Updated Parties */}
              {summaryModalTab === 'updated' && (
                <div className="border border-slate-200 rounded-xl overflow-hidden">
                  {uploadSummaryReport.updatedParties.length === 0 ? (
                    <div className="p-8 text-center text-slate-400 text-xs font-medium">
                      या PDF मधील पार्टींचे आधीचे येणेबाकी बॅलन्स आधीसारखेच कायम आहे.
                    </div>
                  ) : (
                    <div className="max-h-60 overflow-y-auto">
                      <table className="w-full text-left text-xs border-collapse">
                        <thead className="bg-slate-100 sticky top-0 text-slate-700 font-bold border-b border-slate-200 text-[10.5px]">
                          <tr>
                            <th className="p-2 sm:p-2.5">#</th>
                            <th className="p-2 sm:p-2.5">पार्टीचे नाव (Party Name)</th>
                            <th className="p-2 sm:p-2.5">आधीचे बॅलन्स</th>
                            <th className="p-2 sm:p-2.5 text-right">नवीन येणेबाकी (Updated)</th>
                            <th className="p-2 sm:p-2.5 text-right">बदल (Diff)</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100 font-medium">
                          {uploadSummaryReport.updatedParties.map((u, idx) => {
                            const isIncrease = u.amountDiff > 0;
                            return (
                              <tr key={idx} className="hover:bg-blue-50/40">
                                <td className="p-2 sm:p-2.5 text-slate-400 text-[10.5px]">{idx + 1}</td>
                                <td className="p-2 sm:p-2.5 font-bold text-slate-800">{u.firmName}</td>
                                <td className="p-2 sm:p-2.5 text-slate-500 font-mono">
                                  ₹{u.oldAmount.toLocaleString('en-IN')}
                                </td>
                                <td className="p-2 sm:p-2.5 text-right font-mono font-black text-slate-900">
                                  ₹{u.newAmount.toLocaleString('en-IN')}
                                </td>
                                <td className="p-2 sm:p-2.5 text-right font-mono text-[11px] font-bold">
                                  <span className={cn(
                                    "inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded",
                                    isIncrease ? "bg-rose-50 text-rose-700" : "bg-emerald-50 text-emerald-700"
                                  )}>
                                    {isIncrease ? <ArrowUpRight className="w-3 h-3" /> : <ArrowDownRight className="w-3 h-3" />}
                                    ₹{Math.abs(u.amountDiff).toLocaleString('en-IN')}
                                  </span>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Modal Footer */}
            <div className="p-4 border-t border-slate-200 bg-slate-50 flex items-center justify-between gap-3">
              <span className="text-[11px] text-slate-500 font-medium hidden sm:inline">
                Party Master List मधील {processedRecords.length} डीलर्सची यादी पाहण्यासाठी खालील बटणावर क्लिक करा.
              </span>
              <button
                type="button"
                onClick={() => setUploadSummaryReport(null)}
                className="w-full sm:w-auto ml-auto px-5 py-2.5 bg-emerald-600 hover:bg-emerald-700 active:scale-95 text-white font-black text-xs rounded-xl shadow-xs transition cursor-pointer flex items-center justify-center gap-2"
              >
                <CheckCircle2 className="w-4 h-4" />
                <span>Party Master List पहा (OK)</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Confirmation & Alert Modal */}
      <CustomDialogModal {...dialogConfig} />
    </div>
  );
};
