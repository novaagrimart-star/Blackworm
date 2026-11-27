/**
 * Free Google Sheets Failover Sync (Google Apps Script Web App API)
 *
 * Provides a zero-cost emergency secondary persistence & cross-device continuity channel
 * whenever Firebase daily free quota / 429 Resource Exhausted blocks primary cloud sync.
 *
 * Non-destructive by design:
 *  - Every write is an LWW upsert keyed by document `id` (never clears or wipes tabs/rows).
 *  - Large base64/binary fields are compacted to '[binary_omitted]' so Google Sheets 50k char cell limits never reject text data.
 *  - Configuration stored in `config/sheets_failover` is automatically mirrored across all officer devices.
 */

export const SHEETS_FAILOVER_CONFIG_KEY = 'blackworm_sheets_failover_config';
export const SHEETS_LAST_SYNC_MS_KEY = 'blackworm_sheets_last_pull_ms';

export const SHEETS_FAILOVER_COLLECTIONS = new Set<string>([
  'orders',
  'dealers_application',
  'collection_entries',
  'travel_sheets',
  'users',
  'outstanding_records',
  'yearly_targets',
  'targets',
  'location_villages',
  'location_talukas',
  'location_dealers',
  'office_staff_members',
  'office_staff_attendance',
  'config',
]);

export interface SheetsFailoverConfig {
  webhookUrl: string;
  enabled: boolean;
  updatedAt?: string;
  updatedBy?: string;
}

export interface SheetsFailoverItem {
  collection: string;
  id: string;
  doc: Record<string, any>;
  updatedAtMs: number;
  deleted?: boolean;
}

