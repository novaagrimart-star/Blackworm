import React, { useState, useRef, useMemo } from 'react';
import { UserProfile, isAdmin } from '../../lib/auth';
import { Language } from '../../lib/i18n';
import { DynamicPriceProduct, OFFICIAL_REFERENCE_DATA, calculateWithGst } from './PriceListView';
import { deduplicateProducts, safeFirestoreSet } from '../../lib/dataService';
import { useSharedMasterPricelist, useSharedSchemeDiscounts } from '../../lib/realtimeStore';
import { useBranding } from '../../lib/branding';
import { CustomDialogModal } from '../CustomDialogModal';
import jsPDF from 'jspdf';
import html2canvas from 'html2canvas-pro';
import { 
  Gift, 
  Search, 
  Save, 
  Printer, 
  Download, 
  CheckCircle2, 
  Loader2, 
  RotateCcw
} from 'lucide-react';

interface Props {
  profile: UserProfile;
  lang?: Language;
}

/**
 * Standard Billing Discount Rule by Company Policy:
 * - Group A (Water Soluble Fertilizers): 0%
 * - Specialty Grades: 0%
 * - Group B (Micronutrients): 10%
 * - Group C (Plant Growth Regulators / PGR): 20%
 */
export const getStandardBillingDiscount = (groupName: string): number => {
  const g = (groupName || '').toLowerCase().trim();
  if (g.includes('specialty') || g.includes('speciality') || g.includes('स्पेशालिटी')) return 0;
  if (g.includes('group a') || g.includes('group-a') || g.includes('water soluble')) return 0;
  if (
    g.includes('group b') ||
    g.includes('group-b') ||
    g.includes('b group') ||
    g.includes('b-group') ||
    g.includes('gr. b') ||
    g.includes('gr b') ||
    g === 'b' ||
    /^b\s*[-–:]/.test(g) ||
    g.includes('micronutrient') ||
    g.includes('micro') ||
    g.includes('ग्रुप ब') ||
    g.includes('गट ब')
  ) {
    return 10;
  }
  if (
    g.includes('group c') ||
    g.includes('group-c') ||
    g.includes('c group') ||
    g.includes('c-group') ||
    g.includes('gr. c') ||
    g.includes('gr c') ||
    g === 'c' ||
    /^c\s*[-–:]/.test(g) ||
    g.includes('growth regulator') ||
    g.includes('plant growth') ||
    g.includes('pgr') ||
    g.includes('stimulant') ||
    g.includes('ग्रुप क') ||
    g.includes('गट क')
  ) {
    return 20;
  }
  return 0;
};

const LOCAL_STORAGE_GROUP_DISCOUNTS_KEY = 'blackworm_scheme_extra_discounts_v5';

