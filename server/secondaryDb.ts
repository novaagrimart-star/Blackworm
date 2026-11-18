import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Response } from 'express';

export interface SyncRecordPayload {
  collection: string;
  id: string;
  doc: Record<string, any>;
  updatedAtMs?: number;
  deleted?: boolean;
  merge?: boolean;
}

export interface SyncDeltaEvent {
  collection: string;
  id: string;
  doc: Record<string, any> | null;
  deleted: boolean;
  updatedAtMs: number;
  revision: number;
}

interface StoredRow {
  collection: string;
  id: string;
  data: string;
  updated_at_ms: number;
  deleted: number;
  revision: number;
}

const DATA_DIR = path.resolve(process.cwd(), 'data');
const DB_PATH = path.join(DATA_DIR, 'secondary_sync.sqlite');
const FALLBACK_JSON_PATH = path.join(DATA_DIR, 'secondary_sync_backup.json');
const CLOUD_CONFIG_PATH = path.join(DATA_DIR, 'cloud_mirror_config.json');

export type CloudMirrorType = 'none' | 'supabase' | 'relay' | 'peer';

export interface CloudMirrorConfig {
  type: CloudMirrorType;
  url: string;
  apiKey: string;
  updatedAt?: string;
}

function generateEpochId(): string {
  return `ep_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
}

function parseTs(val: any): number {
  if (typeof val === 'number' && Number.isFinite(val)) return val;
  if (typeof val === 'string' && val.trim()) {
    const parsed = Date.parse(val);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

export const ALLOWED_SYNC_COLLECTIONS = new Set<string>([
  'users',
  'location_villages',
  'location_talukas',
  'dealers_application',
  'dealers',
  'outstanding_records',
  'orders',
  'collection_entries',
  'targets',
  'yearly_targets',
  'travel_sheets',
  'travel_records',
  'products_pricelist_v2',
  'products',
  'schemes',
  'config',
  'audit_logs',
  'deleted_records',
  'user_approval_requests',
  'pricelist_backups',
  'office_staff_members',
  'office_staff_attendance',
  'test',
]);

export function isValidSyncCollection(col: string): boolean {
  return ALLOWED_SYNC_COLLECTIONS.has(String(col || '').trim());
}

export function isValidSyncDocId(id: string): boolean {
  const s = String(id || '').trim();
  return s.length >= 1 && s.length <= 180 && !s.includes('..') && !/[\/\\]/.test(s);
}

function sanitizeDocPayload(val: any, depth = 0): any {
  if (depth > 12 || val === null || val === undefined) return val;
  if (Array.isArray(val)) {
    return val.map((it) => sanitizeDocPayload(it, depth + 1));
  }
  if (typeof val === 'object') {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(val)) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
      if (v !== undefined) {
        out[k] = sanitizeDocPayload(v, depth + 1);
      }
    }
    return out;
  }
  return val;
}

export function isSafeRemoteUrl(rawUrl: string): boolean {
  if (!rawUrl) return true;
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    const host = u.hostname.toLowerCase();
    if (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '0.0.0.0' ||
      host === '::1' ||
      host === '169.254.169.254' ||
      host.endsWith('.internal') ||
      host.startsWith('169.254.')
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function timingSafeStringMatch(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

async function fetchWithTimeout(url: string, options: RequestInit = {}, timeoutMs = 6500): Promise<globalThis.Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Normalizes Appwrite document IDs cleanly (1..36 chars: [a-zA-Z0-9._-])
 */
function toAppwriteDocId(col: string, id: string): string {
  const raw = `${col}_${id}`;
  const clean = raw.replace(/[^a-zA-Z0-9._-]/g, '_');
  if (clean.length <= 36 && !clean.startsWith('.') && !clean.startsWith('_') && !clean.startsWith('-')) {
    return clean;
  }
  return `bw_${crypto.createHash('sha1').update(`${col}:::${id}`).digest('hex').slice(0, 32)}`;
}

/**
 * Multi-Database Fallback Chain Engine:
 *   Tier 0 (Live App Sync Server): Zero-config SQLite WAL + SSE + Auto-Poll across connected devices
 *   Backup 1: Supabase PostgreSQL REST (Read & Dual-Write Mirror)
 *   Backup 2: Appwrite Databases REST and/or MongoDB Atlas Data API (Read & Dual-Write Mirror)
 *   Backup 3 (Read Fallback): Google Sheets API v4 / Apps Script Relay & GitHub JSON
 *
 * Every tier uses isolated try-catch + timeout failover so hitting limits on any provider
 * automatically switches cleanly to the next tier without impacting UI or crashing writes.
 */
class SecondarySyncDatabase {
  private sqliteDb: any = null;
  private memoryStore = new Map<string, StoredRow>();
  private revisionCounter = 0;
  private serverEpoch = generateEpochId();
  private sseClients = new Set<Response>();

  // Backup 1: Supabase
  private supabaseUrl = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  private supabaseKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();

  // Backup 2A: Appwrite
  private appwriteEndpoint = (process.env.APPWRITE_ENDPOINT || '').trim().replace(/\/+$/, '');
  private appwriteProjectId = (process.env.APPWRITE_PROJECT_ID || '').trim();
  private appwriteApiKey = (process.env.APPWRITE_API_KEY || '').trim();
  private appwriteDatabaseId = (process.env.APPWRITE_DATABASE_ID || '').trim();
  private appwriteCollectionId = (process.env.APPWRITE_COLLECTION_ID || 'sync_records').trim();

  // Backup 2B: MongoDB Atlas Data API
  private mongoDataApiUrl = (process.env.MONGODB_DATA_API_URL || '').trim().replace(/\/+$/, '');
  private mongoDataApiKey = (process.env.MONGODB_DATA_API_KEY || '').trim();
  private mongoDataSource = (process.env.MONGODB_DATA_SOURCE || 'Cluster0').trim();
  private mongoDatabase = (process.env.MONGODB_DATABASE || 'blackworm_sync').trim();
  private mongoCollection = (process.env.MONGODB_COLLECTION || 'sync_records').trim();

  // Backup 3: Google Sheets API / Apps Script Relay / GitHub JSON / Peer Server
  private googleSheetsId = (process.env.GOOGLE_SHEETS_ID || '').trim();
  private googleSheetsApiKey = (process.env.GOOGLE_SHEETS_API_KEY || '').trim();
  private googleSheetsRange = (process.env.GOOGLE_SHEETS_RANGE || 'sync_records!A1:F5000').trim();
  private relayUrl = (process.env.GOOGLE_SHEETS_WEBHOOK_URL || process.env.CLOUD_SYNC_RELAY_URL || '').trim().replace(/\/+$/, '');
  private relayKey = (process.env.CLOUD_SYNC_RELAY_KEY || '').trim();
  private githubJsonUrl = (process.env.GITHUB_JSON_URL || '').trim();
  private githubToken = (process.env.GITHUB_TOKEN || '').trim();
  private peerUrl = (process.env.PEER_SYNC_URL || '').trim().replace(/\/+$/, '');
  private peerKey = (process.env.PEER_SYNC_KEY || '').trim();

  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private cloudRestoreInFlight: Promise<{ restored: number; sourceTier?: string; error?: string }> | null = null;
  private cloudSyncTimer: ReturnType<typeof setInterval> | null = null;
  private lastCloudPullMs = 0;
  private lastCloudSyncAtMs = 0;
  private lastCloudError = '';
  private lastActiveRestoreTier = 'sqlite-wal';
  private cloudMirroredCount = 0;

  constructor() {
    this.loadRuntimeCloudConfig();
    this.init();
    if (this.isAnyFallbackConfigured()) {
      void this.restoreFromCloudMirror(false).catch(() => {});
      this.ensureCloudSyncLoop();
    }
  }

  private loadRuntimeCloudConfig() {
    try {
      if (!fs.existsSync(CLOUD_CONFIG_PATH)) return;
      const raw = fs.readFileSync(CLOUD_CONFIG_PATH, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<CloudMirrorConfig>;
      if (parsed?.type === 'supabase' && parsed.url) {
        if (!this.supabaseUrl) this.supabaseUrl = String(parsed.url).trim().replace(/\/+$/, '');
        if (!this.supabaseKey && parsed.apiKey) this.supabaseKey = String(parsed.apiKey).trim();
      } else if (parsed?.type === 'relay' && parsed.url) {
        if (!this.relayUrl) {
          this.relayUrl = String(parsed.url).trim().replace(/\/+$/, '');
          this.relayKey = String(parsed.apiKey || '').trim();
        }
      } else if (parsed?.type === 'peer' && parsed.url) {
        if (!this.peerUrl) {
          this.peerUrl = String(parsed.url).trim().replace(/\/+$/, '');
          this.peerKey = String(parsed.apiKey || '').trim();
        }
      }
    } catch (e) {
      console.warn('[SecondaryDB] Runtime cloud config load notice:', e);
    }
  }

  private getTotalRecordsCount(): number {
    if (this.sqliteDb) {
      const row = this.sqliteDb.prepare('SELECT COUNT(*) AS cnt FROM sync_records').get();
      return Number(row?.cnt) || 0;
    }
    return this.memoryStore.size;
  }

  private keyOf(col: string, id: string): string {
    return `${col}:::${id}`;
  }

  private init() {
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
    } catch (e) {
      console.warn('[SecondaryDB] Could not create data dir:', e);
    }

    try {
      const sqliteMod = (globalThis as any).process?.getBuiltinModule?.('node:sqlite');
      if (sqliteMod && sqliteMod.DatabaseSync) {
        this.sqliteDb = new sqliteMod.DatabaseSync(DB_PATH);
        this.sqliteDb.exec(`
          PRAGMA journal_mode = WAL;
          PRAGMA synchronous = NORMAL;
          CREATE TABLE IF NOT EXISTS sync_records (
            collection TEXT NOT NULL,
            id TEXT NOT NULL,
            data TEXT NOT NULL,
            updated_at_ms INTEGER NOT NULL,
            deleted INTEGER NOT NULL DEFAULT 0,
            revision INTEGER NOT NULL DEFAULT 1,
            PRIMARY KEY (collection, id)
          );
          CREATE TABLE IF NOT EXISTS sync_meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_sync_col_updated ON sync_records (collection, updated_at_ms);
          CREATE INDEX IF NOT EXISTS idx_sync_updated ON sync_records (updated_at_ms);
          CREATE INDEX IF NOT EXISTS idx_sync_revision ON sync_records (revision);
        `);

        const epochRow = this.sqliteDb
          .prepare("SELECT value FROM sync_meta WHERE key = 'server_epoch'")
          .get() as { value?: string } | undefined;
        if (epochRow?.value) {
          this.serverEpoch = String(epochRow.value);
        } else {
          this.serverEpoch = generateEpochId();
          this.sqliteDb
            .prepare("INSERT OR REPLACE INTO sync_meta (key, value) VALUES ('server_epoch', ?)")
            .run(this.serverEpoch);
        }

        const maxRow = this.sqliteDb.prepare('SELECT COALESCE(MAX(revision), 0) AS maxRev FROM sync_records').get();
        this.revisionCounter = Number(maxRow?.maxRev) || 0;
        console.log(
          `[SecondaryDB] SQLite WAL initialized (${DB_PATH}), epoch=${this.serverEpoch}, max revision=${this.revisionCounter}, chain=[${this.getConfiguredTiersList().join(' -> ') || 'sqlite-only'}]`
        );
        return;
      }
    } catch (err) {
      console.warn('[SecondaryDB] node:sqlite fallback to atomic JSON WAL store:', err);
      this.sqliteDb = null;
    }

    // Fallback atomic JSON store load
    try {
      if (fs.existsSync(FALLBACK_JSON_PATH)) {
        const raw = fs.readFileSync(FALLBACK_JSON_PATH, 'utf-8');
        const parsed = JSON.parse(raw);
        if (parsed?.serverEpoch) {
          this.serverEpoch = String(parsed.serverEpoch);
        }
        if (Array.isArray(parsed?.rows)) {
          parsed.rows.forEach((r: StoredRow) => {
            this.memoryStore.set(this.keyOf(r.collection, r.id), r);
            if (r.revision > this.revisionCounter) this.revisionCounter = r.revision;
          });
        }
      }
    } catch (e) {
      console.warn('[SecondaryDB] Fallback file load notice:', e);
    }
  }

  private scheduleFallbackPersist() {
    if (this.sqliteDb) return;
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      try {
        const tmp = `${FALLBACK_JSON_PATH}.tmp`;
        fs.writeFileSync(
          tmp,
          JSON.stringify({
            serverEpoch: this.serverEpoch,
            rows: Array.from(this.memoryStore.values()),
          }),
          'utf-8'
        );
        fs.renameSync(tmp, FALLBACK_JSON_PATH);
      } catch (e) {
        console.warn('[SecondaryDB] Atomic persist notice:', e);
      }
    }, 300);
  }

  private ensureCloudSyncLoop() {
    if (this.cloudSyncTimer) return;
    // Periodically pull remote deltas every 15s along the fallback chain
    this.cloudSyncTimer = setInterval(() => {
      if (!this.isAnyFallbackConfigured()) return;
      void this.restoreFromCloudMirror(true).catch(() => {});
    }, 15000);
  }

  // Tier checks
  public isSupabaseEnabled(): boolean {
    return Boolean(this.supabaseUrl && this.supabaseKey);
  }

  public isAppwriteEnabled(): boolean {
    return Boolean(this.appwriteEndpoint && this.appwriteProjectId && this.appwriteApiKey && this.appwriteDatabaseId);
  }

  public isMongoEnabled(): boolean {
    return Boolean(this.mongoDataApiUrl && this.mongoDataApiKey);
  }

  public isGoogleSheetsReadEnabled(): boolean {
    return Boolean(this.googleSheetsId && this.googleSheetsApiKey);
  }

  public isRelayEnabled(): boolean {
    return Boolean(this.relayUrl);
  }

  public isGithubJsonEnabled(): boolean {
    return Boolean(this.githubJsonUrl);
  }

  public isPeerEnabled(): boolean {
    return Boolean(this.peerUrl);
  }

  public isAnyWritableMirrorEnabled(): boolean {
    return (
      this.isSupabaseEnabled() ||
      this.isAppwriteEnabled() ||
      this.isMongoEnabled() ||
      this.isRelayEnabled() ||
      this.isPeerEnabled()
    );
  }

  public isCloudMirrorEnabled(): boolean {
    return this.isAnyFallbackConfigured();
  }

  public isAnyFallbackConfigured(): boolean {
    return (
      this.isAnyWritableMirrorEnabled() ||
      this.isGoogleSheetsReadEnabled() ||
      this.isGithubJsonEnabled()
    );
  }

  public getConfiguredTiersList(): string[] {
    const tiers: string[] = [];
    if (this.isSupabaseEnabled()) tiers.push('backup1:supabase');
    if (this.isAppwriteEnabled()) tiers.push('backup2:appwrite');
    if (this.isMongoEnabled()) tiers.push('backup2:mongodb');
    if (this.isGoogleSheetsReadEnabled() || this.isRelayEnabled()) tiers.push('backup3:google-sheets');
    if (this.isGithubJsonEnabled()) tiers.push('backup3:github-json');
    if (this.isPeerEnabled()) tiers.push('peer');
    return tiers;
  }

  public getCloudConfigPublic() {
    const base = {
      lastCloudSyncAtMs: this.lastCloudSyncAtMs,
      lastCloudError: this.lastCloudError,
      cloudMirroredCount: this.cloudMirroredCount,
      configuredChain: this.getConfiguredTiersList(),
      activeRestoreTier: this.lastActiveRestoreTier,
    };
    if (this.isSupabaseEnabled()) {
      return { configured: true, type: 'supabase' as const, url: this.supabaseUrl, hasKey: true, ...base };
    }
    if (this.isRelayEnabled()) {
      return { configured: true, type: 'relay' as const, url: this.relayUrl, hasKey: Boolean(this.relayKey), ...base };
    }
    if (this.isPeerEnabled()) {
      return { configured: true, type: 'peer' as const, url: this.peerUrl, hasKey: Boolean(this.peerKey), ...base };
    }
    return {
      configured: this.isAnyFallbackConfigured(),
      type: 'none' as const,
      url: '',
      hasKey: false,
      ...base,
    };
  }

  public async setCloudConfig(cfg: CloudMirrorConfig): Promise<{ ok: boolean; restored?: number; pushed?: number; error?: string }> {
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
      const type: CloudMirrorType =
        cfg.type === 'supabase' || cfg.type === 'relay' || cfg.type === 'peer' ? cfg.type : 'none';
      const cleanUrl = String(cfg.url || '').trim().replace(/\/+$/, '');
      if (cleanUrl && !isSafeRemoteUrl(cleanUrl)) {
        return { ok: false, error: 'Invalid or restricted remote URL' };
      }
      const cleanKey = String(cfg.apiKey || '').trim();

      const saved: CloudMirrorConfig = {
        type,
        url: cleanUrl,
        apiKey: cleanKey,
        updatedAt: new Date().toISOString(),
      };
      fs.writeFileSync(CLOUD_CONFIG_PATH, JSON.stringify(saved, null, 2), 'utf-8');

      this.supabaseUrl = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
      this.supabaseKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
      this.relayUrl = (process.env.GOOGLE_SHEETS_WEBHOOK_URL || process.env.CLOUD_SYNC_RELAY_URL || '').trim().replace(/\/+$/, '');
      this.relayKey = (process.env.CLOUD_SYNC_RELAY_KEY || '').trim();
      this.peerUrl = (process.env.PEER_SYNC_URL || '').trim().replace(/\/+$/, '');
      this.peerKey = (process.env.PEER_SYNC_KEY || '').trim();
      this.lastCloudPullMs = 0;
      this.lastCloudError = '';

      if (type === 'supabase') {
        this.supabaseUrl = cleanUrl;
        if (cleanKey) this.supabaseKey = cleanKey;
      } else if (type === 'relay') {
        this.relayUrl = cleanUrl;
        this.relayKey = cleanKey;
      } else if (type === 'peer') {
        this.peerUrl = cleanUrl;
        this.peerKey = cleanKey;
      }

      if (this.isAnyFallbackConfigured()) {
        this.ensureCloudSyncLoop();
        const pushed = await this.pushAllLocalToCloudMirror();
        const res = await this.restoreFromCloudMirror(false);
        return { ok: true, restored: res.restored, pushed, ...(res.error ? { error: res.error } : {}) };
      }
      return { ok: true, restored: 0, pushed: 0 };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to save cloud mirror config' };
    }
  }

  public addSseClient(res: Response) {
    this.sseClients.add(res);
  }

  public removeSseClient(res: Response) {
    this.sseClients.delete(res);
  }

  private broadcastDelta(evt: SyncDeltaEvent) {
    if (this.sseClients.size === 0) return;
    const payload = `event: delta\ndata: ${JSON.stringify(evt)}\n\n`;
    for (const res of Array.from(this.sseClients)) {
      try {
        res.write(payload);
      } catch {
        this.sseClients.delete(res);
      }
    }
  }

  /**
   * Dual-Write Mirroring across writable backup tiers in parallel with full try-catch isolation:
   *   - Backup 1: Supabase
   *   - Backup 2A: Appwrite
   *   - Backup 2B: MongoDB Atlas Data API
   *   - Backup 3 (Writable Webhook/Relay): Google Apps Script / Sheet Webhook
   *   - Peer Sync Server
   */
  private async mirrorRowsToCloud(rows: StoredRow[]): Promise<number> {
    if (!this.isAnyWritableMirrorEnabled() || rows.length === 0) return 0;

    const payloadRows = rows.map((row) => {
      let parsedData: any = {};
      try {
        parsedData = JSON.parse(row.data);
      } catch {}
      return {
        collection: row.collection,
        id: row.id,
        data: parsedData,
        updated_at_ms: row.updated_at_ms,
        deleted: row.deleted === 1,
        revision: row.revision,
      };
    });

    const tasks: Array<Promise<number>> = [];

    // Backup 1: Supabase REST upsert
    if (this.isSupabaseEnabled()) {
      tasks.push(
        (async () => {
          let count = 0;
          try {
            const CHUNK = 150;
            for (let i = 0; i < payloadRows.length; i += CHUNK) {
              const slice = payloadRows.slice(i, i + CHUNK);
              const resp = await fetchWithTimeout(`${this.supabaseUrl}/rest/v1/sync_records`, {
                method: 'POST',
                headers: {
                  apikey: this.supabaseKey,
                  Authorization: `Bearer ${this.supabaseKey}`,
                  'Content-Type': 'application/json',
                  Prefer: 'resolution=merge-duplicates',
                },
                body: JSON.stringify(slice),
              });
              if (resp.ok) {
                count += slice.length;
                this.lastCloudSyncAtMs = Date.now();
              } else {
                this.lastCloudError = `Supabase write HTTP ${resp.status}`;
              }
            }
          } catch (e: any) {
            this.lastCloudError = e?.message || 'Supabase mirror failed';
          }
          return count;
        })()
      );
    }

    // Backup 2A: Appwrite Databases REST API
    if (this.isAppwriteEnabled()) {
      tasks.push(
        (async () => {
          let count = 0;
          try {
            const baseDocsUrl = `${this.appwriteEndpoint}/databases/${encodeURIComponent(this.appwriteDatabaseId)}/collections/${encodeURIComponent(this.appwriteCollectionId)}/documents`;
            const headers = {
              'X-Appwrite-Project': this.appwriteProjectId,
              'X-Appwrite-Key': this.appwriteApiKey,
              'Content-Type': 'application/json',
            };
            // Concurrency-bounded upserts (5 at a time)
            const CONCURRENCY = 5;
            for (let i = 0; i < payloadRows.length; i += CONCURRENCY) {
              const chunk = payloadRows.slice(i, i + CONCURRENCY);
              await Promise.all(
                chunk.map(async (r) => {
                  const docId = toAppwriteDocId(r.collection, r.id);
                  const docBody = {
                    collection: r.collection,
                    recordId: r.id,
                    dataJson: JSON.stringify(r.data),
                    updatedAtMs: r.updated_at_ms,
                    deleted: r.deleted,
                    revision: r.revision,
                  };
                  try {
                    const patchResp = await fetchWithTimeout(`${baseDocsUrl}/${encodeURIComponent(docId)}`, {
                      method: 'PATCH',
                      headers,
                      body: JSON.stringify({ data: docBody }),
                    });
                    if (patchResp.ok) {
                      count++;
                      return;
                    }
                    if (patchResp.status === 404) {
                      const createResp = await fetchWithTimeout(baseDocsUrl, {
                        method: 'POST',
                        headers,
                        body: JSON.stringify({ documentId: docId, data: docBody }),
                      });
                      if (createResp.ok) {
                        count++;
                      }
                    }
                  } catch {}
                })
              );
            }
            if (count > 0) this.lastCloudSyncAtMs = Date.now();
          } catch (e: any) {
            this.lastCloudError = e?.message || 'Appwrite mirror failed';
          }
          return count;
        })()
      );
    }

    // Backup 2B: MongoDB Atlas Data API
    if (this.isMongoEnabled()) {
      tasks.push(
        (async () => {
          let count = 0;
          try {
            const headers = {
              'api-key': this.mongoDataApiKey,
              'Content-Type': 'application/json',
            };
            const CONCURRENCY = 5;
            for (let i = 0; i < payloadRows.length; i += CONCURRENCY) {
              const chunk = payloadRows.slice(i, i + CONCURRENCY);
              await Promise.all(
                chunk.map(async (r) => {
                  try {
                    const resp = await fetchWithTimeout(`${this.mongoDataApiUrl}/action/updateOne`, {
                      method: 'POST',
                      headers,
                      body: JSON.stringify({
                        dataSource: this.mongoDataSource,
                        database: this.mongoDatabase,
                        collection: this.mongoCollection,
                        filter: { collection: r.collection, id: r.id },
                        update: {
                          $set: {
                            collection: r.collection,
                            id: r.id,
                            data: r.data,
                            updated_at_ms: r.updated_at_ms,
                            deleted: r.deleted,
                            revision: r.revision,
                          },
                        },
                        upsert: true,
                      }),
                    });
                    if (resp.ok) count++;
                  } catch {}
                })
              );
            }
            if (count > 0) this.lastCloudSyncAtMs = Date.now();
          } catch (e: any) {
            this.lastCloudError = e?.message || 'MongoDB Atlas mirror failed';
          }
          return count;
        })()
      );
    }

    // Backup 3 (Writable Relay / Google Apps Script Sheet Webhook)
    if (this.isRelayEnabled()) {
      tasks.push(
        (async () => {
          let count = 0;
          try {
            const headers: Record<string, string> = { 'Content-Type': 'application/json' };
            if (this.relayKey) headers['Authorization'] = `Bearer ${this.relayKey}`;
            const CHUNK = 150;
            for (let i = 0; i < payloadRows.length; i += CHUNK) {
              const slice = payloadRows.slice(i, i + CHUNK);
              const resp = await fetchWithTimeout(this.relayUrl, {
                method: 'POST',
                headers,
                body: JSON.stringify({ action: 'upsertBatch', key: this.relayKey || undefined, rows: slice }),
              });
              if (resp.ok) {
                count += slice.length;
                this.lastCloudSyncAtMs = Date.now();
              } else {
                this.lastCloudError = `Relay write HTTP ${resp.status}`;
              }
            }
          } catch (e: any) {
            this.lastCloudError = e?.message || 'Google Sheets/Relay mirror failed';
          }
          return count;
        })()
      );
    }

    // Peer Server Mirror
    if (this.isPeerEnabled()) {
      tasks.push(
        (async () => {
          let count = 0;
          try {
            const headers: Record<string, string> = { 'Content-Type': 'application/json' };
            if (this.peerKey) headers['Authorization'] = `Bearer ${this.peerKey}`;
            const batchItems: SyncRecordPayload[] = payloadRows.map((r) => ({
              collection: r.collection,
              id: r.id,
              doc: r.data,
              updatedAtMs: r.updated_at_ms,
              deleted: r.deleted,
              merge: true,
            }));
            const CHUNK = 150;
            for (let i = 0; i < batchItems.length; i += CHUNK) {
              const slice = batchItems.slice(i, i + CHUNK);
              const resp = await fetchWithTimeout(`${this.peerUrl}/api/sync/batch`, {
                method: 'POST',
                headers,
                body: JSON.stringify({ items: slice }),
              });
              if (resp.ok) {
                count += slice.length;
                this.lastCloudSyncAtMs = Date.now();
              } else {
                this.lastCloudError = `Peer write HTTP ${resp.status}`;
              }
            }
          } catch (e: any) {
            this.lastCloudError = e?.message || 'Peer mirror failed';
          }
          return count;
        })()
      );
    }

    const results = await Promise.allSettled(tasks);
    const maxPushed = results.reduce((acc, r) => (r.status === 'fulfilled' ? Math.max(acc, r.value) : acc), 0);
    if (maxPushed > 0) this.cloudMirroredCount += maxPushed;
    return maxPushed;
  }

  public async pushAllLocalToCloudMirror(): Promise<number> {
    if (!this.isAnyWritableMirrorEnabled()) return 0;
    const allRows: StoredRow[] = this.sqliteDb
      ? (this.sqliteDb.prepare('SELECT collection, id, data, updated_at_ms, deleted, revision FROM sync_records').all() as StoredRow[])
      : Array.from(this.memoryStore.values());
    if (allRows.length > 0) {
      return await this.mirrorRowsToCloud(allRows);
    }
    return 0;
  }

  /**
   * Parses generic Google Sheets API v4 rows OR GitHub JSON backup exports cleanly into SyncRecordPayload[]
   */
  private normalizeExternalRows(raw: any): SyncRecordPayload[] {
    const out: SyncRecordPayload[] = [];
    if (!raw) return out;

    // Case 1: Full backup format { collections: { users: [...], dealers_application: [...] } }
    if (raw.collections && typeof raw.collections === 'object' && !Array.isArray(raw.collections)) {
      for (const [colName, docs] of Object.entries(raw.collections)) {
        if (!Array.isArray(docs)) continue;
        docs.forEach((doc: any) => {
          if (!doc || typeof doc !== 'object') return;
          const docId = String(doc._id || doc.id || '').trim();
          if (!docId) return;
          const clean = { ...doc, id: docId };
          delete clean._id;
          out.push({
            collection: colName,
            id: docId,
            doc: clean,
            updatedAtMs: parseTs(clean._syncUpdatedAtMs || clean.updatedAt || clean.createdAt) || undefined,
            deleted: Boolean(clean.isArchived),
            merge: true,
          });
        });
      }
      return out;
    }

    // Case 2: Google Sheets API v4 values array: [[collection, id, data_json, updated_at_ms, deleted], ...]
    if (Array.isArray(raw.values)) {
      const rows: any[][] = raw.values;
      if (rows.length === 0) return out;
      const firstLower = rows[0].map((c) => String(c || '').trim().toLowerCase());
      const hasHeader = firstLower.includes('collection') || firstLower.includes('id') || firstLower.includes('data');
      const startIdx = hasHeader ? 1 : 0;
      const colIdx = hasHeader && firstLower.includes('collection') ? firstLower.indexOf('collection') : 0;
      const idIdx = hasHeader && firstLower.includes('id') ? firstLower.indexOf('id') : 1;
      const dataIdx = hasHeader && (firstLower.includes('data') || firstLower.includes('doc'))
        ? Math.max(firstLower.indexOf('data'), firstLower.indexOf('doc'))
        : 2;
      const tsIdx = hasHeader && firstLower.includes('updated_at_ms') ? firstLower.indexOf('updated_at_ms') : 3;
      const delIdx = hasHeader && firstLower.includes('deleted') ? firstLower.indexOf('deleted') : 4;

      for (let i = startIdx; i < rows.length; i++) {
        const r = rows[i];
        if (!Array.isArray(r)) continue;
        const collection = String(r[colIdx] || '').trim();
        const id = String(r[idIdx] || '').trim();
        if (!collection || !id) continue;
        let doc: Record<string, any> = {};
        const rawDoc = r[dataIdx];
        if (typeof rawDoc === 'string' && rawDoc.trim().startsWith('{')) {
          try {
            doc = JSON.parse(rawDoc);
          } catch {}
        } else if (rawDoc && typeof rawDoc === 'object') {
          doc = rawDoc;
        }
        const ts = Number(r[tsIdx]) || parseTs(doc._syncUpdatedAtMs || doc.updatedAt);
        const delVal = String(r[delIdx] || '').trim().toLowerCase();
        const deleted = delVal === 'true' || delVal === '1' || Boolean(doc.isArchived);
        out.push({
          collection,
          id,
          doc: { ...doc, id },
          updatedAtMs: ts || undefined,
          deleted,
          merge: true,
        });
      }
      return out;
    }

    // Case 3: Standard array or { rows: [...] } or { documents: [...] } (Supabase, Appwrite, Mongo, Relay, GitHub)
    const list: any[] = Array.isArray(raw)
      ? raw
      : Array.isArray(raw.rows)
        ? raw.rows
        : Array.isArray(raw.documents)
          ? raw.documents
          : [];

    for (const r of list) {
      if (!r || typeof r !== 'object') continue;
      const collection = String(r.collection || '').trim();
      const id = String(r.id || r.recordId || r._id || '').trim();
      if (!collection || !id) continue;
      let doc: Record<string, any> = {};
      if (typeof r.dataJson === 'string') {
        try {
          doc = JSON.parse(r.dataJson);
        } catch {}
      } else if (typeof r.data === 'string') {
        try {
          doc = JSON.parse(r.data);
        } catch {}
      } else if (r.data && typeof r.data === 'object') {
        doc = r.data;
      } else if (r.doc && typeof r.doc === 'object') {
        doc = r.doc;
      }
      const ts = Number(r.updated_at_ms || r.updatedAtMs) || parseTs(doc._syncUpdatedAtMs || doc.updatedAt);
      out.push({
        collection,
        id,
        doc: { ...doc, id },
        updatedAtMs: ts || undefined,
        deleted: Boolean(r.deleted || doc.isArchived),
        merge: true,
      });
    }

    return out;
  }

  /**
   * Automatic Multi-Database Fallback Chain Reader (Strictly Ordered with Try-Catch Failover):
   *   1. Backup 1: Supabase
   *   2. Backup 2: Appwrite -> MongoDB Atlas Data API
   *   3. Backup 3: Peer -> Google Sheets (Relay / Sheets API v4) -> GitHub JSON
   */
  public async restoreFromCloudMirror(
    incremental = false
  ): Promise<{ restored: number; sourceTier?: string; error?: string }> {
    if (!this.isAnyFallbackConfigured()) return { restored: 0 };
    if (this.cloudRestoreInFlight) return this.cloudRestoreInFlight;

    this.cloudRestoreInFlight = (async () => {
      let restored = 0;
      let sourceTier = '';
      const errors: string[] = [];
      const sinceMs = incremental && this.lastCloudPullMs > 0 ? Math.max(0, this.lastCloudPullMs - 5000) : 0;

      const tryApplyPayloads = (tierName: string, payloads: SyncRecordPayload[]): boolean => {
        if (payloads.length === 0) return false;
        const res = this.upsertBatchInternal(payloads, false);
        restored = res.count;
        sourceTier = tierName;
        this.lastActiveRestoreTier = tierName;
        let maxTs = this.lastCloudPullMs;
        payloads.forEach((p) => {
          if (p.updatedAtMs && p.updatedAtMs > maxTs) maxTs = p.updatedAtMs;
        });
        this.lastCloudPullMs = Math.max(maxTs, Date.now() - 2000);
        this.lastCloudSyncAtMs = Date.now();
        this.lastCloudError = '';
        return true;
      };

      try {
        // -------------------------------------------------------------------
        // BACKUP 1: Supabase PostgreSQL REST
        // -------------------------------------------------------------------
        if (this.isSupabaseEnabled()) {
          try {
            const filter = sinceMs > 0 ? `&updated_at_ms=gt.${sinceMs}` : '';
            const resp = await fetchWithTimeout(
              `${this.supabaseUrl}/rest/v1/sync_records?select=collection,id,data,updated_at_ms,deleted&order=updated_at_ms.desc&limit=5000${filter}`,
              {
                headers: {
                  apikey: this.supabaseKey,
                  Authorization: `Bearer ${this.supabaseKey}`,
                },
              }
            );
            if (resp.ok) {
              const json = await resp.json();
              const normalized = this.normalizeExternalRows(json);
              if (normalized.length > 0) {
                tryApplyPayloads('backup1:supabase', normalized);
                return { restored, sourceTier };
              }
              sourceTier = 'backup1:supabase';
              this.lastActiveRestoreTier = sourceTier;
              this.lastCloudPullMs = Math.max(this.lastCloudPullMs, Date.now() - 2000);
              this.lastCloudSyncAtMs = Date.now();
              this.lastCloudError = '';
              return { restored: 0, sourceTier };
            } else {
              errors.push(`Supabase HTTP ${resp.status}`);
            }
          } catch (e: any) {
            errors.push(`Supabase: ${e?.message || 'failed'}`);
          }
        }

        // -------------------------------------------------------------------
        // BACKUP 2A: Appwrite Databases REST API
        // -------------------------------------------------------------------
        if (this.isAppwriteEnabled()) {
          try {
            const url = `${this.appwriteEndpoint}/databases/${encodeURIComponent(this.appwriteDatabaseId)}/collections/${encodeURIComponent(this.appwriteCollectionId)}/documents`;
            const resp = await fetchWithTimeout(url, {
              headers: {
                'X-Appwrite-Project': this.appwriteProjectId,
                'X-Appwrite-Key': this.appwriteApiKey,
              },
            });
            if (resp.ok) {
              const json = await resp.json();
              const normalized = this.normalizeExternalRows(json).filter(
                (r) => !sinceMs || !r.updatedAtMs || r.updatedAtMs > sinceMs
              );
              if (normalized.length > 0) {
                tryApplyPayloads('backup2:appwrite', normalized);
                return { restored, sourceTier };
              }
              sourceTier = 'backup2:appwrite';
              this.lastActiveRestoreTier = sourceTier;
              this.lastCloudSyncAtMs = Date.now();
              this.lastCloudError = '';
              return { restored: 0, sourceTier };
            } else {
              errors.push(`Appwrite HTTP ${resp.status}`);
            }
          } catch (e: any) {
            errors.push(`Appwrite: ${e?.message || 'failed'}`);
          }
        }

        // -------------------------------------------------------------------
        // BACKUP 2B: MongoDB Atlas Data API
        // -------------------------------------------------------------------
        if (this.isMongoEnabled()) {
          try {
            const resp = await fetchWithTimeout(`${this.mongoDataApiUrl}/action/find`, {
              method: 'POST',
              headers: {
                'api-key': this.mongoDataApiKey,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                dataSource: this.mongoDataSource,
                database: this.mongoDatabase,
                collection: this.mongoCollection,
                filter: sinceMs > 0 ? { updated_at_ms: { $gt: sinceMs } } : {},
                sort: { updated_at_ms: -1 },
                limit: 5000,
              }),
            });
            if (resp.ok) {
              const json = await resp.json();
              const normalized = this.normalizeExternalRows(json);
              if (normalized.length > 0) {
                tryApplyPayloads('backup2:mongodb', normalized);
                return { restored, sourceTier };
              }
              sourceTier = 'backup2:mongodb';
              this.lastActiveRestoreTier = sourceTier;
              this.lastCloudSyncAtMs = Date.now();
              this.lastCloudError = '';
              return { restored: 0, sourceTier };
            } else {
              errors.push(`MongoDB HTTP ${resp.status}`);
            }
          } catch (e: any) {
            errors.push(`MongoDB: ${e?.message || 'failed'}`);
          }
        }

        // -------------------------------------------------------------------
        // PEER SERVER SYNC (if configured)
        // -------------------------------------------------------------------
        if (this.isPeerEnabled()) {
          try {
            const headers: Record<string, string> = {};
            if (this.peerKey) headers['Authorization'] = `Bearer ${this.peerKey}`;
            const resp = await fetchWithTimeout(`${this.peerUrl}/api/sync/export-all?sinceMs=${sinceMs}`, { headers });
            if (resp.ok) {
              const json = await resp.json();
              const normalized = this.normalizeExternalRows(json);
              if (normalized.length > 0) {
                tryApplyPayloads('peer', normalized);
                return { restored, sourceTier };
              }
            } else {
              errors.push(`Peer HTTP ${resp.status}`);
            }
          } catch (e: any) {
            errors.push(`Peer: ${e?.message || 'failed'}`);
          }
        }

        // -------------------------------------------------------------------
        // BACKUP 3A: Google Sheets Relay / Google Sheets API v4 (Read Fallback)
        // -------------------------------------------------------------------
        if (this.isRelayEnabled()) {
          try {
            const headers: Record<string, string> = {};
            if (this.relayKey) headers['Authorization'] = `Bearer ${this.relayKey}`;
            const sep = this.relayUrl.includes('?') ? '&' : '?';
            const actionParam = sinceMs > 0 ? `action=pullSince&since=${sinceMs}` : 'action=pullAll';
            const keyParam = this.relayKey ? `&key=${encodeURIComponent(this.relayKey)}` : '';
            const resp = await fetchWithTimeout(`${this.relayUrl}${sep}${actionParam}${keyParam}`, { headers });
            if (resp.ok) {
              const json = await resp.json();
              const normalized = this.normalizeExternalRows(json);
              if (normalized.length > 0) {
                tryApplyPayloads('backup3:google-sheets-relay', normalized);
                return { restored, sourceTier };
              }
            } else {
              errors.push(`Relay HTTP ${resp.status}`);
            }
          } catch (e: any) {
            errors.push(`Relay: ${e?.message || 'failed'}`);
          }
        }

        if (this.isGoogleSheetsReadEnabled()) {
          try {
            const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(this.googleSheetsId)}/values/${encodeURIComponent(this.googleSheetsRange)}?key=${encodeURIComponent(this.googleSheetsApiKey)}`;
            const resp = await fetchWithTimeout(url);
            if (resp.ok) {
              const json = await resp.json();
              const normalized = this.normalizeExternalRows(json).filter(
                (r) => !sinceMs || !r.updatedAtMs || r.updatedAtMs > sinceMs
              );
              if (normalized.length > 0) {
                tryApplyPayloads('backup3:google-sheets-api', normalized);
                return { restored, sourceTier };
              }
            } else {
              errors.push(`GoogleSheets HTTP ${resp.status}`);
            }
          } catch (e: any) {
            errors.push(`GoogleSheets: ${e?.message || 'failed'}`);
          }
        }

        // -------------------------------------------------------------------
        // BACKUP 3B: GitHub JSON Read-Only Fallback
        // -------------------------------------------------------------------
        if (this.isGithubJsonEnabled()) {
          try {
            const headers: Record<string, string> = { Accept: 'application/json' };
            if (this.githubToken) headers['Authorization'] = `Bearer ${this.githubToken}`;
            const resp = await fetchWithTimeout(this.githubJsonUrl, { headers });
            if (resp.ok) {
              const json = await resp.json();
              const normalized = this.normalizeExternalRows(json).filter(
                (r) => !sinceMs || !r.updatedAtMs || r.updatedAtMs > sinceMs
              );
              if (normalized.length > 0) {
                tryApplyPayloads('backup3:github-json', normalized);
                return { restored, sourceTier };
              }
            } else {
              errors.push(`GitHubJSON HTTP ${resp.status}`);
            }
          } catch (e: any) {
            errors.push(`GitHubJSON: ${e?.message || 'failed'}`);
          }
        }

        this.lastCloudError = errors.join(' | ');
        return { restored, ...(sourceTier ? { sourceTier } : {}), ...(this.lastCloudError ? { error: this.lastCloudError } : {}) };
      } finally {
        this.cloudRestoreInFlight = null;
      }
    })();

    return this.cloudRestoreInFlight;
  }

  private getRow(collection: string, id: string): StoredRow | null {
    if (this.sqliteDb) {
      const stmt = this.sqliteDb.prepare(
        'SELECT collection, id, data, updated_at_ms, deleted, revision FROM sync_records WHERE collection = ? AND id = ?'
      );
      const row = stmt.get(collection, id);
      return row ? (row as StoredRow) : null;
    }
    return this.memoryStore.get(this.keyOf(collection, id)) || null;
  }

  private putRow(row: StoredRow) {
    if (this.sqliteDb) {
      const stmt = this.sqliteDb.prepare(`
        INSERT INTO sync_records (collection, id, data, updated_at_ms, deleted, revision)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(collection, id) DO UPDATE SET
          data = excluded.data,
          updated_at_ms = excluded.updated_at_ms,
          deleted = excluded.deleted,
          revision = excluded.revision
      `);
      stmt.run(row.collection, row.id, row.data, row.updated_at_ms, row.deleted, row.revision);
    } else {
      this.memoryStore.set(this.keyOf(row.collection, row.id), row);
      this.scheduleFallbackPersist();
    }
  }

  public upsert(
    input: SyncRecordPayload,
    broadcast = true,
    mirrorCloud = true
  ): { stored: SyncDeltaEvent; applied: boolean; row?: StoredRow } {
    const col = String(input.collection || '').trim();
    const id = String(input.id || '').trim();
    if (!col || !id || !isValidSyncCollection(col) || !isValidSyncDocId(id)) {
      throw new Error('Invalid collection or document id');
    }

    const sanitizedInput =
      input.doc && typeof input.doc === 'object' ? sanitizeDocPayload(input.doc) : {};
    const incomingDoc: Record<string, any> = { ...sanitizedInput, id };
    const isDeleted = Boolean(input.deleted || incomingDoc.isArchived);
    const incomingTs =
      Number(input.updatedAtMs) ||
      parseTs(incomingDoc._syncUpdatedAtMs) ||
      parseTs(incomingDoc.updatedAt) ||
      parseTs(incomingDoc.createdAt) ||
      Date.now();

    const existing = this.getRow(col, id);
    let existingDoc: Record<string, any> | null = null;
    if (existing) {
      try {
        existingDoc = JSON.parse(existing.data);
      } catch {
        existingDoc = null;
      }
    }

    // Conflict check: if existing record is strictly newer, keep newer fields and avoid stale overwrite
    if (existing && existing.updated_at_ms > incomingTs) {
      const mergedDoc =
        existingDoc && incomingDoc
          ? { ...incomingDoc, ...existingDoc, id }
          : existingDoc || incomingDoc;
      return {
        applied: false,
        stored: {
          collection: col,
          id,
          doc: mergedDoc,
          deleted: existing.deleted === 1,
          updatedAtMs: existing.updated_at_ms,
          revision: existing.revision,
        },
      };
    }

    const finalDoc: Record<string, any> =
      input.merge !== false && existingDoc
        ? { ...existingDoc, ...incomingDoc, id }
        : { ...incomingDoc, id };

    if (isDeleted) {
      finalDoc.isArchived = true;
    }
    if (!finalDoc.updatedAt) {
      finalDoc.updatedAt = new Date(incomingTs).toISOString();
    }
    finalDoc._syncUpdatedAtMs = incomingTs;

    this.revisionCounter += 1;
    const row: StoredRow = {
      collection: col,
      id,
      data: JSON.stringify(finalDoc),
      updated_at_ms: incomingTs,
      deleted: isDeleted ? 1 : 0,
      revision: this.revisionCounter,
    };

    this.putRow(row);

    const deltaEvent: SyncDeltaEvent = {
      collection: col,
      id,
      doc: finalDoc,
      deleted: isDeleted,
      updatedAtMs: incomingTs,
      revision: this.revisionCounter,
    };

    if (broadcast) {
      this.broadcastDelta(deltaEvent);
    }

    if (mirrorCloud && this.isAnyWritableMirrorEnabled()) {
      void this.mirrorRowsToCloud([row]);
    }

    return { applied: true, stored: deltaEvent, row };
  }

  private upsertBatchInternal(
    items: SyncRecordPayload[],
    mirrorCloud = true
  ): { count: number; latestRevision: number; serverEpoch: string; events: SyncDeltaEvent[] } {
    const events: SyncDeltaEvent[] = [];
    const mirroredRows: StoredRow[] = [];
    if (!Array.isArray(items) || items.length === 0) {
      return { count: 0, latestRevision: this.revisionCounter, serverEpoch: this.serverEpoch, events };
    }

    if (this.sqliteDb) {
      this.sqliteDb.exec('BEGIN');
      try {
        for (const item of items) {
          if (!item?.collection || !item?.id) continue;
          const res = this.upsert(item, false, false);
          if (res.applied) {
            events.push(res.stored);
            if (res.row) mirroredRows.push(res.row);
          }
        }
        this.sqliteDb.exec('COMMIT');
      } catch (err) {
        try {
          this.sqliteDb.exec('ROLLBACK');
        } catch {}
        throw err;
      }
    } else {
      for (const item of items) {
        if (!item?.collection || !item?.id) continue;
        const res = this.upsert(item, false, false);
        if (res.applied) {
          events.push(res.stored);
          if (res.row) mirroredRows.push(res.row);
        }
      }
    }

    events.forEach((evt) => this.broadcastDelta(evt));
    if (mirrorCloud && mirroredRows.length > 0 && this.isAnyWritableMirrorEnabled()) {
      void this.mirrorRowsToCloud(mirroredRows);
    }
    return { count: events.length, latestRevision: this.revisionCounter, serverEpoch: this.serverEpoch, events };
  }

  public upsertBatch(items: SyncRecordPayload[]) {
    return this.upsertBatchInternal(items, true);
  }

  public getCollection(
    collection: string,
    options: { sinceMs?: number; limit?: number; offset?: number; includeDeleted?: boolean } = {}
  ): {
    items: Record<string, any>[];
    archivedIds: string[];
    total: number;
    latestUpdatedAtMs: number;
    revision: number;
    serverEpoch: string;
  } {
    const col = String(collection || '').trim();
    const sinceMs = Math.max(0, Number(options.sinceMs) || 0);
    const limit = Math.min(5000, Math.max(1, Number(options.limit) || 1000));
    const offset = Math.max(0, Number(options.offset) || 0);

    const items: Record<string, any>[] = [];
    const archivedIds: string[] = [];
    let latestUpdatedAtMs = 0;

    if (this.sqliteDb) {
      const countRow = this.sqliteDb
        .prepare('SELECT COUNT(*) AS cnt FROM sync_records WHERE collection = ? AND updated_at_ms > ?')
        .get(col, sinceMs);
      const total = Number(countRow?.cnt) || 0;

      const rows = this.sqliteDb
        .prepare(
          'SELECT id, data, updated_at_ms, deleted FROM sync_records WHERE collection = ? AND updated_at_ms > ? ORDER BY updated_at_ms DESC LIMIT ? OFFSET ?'
        )
        .all(col, sinceMs, limit, offset) as StoredRow[];

      rows.forEach((r) => {
        if (r.updated_at_ms > latestUpdatedAtMs) latestUpdatedAtMs = r.updated_at_ms;
        if (r.deleted === 1) {
          archivedIds.push(r.id);
          if (options.includeDeleted) {
            try {
              items.push({ ...JSON.parse(r.data), id: r.id, isArchived: true });
            } catch {}
          }
        } else {
          try {
            items.push({ ...JSON.parse(r.data), id: r.id });
          } catch {}
        }
      });

      return { items, archivedIds, total, latestUpdatedAtMs, revision: this.revisionCounter, serverEpoch: this.serverEpoch };
    }

    const matching = Array.from(this.memoryStore.values())
      .filter((r) => r.collection === col && r.updated_at_ms > sinceMs)
      .sort((a, b) => b.updated_at_ms - a.updated_at_ms);

    const sliced = matching.slice(offset, offset + limit);
    sliced.forEach((r) => {
      if (r.updated_at_ms > latestUpdatedAtMs) latestUpdatedAtMs = r.updated_at_ms;
      if (r.deleted === 1) {
        archivedIds.push(r.id);
        if (options.includeDeleted) {
          try {
            items.push({ ...JSON.parse(r.data), id: r.id, isArchived: true });
          } catch {}
        }
      } else {
        try {
          items.push({ ...JSON.parse(r.data), id: r.id });
        } catch {}
      }
    });

    return {
      items,
      archivedIds,
      total: matching.length,
      latestUpdatedAtMs,
      revision: this.revisionCounter,
      serverEpoch: this.serverEpoch,
    };
  }

  public getChangesSince(
    sinceRevision: number,
    limit = 500,
    clientEpoch = ''
  ): { events: SyncDeltaEvent[]; latestRevision: number; serverEpoch: string; resetRequired: boolean } {
    const rev = Math.max(0, Number(sinceRevision) || 0);
    const resetRequired = Boolean(
      (clientEpoch && clientEpoch !== this.serverEpoch) ||
      (rev > 0 && rev > this.revisionCounter)
    );
    const effectiveSince = resetRequired ? 0 : rev;
    const maxLimit = Math.min(2000, Math.max(1, Number(limit) || 500));
    const events: SyncDeltaEvent[] = [];

    if (this.sqliteDb) {
      const rows = this.sqliteDb
        .prepare(
          'SELECT collection, id, data, updated_at_ms, deleted, revision FROM sync_records WHERE revision > ? ORDER BY revision ASC LIMIT ?'
        )
        .all(effectiveSince, maxLimit) as StoredRow[];

      rows.forEach((r) => {
        try {
          events.push({
            collection: r.collection,
            id: r.id,
            doc: JSON.parse(r.data),
            deleted: r.deleted === 1,
            updatedAtMs: r.updated_at_ms,
            revision: r.revision,
          });
        } catch {}
      });
    } else {
      const matching = Array.from(this.memoryStore.values())
        .filter((r) => r.revision > effectiveSince)
        .sort((a, b) => a.revision - b.revision)
        .slice(0, maxLimit);
      matching.forEach((r) => {
        try {
          events.push({
            collection: r.collection,
            id: r.id,
            doc: JSON.parse(r.data),
            deleted: r.deleted === 1,
            updatedAtMs: r.updated_at_ms,
            revision: r.revision,
          });
        } catch {}
      });
    }

    return {
      events,
      latestRevision: this.revisionCounter,
      serverEpoch: this.serverEpoch,
      resetRequired,
    };
  }

  public exportAllRows(sinceMs = 0): {
    serverEpoch: string;
    latestRevision: number;
    exportedAtMs: number;
    rows: Array<{ collection: string; id: string; doc: Record<string, any>; updatedAtMs: number; deleted: boolean }>;
  } {
    const rawRows: StoredRow[] = this.sqliteDb
      ? (this.sqliteDb
          .prepare(
            'SELECT collection, id, data, updated_at_ms, deleted, revision FROM sync_records WHERE updated_at_ms >= ? ORDER BY updated_at_ms DESC LIMIT 5000'
          )
          .all(Math.max(0, Number(sinceMs) || 0)) as StoredRow[])
      : Array.from(this.memoryStore.values()).filter((r) => r.updated_at_ms >= Math.max(0, Number(sinceMs) || 0));

    const rows: Array<{ collection: string; id: string; doc: Record<string, any>; updatedAtMs: number; deleted: boolean }> = [];
    rawRows.forEach((r) => {
      try {
        rows.push({
          collection: r.collection,
          id: r.id,
          doc: JSON.parse(r.data),
          updatedAtMs: r.updated_at_ms,
          deleted: r.deleted === 1,
        });
      } catch {}
    });

    return {
      serverEpoch: this.serverEpoch,
      latestRevision: this.revisionCounter,
      exportedAtMs: Date.now(),
      rows,
    };
  }

  public getStats() {
    const totalRecords = this.getTotalRecordsCount();
    const cloud = this.getCloudConfigPublic();
    return {
      ok: true,
      engine: this.sqliteDb ? 'sqlite-wal' : 'atomic-json-wal',
      serverEpoch: this.serverEpoch,
      supabaseMirror: this.isSupabaseEnabled(),
      cloudMirrorConfigured: cloud.configured,
      cloudMirrorType: cloud.type,
      configuredChain: cloud.configuredChain,
      activeRestoreTier: cloud.activeRestoreTier,
      lastCloudSyncAtMs: cloud.lastCloudSyncAtMs,
      lastCloudError: cloud.lastCloudError,
      cloudMirroredCount: cloud.cloudMirroredCount,
      totalRecords,
      latestRevision: this.revisionCounter,
      connectedClients: this.sseClients.size,
    };
  }

  public getCollectionSummary() {
    const collections: Record<string, number> = {};
    if (this.sqliteDb) {
      const rows = this.sqliteDb
        .prepare('SELECT collection, COUNT(*) AS cnt FROM sync_records WHERE deleted = 0 GROUP BY collection')
        .all() as Array<{ collection: string; cnt: number }>;
      rows.forEach((r) => {
        collections[r.collection] = Number(r.cnt) || 0;
      });
    } else {
      this.memoryStore.forEach((r) => {
        if (r.deleted === 0) {
          collections[r.collection] = (collections[r.collection] || 0) + 1;
        }
      });
    }
    return {
      ...this.getStats(),
      collections,
    };
  }

  public verifyUserCredentials(
    loginIdInput: string,
    passwordInput: string
  ): {
    status: 'verified' | 'invalid_password' | 'inactive' | 'not_found' | 'empty';
    profile?: Record<string, any>;
  } {
    const usersRes = this.getCollection('users', { limit: 1000 });
    if (!usersRes.items || usersRes.items.length === 0) {
      return { status: 'empty' };
    }

    const trimmedId = String(loginIdInput || '').trim();
    const trimmedPass = String(passwordInput || '').trim();
    const lowerId = trimmedId.toLowerCase();
    const numericDigits = trimmedId.replace(/\D/g, '');
    const last10Digits = numericDigits.length >= 10 ? numericDigits.slice(-10) : numericDigits;

    const foundUser = usersRes.items.find((u: any) => {
      if (!u || u.isArchived) return false;
      const storedLoginId = String(u.loginId || '').trim().toLowerCase();
      if (storedLoginId && storedLoginId === lowerId) return true;
      if (u.userCode && String(u.userCode).trim().toLowerCase() === lowerId) return true;
      const storedMobile = String(u.mobileNumber || '').replace(/\D/g, '').slice(-10);
      if (last10Digits && storedMobile && storedMobile === last10Digits) return true;
      const storedEmail = String(u.emailId || '').trim().toLowerCase();
      if (storedEmail && storedEmail === lowerId) return true;
      const storedName = String(u.fullName || '').trim().toLowerCase();
      if (storedName && (lowerId === 'shridhar' || lowerId === 'shridhar shinde' || lowerId === 'shinde')) {
        if (u.role === 'owner') return true;
      }
      return false;
    });

    if (!foundUser) {
      return { status: 'not_found' };
    }
    if (foundUser.status === 'Inactive') {
      return { status: 'inactive' };
    }

    const storedPass = (
      foundUser.password !== undefined &&
      foundUser.password !== null &&
      String(foundUser.password).trim() !== ''
        ? String(foundUser.password)
        : 'bw@123'
    ).trim();

    if (!timingSafeStringMatch(trimmedPass, storedPass)) {
      return { status: 'invalid_password' };
    }

    const { password: _omitted, ...safeProfile } = foundUser;
    return {
      status: 'verified',
      profile: {
        ...safeProfile,
        uid: safeProfile.uid || safeProfile.id,
        id: safeProfile.id || safeProfile.uid,
      },
    };
  }
}

export const secondarySyncDb = new SecondarySyncDatabase();