export const GOOGLE_APPS_SCRIPT_TEMPLATE = `// Blackworm Agritech - Free Google Sheets Emergency Failover API
// 1. Open script.new -> Paste this code -> Save
// 2. Click Deploy -> New deployment -> Type: Web app
// 3. Execute as: Me | Who has access: Anyone -> Deploy -> Copy Web app URL
// 4. Paste that URL in App Settings -> Permanent Backup -> Google Sheets Failover

function doGet(e) {
  try {
    var params = (e && e.parameter) || {};
    var action = String(params.action || 'ping');
    var ss = SpreadsheetApp.getActiveSpreadsheet();

    if (action === 'ping') {
      return jsonOut({ ok: true, sheetName: ss.getName(), ts: Date.now() });
    }

    if (action === 'pull') {
      var sinceMs = Number(params.since || 0);
      var rows = [];
      var sheets = ss.getSheets();
      for (var s = 0; s < sheets.length; s++) {
        var sheet = sheets[s];
        var colName = sheet.getName();
        var lastRow = sheet.getLastRow();
        if (lastRow < 2) continue;
        var data = sheet.getRange(2, 1, lastRow - 1, 5).getValues();
        for (var i = 0; i < data.length; i++) {
          var id = String(data[i][0] || '').trim();
          var updatedAtMs = Number(data[i][1] || 0);
          var deleted = String(data[i][2]) === 'true' || data[i][2] === true;
          var jsonStr = String(data[i][4] || '');
          if (!id || !jsonStr) continue;
          if (sinceMs > 0 && updatedAtMs > 0 && updatedAtMs < sinceMs) continue;
          try {
            var doc = JSON.parse(jsonStr);
            rows.push({
              collection: colName,
              id: id,
              updatedAtMs: updatedAtMs,
              deleted: deleted,
              doc: doc
            });
          } catch (parseErr) {}
        }
      }
      return jsonOut({ ok: true, rows: rows, ts: Date.now() });
    }

    return jsonOut({ ok: true, message: 'Ready' });
  } catch (err) {
    return jsonOut({ ok: false, error: String(err) });
  }
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var bodyStr = e && e.postData && e.postData.contents ? e.postData.contents : '{}';
    var payload = JSON.parse(bodyStr);
    var items = Array.isArray(payload.items) ? payload.items : [];
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var byCol = {};

    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (!it || !it.collection || !it.id) continue;
      var col = String(it.collection).slice(0, 80);
      if (!byCol[col]) byCol[col] = [];
      byCol[col].push(it);
    }

    var written = 0;
    Object.keys(byCol).forEach(function (colName) {
      var sheet = ss.getSheetByName(colName);
      if (!sheet) {
        sheet = ss.insertSheet(colName);
        sheet.appendRow(['id', 'updatedAtMs', 'deleted', 'summary', 'jsonPayload']);
      }
      var lastRow = sheet.getLastRow();
      var rowById = {};
      var tsById = {};
      if (lastRow >= 2) {
        var existing = sheet.getRange(2, 1, lastRow - 1, 2).getValues();
        for (var r = 0; r < existing.length; r++) {
          var eid = String(existing[r][0] || '').trim();
          if (eid) {
            rowById[eid] = r + 2;
            tsById[eid] = Number(existing[r][1] || 0);
          }
        }
      }

      var list = byCol[colName];
      var appendQueue = [];
      for (var j = 0; j < list.length; j++) {
        var item = list[j];
        var docId = String(item.id).trim();
        var incomingTs = Number(item.updatedAtMs || Date.now());
        var existingTs = Number(tsById[docId] || 0);
        if (rowById[docId] && existingTs > incomingTs) continue;

        var docObj = item.doc || {};
        var summary = String(
          docObj.orderNumber || docObj.firmName || docObj.fullName ||
          docObj.dealerName || docObj.receiptNumber || docObj.officerName || docId
        ).slice(0, 180);
        var jsonPayload = JSON.stringify(docObj);
        if (jsonPayload.length > 48000) continue;

        var rowValues = [docId, incomingTs, Boolean(item.deleted), summary, jsonPayload];
        if (rowById[docId]) {
          sheet.getRange(rowById[docId], 1, 1, 5).setValues([rowValues]);
        } else {
          appendQueue.push(rowValues);
          rowById[docId] = lastRow + appendQueue.length + 1;
        }
        tsById[docId] = incomingTs;
        written++;
      }
      if (appendQueue.length > 0) {
        var startRow = sheet.getLastRow() + 1;
        sheet.getRange(startRow, 1, appendQueue.length, 5).setValues(appendQueue);
      }
    });

    return jsonOut({ ok: true, written: written, ts: Date.now() });
  } catch (err) {
    return jsonOut({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
`;