export const SchemeView: React.FC<Props> = ({ profile }) => {
  const userIsAdmin = isAdmin(profile);
  const printableRef = useRef<HTMLDivElement>(null);

  const { logoUrl, logoSize } = useBranding();
  const { products: sharedMasterProducts } = useSharedMasterPricelist();
  const { discounts: extraDiscounts, setDiscountsOptimistic } = useSharedSchemeDiscounts();

  const products = useMemo<DynamicPriceProduct[]>(() => {
    if (sharedMasterProducts && sharedMasterProducts.length > 0) {
      return deduplicateProducts(sharedMasterProducts);
    }
    return deduplicateProducts(
      OFFICIAL_REFERENCE_DATA.map((item, idx) => ({
        ...item,
        id: (item as any).id || `ref_${idx + 1}`,
      }))
    );
  }, [sharedMasterProducts]);

  const [searchQuery, setSearchQuery] = useState('');
  const [selectedGroup, setSelectedGroup] = useState<string>('ALL');
  const [saving, setSaving] = useState(false);
  const [showSuccessToast, setShowSuccessToast] = useState(false);
  const [isGeneratingPdf, setIsGeneratingPdf] = useState(false);

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

  // Get current extra scheme discount for a group (default 0%)
  const getGroupExtraDiscount = (groupName: string): number => {
    if (extraDiscounts[groupName] !== undefined) {
      return Number(extraDiscounts[groupName]) || 0;
    }
    return 0;
  };

  // Handle changing group extra discount
  const handleGroupDiscountChange = (groupName: string, valStr: string) => {
    const parsed = valStr === '' ? 0 : Math.max(0, Math.min(100, Number(valStr) || 0));
    setDiscountsOptimistic((prev) => ({
      ...prev,
      [groupName]: parsed,
    }));
  };

  // Save changes across Primary, Secondary & Local Vault
  const handleSaveDiscounts = async () => {
    setSaving(true);
    try {
      await safeFirestoreSet(
        'config',
        'schemes_extra_discounts',
        {
          discounts: extraDiscounts,
          updatedAt: new Date().toISOString(),
          updatedBy: profile.uid,
          updatedByName: profile.fullName || 'Admin',
        },
        { merge: true }
      );

      setShowSuccessToast(true);
      setTimeout(() => setShowSuccessToast(false), 3000);
    } catch (err) {
      console.error('Error saving scheme discounts:', err);
      setDialogConfig({
        isOpen: true,
        type: 'alert',
        title: 'Save Error',
        message: 'डिस्काउंट डेटा सेव्ह करताना त्रुटी आली. कृपया पुन्हा प्रयत्न करा.',
        confirmText: 'OK',
        onConfirm: () => setDialogConfig(prev => ({ ...prev, isOpen: false }))
      });
    } finally {
      setSaving(false);
    }
  };

  // Reset extra discounts to 0%
  const handleResetDefaults = () => {
    setDialogConfig({
      isOpen: true,
      type: 'confirm',
      title: 'Reset Scheme Discounts',
      message: 'सर्व ग्रुपचे एक्स्ट्रा स्कीम डिस्काउंट रिसेट करून ०% करायचे आहेत का?',
      confirmText: 'Reset',
      cancelText: 'Cancel',
      onConfirm: async () => {
        setDiscountsOptimistic(() => ({}));
        try {
          localStorage.removeItem(LOCAL_STORAGE_GROUP_DISCOUNTS_KEY);
          await safeFirestoreSet(
            'config',
            'schemes_extra_discounts',
            {
              discounts: {},
              updatedAt: new Date().toISOString(),
              updatedBy: profile.uid,
              updatedByName: profile.fullName || 'Admin',
            },
            { merge: false }
          );
        } catch (e) {}
        setDialogConfig(prev => ({ ...prev, isOpen: false }));
      },
      onCancel: () => setDialogConfig(prev => ({ ...prev, isOpen: false }))
    });
  };

  // PDF Export (Full width + clean multi-page A4 slicing without cutting rows or horizontal clipping)
  const handleDownloadPdf = async () => {
    if (!printableRef.current) return;
    let offscreenHost: HTMLDivElement | null = null;
    try {
      setIsGeneratingPdf(true);
      const sourceEl = printableRef.current;

      const CAPTURE_WIDTH = 920;
      const CONTENT_WIDTH_MM = 196; // 210mm A4 - 14mm horizontal margin
      const CONTENT_HEIGHT_MM = 283; // 297mm A4 - 14mm vertical margin
      const MAX_PAGE_HEIGHT_PX = Math.floor(CAPTURE_WIDTH * (CONTENT_HEIGHT_MM / CONTENT_WIDTH_MM));

      offscreenHost = document.createElement('div');
      offscreenHost.style.position = 'fixed';
      offscreenHost.style.left = '-99999px';
      offscreenHost.style.top = '0';
      offscreenHost.style.width = `${CAPTURE_WIDTH}px`;
      offscreenHost.style.backgroundColor = '#ffffff';
      offscreenHost.style.zIndex = '-1';
      offscreenHost.style.pointerEvents = 'none';

      const clone = sourceEl.cloneNode(true) as HTMLDivElement;
      clone.style.width = `${CAPTURE_WIDTH}px`;
      clone.style.maxWidth = `${CAPTURE_WIDTH}px`;
      clone.style.minWidth = `${CAPTURE_WIDTH}px`;
      clone.style.overflow = 'visible';
      clone.style.margin = '0';
      clone.style.padding = '24px';
      clone.style.border = 'none';
      clone.style.borderRadius = '0';
      clone.style.boxShadow = 'none';
      clone.style.boxSizing = 'border-box';
      clone.style.backgroundColor = '#ffffff';

      // Ensure desktop horizontal header layout even on mobile viewports
      const companyHeader = clone.querySelector('[data-scheme-company-header="true"]') as HTMLElement | null;
      if (companyHeader) {
        companyHeader.style.display = 'flex';
        companyHeader.style.flexDirection = 'row';
        companyHeader.style.alignItems = 'flex-start';
        companyHeader.style.justifyContent = 'space-between';
      }
      const companyText = clone.querySelector('[data-scheme-company-text="true"]') as HTMLElement | null;
      if (companyText) {
        companyText.style.textAlign = 'right';
      }

      // Unclip horizontal scroll containers inside the clone
      const scrollWrapper = clone.querySelector('[data-scheme-scroll="true"]') as HTMLElement | null;
      if (scrollWrapper) {
        scrollWrapper.style.overflow = 'visible';
        scrollWrapper.style.width = '100%';
      }
      const scrollInner = clone.querySelector('[data-scheme-scroll-inner="true"]') as HTMLElement | null;
      if (scrollInner) {
        scrollInner.style.minWidth = '100%';
        scrollInner.style.width = '100%';
      }

      // Replace number inputs with static text badges so html2canvas never clips input values
      const inputs = clone.querySelectorAll('input');
      inputs.forEach((input) => {
        const badge = document.createElement('span');
        badge.textContent = input.value || '0';
        badge.style.display = 'inline-block';
        badge.style.minWidth = '44px';
        badge.style.padding = '2px 8px';
        badge.style.backgroundColor = '#ffffff';
        badge.style.color = '#0f172a';
        badge.style.border = '1px solid #6ee7b7';
        badge.style.borderRadius = '4px';
        badge.style.fontWeight = '900';
        badge.style.fontSize = '12px';
        badge.style.textAlign = 'center';
        badge.style.fontFamily = 'ui-monospace, SFMono-Regular, Menlo, monospace';
        input.parentNode?.replaceChild(badge, input);
      });

      offscreenHost.appendChild(clone);
      document.body.appendChild(offscreenHost);

      // Wait for cloned images and layout frames to settle
      const imgs = Array.from(clone.querySelectorAll('img'));
      await Promise.all(
        imgs.map((img) => {
          if (img.complete) return Promise.resolve();
          return new Promise<void>((res) => {
            img.onload = () => res();
            img.onerror = () => res();
          });
        })
      );
      await new Promise<void>((res) => requestAnimationFrame(() => requestAnimationFrame(() => res())));

      const cloneRect = clone.getBoundingClientRect();
      const totalHeight = Math.ceil(clone.scrollHeight);

      // Collect safe vertical cut points (section tops, 2nd+ product starts so thead isn't orphaned, and signature footer)
      const breakSet = new Set<number>();
      clone.querySelectorAll('[data-scheme-section="true"]').forEach((sectionEl) => {
        const top = Math.floor(sectionEl.getBoundingClientRect().top - cloneRect.top) - 3;
        if (top > 20) breakSet.add(top);

        const productRows = sectionEl.querySelectorAll('tr[data-product-start="true"]');
        productRows.forEach((rowEl, rIdx) => {
          // Keep the 1st product attached to the group banner + table thead
          if (rIdx === 0) return;
          const rowTop = Math.floor(rowEl.getBoundingClientRect().top - cloneRect.top) - 1;
          if (rowTop > 20) breakSet.add(rowTop);
        });
      });

      const footerEl = clone.querySelector('[data-scheme-footer="true"]');
      if (footerEl) {
        const footerTop = Math.floor(footerEl.getBoundingClientRect().top - cloneRect.top) - 6;
        if (footerTop > 20) breakSet.add(footerTop);
      }

      const breakPoints = Array.from(breakSet).sort((a, b) => a - b);

      const slices: { startY: number; endY: number }[] = [];
      let currStart = 0;
      while (currStart < totalHeight - 2) {
        const maxEnd = currStart + MAX_PAGE_HEIGHT_PX;
        if (totalHeight <= maxEnd) {
          slices.push({ startY: currStart, endY: totalHeight });
          break;
        }
        let bestCut = -1;
        for (const bp of breakPoints) {
          if (bp > currStart + 100 && bp <= maxEnd) {
            bestCut = bp;
          }
        }
        if (bestCut === -1) {
          bestCut = Math.min(totalHeight, maxEnd);
        }
        slices.push({ startY: currStart, endY: bestCut });
        currStart = bestCut;
      }

      const captureScale = totalHeight > 6500 ? Math.max(1.25, Math.min(2, 13000 / totalHeight)) : 2;
      const canvas = await html2canvas(clone, {
        scale: captureScale,
        useCORS: true,
        allowTaint: false,
        backgroundColor: '#ffffff',
        width: CAPTURE_WIDTH,
        height: totalHeight,
        windowWidth: 1200,
        scrollX: 0,
        scrollY: 0,
        logging: false,
      });

      const scaleY = canvas.height / totalHeight;
      const pdf = new jsPDF({
        orientation: 'portrait',
        unit: 'mm',
        format: 'a4',
        compress: true,
      });

      slices.forEach((slice, idx) => {
        const srcY = Math.max(0, Math.round(slice.startY * scaleY));
        const srcH = Math.max(1, Math.min(canvas.height - srcY, Math.round((slice.endY - slice.startY) * scaleY)));

        const pageCanvas = document.createElement('canvas');
        pageCanvas.width = canvas.width;
        pageCanvas.height = srcH;
        const ctx = pageCanvas.getContext('2d');
        if (ctx) {
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, pageCanvas.width, pageCanvas.height);
          ctx.drawImage(canvas, 0, srcY, canvas.width, srcH, 0, 0, canvas.width, srcH);
        }

        const sliceImgData = pageCanvas.toDataURL('image/jpeg', 0.95);
        const sliceHeightMm = (srcH * CONTENT_WIDTH_MM) / canvas.width;

        if (idx > 0) pdf.addPage();
        pdf.addImage(sliceImgData, 'JPEG', 7, 7, CONTENT_WIDTH_MM, sliceHeightMm);
      });

      const groupSlugMap: Record<string, string> = {
        ALL: 'All_Groups',
        GROUP_A: 'Group_A',
        SPECIALTY: 'Specialty',
        GROUP_B: 'Group_B',
        GROUP_C: 'Group_C',
      };
      const fileSuffix = groupSlugMap[selectedGroup] || 'All_Groups';
      pdf.save(`Blackworm_Schemes_${fileSuffix}.pdf`);
    } catch (err) {
      console.error('PDF error:', err);
    } finally {
      if (offscreenHost && offscreenHost.parentNode) {
        offscreenHost.parentNode.removeChild(offscreenHost);
      }
      setIsGeneratingPdf(false);
    }
  };

  const handlePrint = () => {
    window.print();
  };

  // Grouping products
  const groupedProducts = useMemo(() => {
    const queryLower = searchQuery.trim().toLowerCase();
    const map = new Map<string, DynamicPriceProduct[]>();

    products.forEach((p) => {
      // Group Filter
      if (selectedGroup !== 'ALL') {
        const gName = (p.groupName || '').toLowerCase();
        if (selectedGroup === 'GROUP_A' && !gName.includes('group a')) return;
        if (selectedGroup === 'SPECIALTY' && !gName.includes('specialty')) return;
        if (selectedGroup === 'GROUP_B' && !gName.includes('group b')) return;
        if (selectedGroup === 'GROUP_C' && !gName.includes('group c')) return;
      }

      // Search Query Filter
      if (queryLower) {
        const match = 
          (p.brandName || '').toLowerCase().includes(queryLower) ||
          (p.gradeName || '').toLowerCase().includes(queryLower) ||
          (p.code || '').toLowerCase().includes(queryLower) ||
          (p.groupName || '').toLowerCase().includes(queryLower);
        if (!match) return;
      }

      const g = p.groupName || 'Other Products';
      if (!map.has(g)) map.set(g, []);
      map.get(g)!.push(p);
    });

    return Array.from(map.entries()).map(([groupName, items]) => ({
      groupName,
      items,
      billingDiscount: getStandardBillingDiscount(groupName),
      extraDiscount: getGroupExtraDiscount(groupName),
    }));
  }, [products, searchQuery, selectedGroup, extraDiscounts]);

  return (
    <div className="space-y-4 pb-20 max-w-5xl mx-auto w-full">
      {/* Top Controls Toolbar - Strictly "Schemes" only */}
      <div className="bg-white p-3 sm:p-4 rounded-2xl border border-slate-200 shadow-xs flex flex-wrap items-center justify-between gap-3 print:hidden">
        <div className="flex items-center gap-2">
          <div className="w-9 h-9 rounded-xl bg-fuchsia-100 flex items-center justify-center text-fuchsia-700">
            <Gift className="w-5 h-5" />
          </div>
          <h2 className="text-lg sm:text-xl font-black text-slate-900 tracking-tight leading-tight">
            Schemes
          </h2>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {/* Search Input */}
          <div className="relative min-w-[150px] sm:min-w-[190px]">
            <Search className="w-3.5 h-3.5 absolute left-3 top-2.5 text-slate-400 pointer-events-none" />
            <input
              type="text"
              placeholder="Search product..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-8 pr-3 py-1.5 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold focus:outline-none focus:ring-2 focus:ring-fuchsia-500"
            />
          </div>

          {/* Group Filter Tabs */}
          <select
            value={selectedGroup}
            onChange={(e) => setSelectedGroup(e.target.value)}
            className="px-2.5 py-1.5 bg-slate-50 border border-slate-200 rounded-xl text-xs font-bold focus:outline-none focus:ring-2 focus:ring-fuchsia-500 cursor-pointer"
          >
            <option value="ALL">All Groups</option>
            <option value="GROUP_A">Group A</option>
            <option value="SPECIALTY">Specialty</option>
            <option value="GROUP_B">Group B</option>
            <option value="GROUP_C">Group C</option>
          </select>

          {/* Save Button for Admins */}
          {userIsAdmin && (
            <button
              onClick={handleSaveDiscounts}
              disabled={saving}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-fuchsia-600 hover:bg-fuchsia-700 text-white rounded-xl text-xs font-black shadow-xs transition active:scale-95 cursor-pointer disabled:opacity-50"
              title="Save scheme discounts"
            >
              {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
              <span>Save</span>
            </button>
          )}

          {/* Reset Defaults Button for Admins */}
          {userIsAdmin && (
            <button
              onClick={handleResetDefaults}
              className="p-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl text-xs font-bold transition cursor-pointer"
              title="Reset extra discounts to 0%"
            >
              <RotateCcw className="w-3.5 h-3.5" />
            </button>
          )}

          {/* PDF Download */}
          <button
            onClick={handleDownloadPdf}
            disabled={isGeneratingPdf}
            className="flex items-center gap-1.5 px-2.5 py-1.5 bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 rounded-xl text-xs font-bold transition cursor-pointer active:scale-95"
            title="Download Schemes as PDF"
          >
            {isGeneratingPdf ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
            <span className="hidden sm:inline">PDF</span>
          </button>

          {/* Print Button */}
          <button
            onClick={handlePrint}
            className="flex items-center gap-1.5 px-2.5 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-800 rounded-xl text-xs font-bold transition cursor-pointer active:scale-95"
            title="Print Schemes"
          >
            <Printer className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Print</span>
          </button>
        </div>
      </div>

      {/* Success Toast Notification */}
      {showSuccessToast && (
        <div className="bg-emerald-50 border border-emerald-300 text-emerald-800 px-4 py-2.5 rounded-xl text-xs font-bold flex items-center justify-between shadow-xs animate-in fade-in">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
            <span>स्कीम डिस्काउंट यशस्वीरीत्या सेव्ह झाले आहेत! (Saved successfully)</span>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* THE OFFICIAL SCHEMES SHEET WITH UNIFIED CONTINUOUS HORIZONTAL SCROLL      */}
      {/* ========================================================================= */}
      <div 
        ref={printableRef}
        className="bg-white p-4 sm:p-7 rounded-2xl border border-slate-300 shadow-sm print:border-none print:shadow-none print:p-0 print:overflow-visible max-w-5xl mx-auto overflow-hidden"
      >
        {/* Top Header: !! Shri !! */}
        <div className="text-center mb-1">
          <span className="text-xs sm:text-sm italic font-serif text-black font-semibold">
            !! Shri !!
          </span>
        </div>

        {/* Company Header: Logo Left, Full Company Details Right */}
        <div
          data-scheme-company-header="true"
          className="flex flex-col sm:flex-row items-center sm:items-start justify-between gap-4 pb-4 border-b border-slate-200"
        >
          {/* Logo Left */}
          <div className="shrink-0 flex items-center justify-center">
            {logoUrl ? (
              <img 
                src={logoUrl} 
                alt="Blackworm Agritech" 
                style={{ width: `${logoSize * 1.5}px` }} 
                className="object-contain max-h-24" 
              />
            ) : (
              <div className="flex items-center gap-2">
                <div className="w-16 h-16 bg-rose-50 border border-rose-200 rounded-xl flex items-center justify-center">
                  <span className="text-xl font-black text-rose-600">BA</span>
                </div>
                <div className="flex flex-col">
                  <span className="text-lg font-black tracking-tighter text-rose-600">BLACKWORM</span>
                  <span className="text-[9px] text-slate-500 font-bold">Agriculture with new perspective</span>
                </div>
              </div>
            )}
          </div>

          {/* Company Text Right */}
          <div
            data-scheme-company-text="true"
            className="text-center sm:text-right flex-1 min-w-0"
          >
            <h1 className="text-xl sm:text-2xl font-black text-black tracking-tight uppercase leading-tight font-sans">
              BLACKWORM AGRITECH PVT LTD
            </h1>
            <p className="text-[11px] sm:text-xs font-bold text-black mt-0.5 leading-snug">
              CIN : U01409PN2022PTC217246, GST No. 27AALCB3069J1ZC
            </p>
            <p className="text-[10px] sm:text-[11px] font-medium text-black leading-snug">
              Address - Gat No. 17 Vijaynagar (Mhaisal), Tal - Miraj, Dist - Sangli.416409.
            </p>
            <p className="text-[10px] sm:text-[11px] font-medium text-black leading-snug">
              Ph : <span className="font-bold">+91 7798716201</span>, E-Mail : <span className="underline text-blue-700">blackwormagritechpvtltd@gmail.com</span>
            </p>
          </div>
        </div>

        {/* Clean Schemes Header Title */}
        <div className="text-center my-3">
          <span className="text-xs sm:text-sm font-black text-fuchsia-900 tracking-wider bg-fuchsia-50 px-5 py-1.5 rounded-full border border-fuchsia-200 inline-block uppercase">
            Schemes
          </span>
        </div>

        {/* ========================================================================= */}
        {/* UNIFIED HORIZONTAL SCROLL WRAPPER                                         */}
        {/* Group Headings and Product Tables scroll together seamlessly!             */}
        {/* ========================================================================= */}
        <div 
          data-scheme-scroll="true"
          className="overflow-x-auto print:overflow-visible w-full scroll-smooth"
          style={{ WebkitOverflowScrolling: 'touch' }}
        >
          <div data-scheme-scroll-inner="true" className="min-w-[650px] print:min-w-full space-y-6 mt-4">
            {groupedProducts.map((section) => {
              const billingDisc = section.billingDiscount;
              const extraDisc = section.extraDiscount;

              return (
                <div
                  key={section.groupName}
                  data-scheme-section="true"
                  className="border-2 border-black rounded-lg overflow-hidden"
                >
                  {/* Category Header Row - Inside the scroll container so it moves together */}
                  <div className="bg-emerald-800 text-white p-2.5 px-3 flex items-center justify-between gap-3 border-b-2 border-black">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className="text-xs sm:text-sm font-black uppercase tracking-tight text-white">
                        {section.groupName}
                      </h3>
                      <span className="text-[10px] font-bold text-emerald-200">
                        ({section.items.length} Products)
                      </span>
                    </div>

                    {/* Single Interactive Extra Scheme Discount Box for this group */}
                    <div className="flex items-center gap-2 shrink-0 bg-emerald-950/70 px-3 py-1 rounded-lg border border-emerald-600 shadow-xs">
                      <label className="text-[11px] sm:text-xs font-black uppercase text-emerald-100 whitespace-nowrap">
                        Discount:
                      </label>
                      <div className="flex items-center gap-1">
                        <input
                          type="number"
                          min="0"
                          max="100"
                          step="1"
                          value={extraDisc}
                          onChange={(e) => handleGroupDiscountChange(section.groupName, e.target.value)}
                          className="w-14 sm:w-16 text-center font-black font-mono py-1 px-1.5 bg-white border border-emerald-300 rounded text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-amber-400 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                        />
                        <span className="font-black text-white text-xs">%</span>
                      </div>
                    </div>
                  </div>

                  {/* 5-Column Clean Table: Sr. No, Product Name, Packing Size, With GST Rate, Scheme Rate */}
                  <table className="w-full border-collapse text-xs font-sans">
                    <thead className="bg-slate-100 text-black font-black border-b-2 border-black">
                      <tr className="text-center">
                        <th className="border-r border-black py-2.5 px-2 text-center w-14 whitespace-nowrap bg-slate-50">
                          Sr. No.
                        </th>
                        <th className="border-r border-black py-2.5 px-3 text-center w-64 bg-slate-50">
                          Product Name & Grade
                        </th>
                        <th className="border-r border-black py-2.5 px-2 text-center w-28 whitespace-nowrap bg-amber-50/50">
                          Packing Size
                        </th>
                        <th className="border-r border-black py-2.5 px-3 text-center w-36 whitespace-nowrap bg-slate-50">
                          With GST Rate
                        </th>
                        <th className="py-2.5 px-3 text-center w-40 whitespace-nowrap bg-emerald-50 text-emerald-950">
                          Scheme Rate (With GST)
                        </th>
                      </tr>
                    </thead>

                    <tbody className="text-black font-bold">
                      {section.items.map((prod) => {
                        const packings = prod.packings && prod.packings.length > 0
                          ? prod.packings
                          : [{ packingSize: '25 Kg', rate: 0, mrp: 0 }];
                        const rowCount = packings.length;

                        return packings.map((pk, pkIdx) => {
                          const isLastSubRow = pkIdx === rowCount - 1;

                          // 1. Base Rate with GST (before any discount)
                          const baseWithGst = calculateWithGst(pk.rate, prod.gstRate);

                          // 2. Rate With GST after Standard Billing Discount (A:0%, S:0%, B:10%, C:20%)
                          const withGstRate = Math.round(baseWithGst * (1 - (billingDisc / 100)) * 100) / 100;

                          // 3. Final Scheme Rate With GST after applying Extra Scheme Discount
                          const finalSchemeWithGst = Math.round(withGstRate * (1 - (extraDisc / 100)) * 100) / 100;

                          return (
                            <tr
                              key={`${prod.id}_${pk.packingSize}`}
                              data-product-start={pkIdx === 0 ? 'true' : undefined}
                              className={`border-black ${isLastSubRow ? 'border-b-2' : 'border-b'} hover:bg-slate-50/60 transition-colors print:break-inside-avoid`}
                            >
                              {/* 1. Sr No (Span across all packing sub-rows) */}
                              {pkIdx === 0 && (
                                <td 
                                  rowSpan={rowCount}
                                  className="border-r border-black p-2 text-center align-middle font-mono font-black bg-slate-50/40"
                                >
                                  {prod.code}
                                </td>
                              )}

                              {/* 2. Product Name & Grade (Spans across all packings - exactly matches Price List) */}
                              {pkIdx === 0 && (
                                <td 
                                  rowSpan={rowCount}
                                  className="border-r border-black py-2 px-3 text-center align-middle bg-white"
                                >
                                  <div className="flex flex-col items-center justify-center leading-tight">
                                    {prod.brandName && (
                                      <span className="text-[11px] font-bold text-amber-700 font-sans tracking-tight">
                                        {prod.brandName}
                                      </span>
                                    )}
                                    <span className="text-xs sm:text-[13px] font-black text-sky-700 font-sans tracking-tight">
                                      {prod.gradeName}
                                    </span>
                                  </div>
                                </td>
                              )}

                              {/* 3. Packing Size */}
                              <td className="border-r border-black p-2 text-center align-middle whitespace-nowrap font-black bg-amber-50/30 text-amber-950">
                                {pk.packingSize}
                              </td>

                              {/* 4. With GST Rate (Clean amount with billing discount applied: A=0%, S=0%, B=10%, C=20%, without any badge text) */}
                              <td className="border-r border-black p-2 text-center align-middle whitespace-nowrap bg-slate-50/60 font-mono">
                                <span className="text-slate-900 font-black text-xs sm:text-[13px]">
                                  ₹{(Number(withGstRate) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                </span>
                              </td>

                              {/* 5. Scheme Rate (With GST) (Calculated price after extra scheme discount) */}
                              <td className="p-2 text-center align-middle whitespace-nowrap bg-emerald-50/40 font-mono">
                                <div className="flex flex-col items-center justify-center">
                                  <span className="text-emerald-950 font-black text-xs sm:text-[13px]">
                                    ₹{(Number(finalSchemeWithGst) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                  </span>
                                  {extraDisc > 0 && (
                                    <div className="flex items-center gap-1 mt-0.5">
                                      <span className="text-[10px] text-slate-400 line-through">
                                        ₹{(Number(withGstRate) || 0).toFixed(2)}
                                      </span>
                                      <span className="text-[9px] font-black text-rose-600 bg-rose-50 px-1 rounded">
                                        -{extraDisc}%
                                      </span>
                                    </div>
                                  )}
                                </div>
                              </td>
                            </tr>
                          );
                        });
                      })}
                    </tbody>
                  </table>
                </div>
              );
            })}

            {groupedProducts.length === 0 && (
              <div className="text-center py-12 text-slate-400 font-bold text-xs">
                No products found matching the criteria.
              </div>
            )}
          </div>
        </div>

        {/* Footer Signatures */}
        <div
          data-scheme-footer="true"
          className="mt-8 pt-4 border-t border-slate-300 flex justify-between items-end print:break-inside-avoid"
        >
          <div className="text-center w-36 sm:w-44">
            <div className="h-7 border-b-2 border-slate-400 mb-1"></div>
            <p className="text-[10px] sm:text-[11px] font-black uppercase text-slate-500">Sales Manager Signature</p>
          </div>
          <div className="text-center w-36 sm:w-44">
            <div className="h-7 border-b-2 border-slate-400 mb-1"></div>
            <p className="text-[10px] sm:text-[11px] font-black uppercase text-slate-500">Authorized Signatory</p>
          </div>
        </div>
      </div>

      <CustomDialogModal
        isOpen={dialogConfig.isOpen}
        type={dialogConfig.type}
        title={dialogConfig.title}
        message={dialogConfig.message}
        confirmText={dialogConfig.confirmText}
        cancelText={dialogConfig.cancelText}
        onConfirm={dialogConfig.onConfirm}
        onCancel={dialogConfig.onCancel}
      />
    </div>
  );
};