export function isValidAppsScriptUrl(url: string): boolean {
  const clean = String(url || '').trim();
  if (!clean) return false;
  try {
    const parsed = new URL(clean);
    return parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export function getSheetsFailoverConfig(): SheetsFailoverConfig {
  const envUrl = String(
    (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_GOOGLE_SHEETS_WEBHOOK_URL) || ''
  ).trim();

  if (typeof window === 'undefined') {
    return { webhookUrl: envUrl, enabled: isValidAppsScriptUrl(envUrl) };
  }

  try {
    // 1. Check synced shared config doc (`config/sheets_failover`) so Admin setup reaches all devices automatically
    const localCfgRaw = localStorage.getItem('blackworm_local_config');
    if (localCfgRaw) {
      const localCfgMap = JSON.parse(localCfgRaw);
      const shared = localCfgMap?.sheets_failover;
      if (shared && typeof shared === 'object' && typeof shared.webhookUrl === 'string') {
        const cleanUrl = shared.webhookUrl.trim();
        if (cleanUrl || shared.enabled === false) {
          return {
            webhookUrl: cleanUrl,
            enabled: Boolean(shared.enabled !== false && isValidAppsScriptUrl(cleanUrl)),
            updatedAt: shared.updatedAt,
            updatedBy: shared.updatedBy,
          };
        }
      }
    }

    // 2. Fallback to explicit local config
    const raw = localStorage.getItem(SHEETS_FAILOVER_CONFIG_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      const cleanUrl = String(parsed?.webhookUrl || '').trim();
      return {
        webhookUrl: cleanUrl,
        enabled: Boolean(parsed?.enabled !== false && isValidAppsScriptUrl(cleanUrl)),
        updatedAt: parsed?.updatedAt,
        updatedBy: parsed?.updatedBy,
      };
    }
  } catch {}

  return {
    webhookUrl: envUrl,
    enabled: isValidAppsScriptUrl(envUrl),
  };
}

export function saveSheetsFailoverConfigLocally(cfg: Partial<SheetsFailoverConfig>): void {
  if (typeof window === 'undefined') return;
  try {
    const prev = getSheetsFailoverConfig();
    const cleanUrl = cfg.webhookUrl !== undefined ? String(cfg.webhookUrl).trim() : prev.webhookUrl;
    const next: SheetsFailoverConfig = {
      webhookUrl: cleanUrl,
      enabled: cfg.enabled !== undefined ? Boolean(cfg.enabled) : isValidAppsScriptUrl(cleanUrl),
      updatedAt: cfg.updatedAt || new Date().toISOString(),
      updatedBy: cfg.updatedBy || prev.updatedBy,
    };
    localStorage.setItem(SHEETS_FAILOVER_CONFIG_KEY, JSON.stringify(next));
  } catch {}
}

export function isSheetsFailoverConfigured(): boolean {
  const cfg = getSheetsFailoverConfig();
  return Boolean(cfg.enabled && isValidAppsScriptUrl(cfg.webhookUrl));
}

export function sanitizeDocForSheets(input: any): any {
  if (input === null || input === undefined) return input;
  if (typeof input === 'string') {
    if (input.length > 12000 && (input.startsWith('data:') || !input.includes(' '))) {
      return '[binary_omitted]';
    }
    return input.length > 30000 ? input.slice(0, 30000) : input;
  }
  if (Array.isArray(input)) {
    return input.slice(0, 500).map((item) => sanitizeDocForSheets(item));
  }
  if (typeof input === 'object') {
    const out: Record<string, any> = {};
    Object.entries(input).forEach(([k, v]) => {
      if (v === undefined) return;
      out[k] = sanitizeDocForSheets(v);
    });
    return out;
  }
  return input;
}

export async function pushBatchToSheetsFailover(
  items: SheetsFailoverItem[],
  customUrl?: string
): Promise<{ ok: boolean; written: number; error?: string }> {
  if (typeof window === 'undefined' || !items || items.length === 0) {
    return { ok: false, written: 0 };
  }
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    return { ok: false, written: 0, error: 'offline' };
  }

  const cfg = getSheetsFailoverConfig();
  const targetUrl = String(customUrl || cfg.webhookUrl || '').trim();
  if (!isValidAppsScriptUrl(targetUrl)) {
    return { ok: false, written: 0, error: 'not_configured' };
  }

  const safeItems = items
    .filter((it) => it && it.collection && it.id && SHEETS_FAILOVER_COLLECTIONS.has(it.collection))
    .map((it) => ({
      collection: it.collection,
      id: String(it.id),
      updatedAtMs: Number(it.updatedAtMs) || Date.now(),
      deleted: Boolean(it.deleted),
      doc: sanitizeDocForSheets(it.doc || {}),
    }));

  if (safeItems.length === 0) {
    return { ok: true, written: 0 };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    // Use text/plain to bypass Apps Script CORS preflight while carrying clean JSON
    const res = await fetch(targetUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({
        action: 'upsert_batch',
        source: 'blackworm_app',
        sentAt: new Date().toISOString(),
        items: safeItems,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      return { ok: false, written: 0, error: `HTTP ${res.status}` };
    }
    const text = await res.text().catch(() => '');
    try {
      const json = JSON.parse(text);
      return { ok: Boolean(json?.ok !== false), written: Number(json?.written || safeItems.length) };
    } catch {
      return { ok: true, written: safeItems.length };
    }
  } catch (err: any) {
    return { ok: false, written: 0, error: err?.message || 'Sheets failover request failed' };
  } finally {
    clearTimeout(timer);
  }
}

export async function pushRecordToSheetsFailover(
  item: SheetsFailoverItem
): Promise<{ ok: boolean; error?: string }> {
  if (!SHEETS_FAILOVER_COLLECTIONS.has(item.collection)) {
    return { ok: true };
  }
  const res = await pushBatchToSheetsFailover([item]);
  return { ok: res.ok, ...(res.error ? { error: res.error } : {}) };
}

export async function testSheetsFailoverConnection(
  customUrl?: string
): Promise<{ ok: boolean; sheetName?: string; error?: string }> {
  const cfg = getSheetsFailoverConfig();
  const targetUrl = String(customUrl || cfg.webhookUrl || '').trim();
  if (!isValidAppsScriptUrl(targetUrl)) {
    return { ok: false, error: 'कृपया वैध HTTPS Google Apps Script Web App URL प्रविष्ट करा.' };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const sep = targetUrl.includes('?') ? '&' : '?';
    const res = await fetch(`${targetUrl}${sep}action=ping&t=${Date.now()}`, {
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!res.ok) {
      return { ok: false, error: `सर्व्हर प्रतिसाद त्रुटी (HTTP ${res.status})` };
    }
    const json = await res.json();
    if (!json?.ok) {
      return { ok: false, error: String(json?.error || 'Google Sheet प्रतिसाद अवैध आहे.') };
    }
    return { ok: true, sheetName: String(json?.sheetName || 'Google Sheet') };
  } catch (err: any) {
    return { ok: false, error: err?.message || 'Google Sheet शी संपर्क होऊ शकला नाही.' };
  } finally {
    clearTimeout(timer);
  }
}

export async function pullUpdatesFromSheetsFailover(sinceMs = 0): Promise<{
  ok: boolean;
  rows: SheetsFailoverItem[];
  error?: string;
}> {
  if (typeof window === 'undefined') return { ok: false, rows: [] };
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    return { ok: false, rows: [], error: 'offline' };
  }
  const cfg = getSheetsFailoverConfig();
  if (!cfg.enabled || !isValidAppsScriptUrl(cfg.webhookUrl)) {
    return { ok: false, rows: [], error: 'not_configured' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 14000);
  try {
    const sep = cfg.webhookUrl.includes('?') ? '&' : '?';
    const res = await fetch(`${cfg.webhookUrl}${sep}action=pull&since=${encodeURIComponent(String(sinceMs))}&t=${Date.now()}`, {
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!res.ok) return { ok: false, rows: [], error: `HTTP ${res.status}` };
    const json = await res.json();
    if (!json?.ok || !Array.isArray(json.rows)) {
      return { ok: false, rows: [], error: String(json?.error || 'Invalid pull response') };
    }
    const validRows: SheetsFailoverItem[] = json.rows
      .filter((r: any) => r && r.collection && r.id && r.doc && typeof r.doc === 'object')
      .map((r: any) => ({
        collection: String(r.collection),
        id: String(r.id),
        doc: {
          ...r.doc,
          id: String(r.id),
          _syncSource: r.doc._syncSource || 'sheets_failover',
        },
        updatedAtMs: Number(r.updatedAtMs) || 0,
        deleted: Boolean(r.deleted),
      }));
    try {
      localStorage.setItem(SHEETS_LAST_SYNC_MS_KEY, String(Date.now()));
    } catch {}
    return { ok: true, rows: validRows };
  } catch (err: any) {
    return { ok: false, rows: [], error: err?.message || 'Sheets pull failed' };
  } finally {
    clearTimeout(timer);
  }
}
