import express from 'express';
import { createServer as createViteServer } from 'vite';
import multer from 'multer';
import { GoogleGenAI, Type } from "@google/genai";
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { secondarySyncDb } from './server/secondaryDb';

dotenv.config();

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY || '',
  httpOptions: {
    headers: {
      'User-Agent': 'aistudio-build',
    }
  }
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
});

async function createServer() {
  const app = express();
  const port = 3000;

  app.use(express.json({ limit: '10mb' }));

  // Simple Request Logging for production debugging
  app.use((req, res, next) => {
    if (req.url.startsWith('/api/') || req.url.startsWith('/assets/')) {
      next();
      return;
    }
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    next();
  });

  // API Route for parsing price list with Exponential Backoff & Multi-Model Fallback
  app.post('/api/parse-pricelist', (req: any, res: any, next: any) => {
    upload.single('file')(req, res, (uploadErr: any) => {
      if (uploadErr) {
        const isTooLarge = uploadErr?.code === 'LIMIT_FILE_SIZE';
        return res.status(isTooLarge ? 413 : 400).json({
          error: isTooLarge
            ? 'फाईलचा आकार १५ MB पेक्षा जास्त आहे. कृपया लहान फाईल निवडा.'
            : (uploadErr.message || 'फाईल अपलोड करताना त्रुटी आली.'),
        });
      }
      next();
    });
  }, async (req: any, res: any) => {
    try {
      if (!process.env.GEMINI_API_KEY) {
        return res.status(500).json({ error: 'सर्व्हरवर AI Key कॉन्फिगर केलेली नाही.' });
      }
      if (!req.file) {
        return res.status(400).json({ error: 'कोणतीही फाईल निवडलेली नाही. कृपया फाईल निवडा.' });
      }

      const fileData = req.file.buffer.toString('base64');
      const mimeType = req.file.mimetype;

      const systemInstruction = `You are a specialist in extracting product data from agricultural price lists (PDF, Images, Excel).
      Your goal is to extract every product and every grade listed in the file with 100% accuracy, strictly matching the company's table format.
      
      CRITICAL RULES:
      1. DO NOT ESTIMATE, INVENT, OR CALCULATE ANY DATA. Extract exactly what is explicitly written in the file.
      2. PRESERVE CATEGORIES / SECTIONS: Identify Section headings (e.g., "Group A - Water Soluble Fertilizers", "Specialty Grades", "Group B - Micronutrients", etc.).
      3. EXTRACT VALIDITY: If there is a validity line like "Pricelist w.e.f 01/10/2026 to 31/10/2026", extract it.
      4. BRAND & GRADE SEPARATION:
         - brandName: The brand title (usually "Airawat®" or "Blackworm")
         - gradeName: The nutrient grade or chemical name (e.g. "19:19:19", "00:42:47 + Fe", "11:44:11 + Zn", "Calcium Nitrate", "Nitro King", etc.)
      5. MULTIPLE PACKINGS PER PRODUCT (CRITICAL):
         Agricultural price lists often show multiple rows for different packing sizes of the same grade (e.g., "1 Kg * 25 Nos" with Rate 195 and MRP 370 in row 1, AND "25 Kg" with Rate 3710 and MRP 4960 in row 2).
         You MUST combine all packing sizes for the same product grade into a SINGLE product object's "packings" array.
         NEVER create separate product items for different packing sizes of the same grade!
      6. STRICTLY UNIQUE PRODUCTS:
         Each unique product grade must appear only ONCE in the products array.
      7. CLEAN GRADE NAMES:
         Do not include brand name inside gradeName (e.g. use "19:19:19", not "Airawat 19:19:19").
         Do not include code or Sr No inside gradeName (e.g. use "19:19:19", not "1. 19:19:19").`;

      const prompt = "Parse this price list image/document and return the structured JSON object with validityDate and products array. Only return JSON.";

      const schema = {
        type: Type.OBJECT,
        properties: {
          validityDate: { type: Type.STRING },
          products: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                groupName: { type: Type.STRING },
                code: { type: Type.STRING },
                brandName: { type: Type.STRING },
                gradeName: { type: Type.STRING },
                hsn: { type: Type.STRING },
                gstRate: { type: Type.NUMBER },
                packings: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      packingSize: { type: Type.STRING },
                      rate: { type: Type.NUMBER },
                      mrp: { type: Type.NUMBER }
                    },
                    required: ["packingSize", "rate", "mrp"]
                  }
                }
              },
              required: ["groupName", "code", "gradeName", "hsn", "packings"]
            }
          }
        },
        required: ["products"]
      };

      // Resilient Multi-Tier Models with Exponential Backoff Retry (Auto Re-try Mechanism)
      const candidateModels = ['gemini-4-hydrogen', 'gemini-3.1-flash-lite'];
      const maxRetries = 3;
      let lastError: any = null;
      let parsedData: any = null;

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        const modelName = candidateModels[(attempt - 1) % candidateModels.length];
        try {
          console.log(`[AI Parser] Attempt ${attempt}/${maxRetries} requesting model: ${modelName}`);
          const response = await ai.models.generateContent({
            model: modelName,
            contents: [
              { inlineData: { data: fileData, mimeType } },
              { text: prompt }
            ],
            config: {
              systemInstruction,
              responseMimeType: "application/json",
              responseSchema: schema
            }
          });

          const text = response.text;
          if (!text) throw new Error('Empty response from AI model');
          parsedData = JSON.parse(text);
          console.log(`[AI Parser] Success on attempt ${attempt} with ${parsedData?.products?.length || 0} products!`);
          break; // Successfully parsed!
        } catch (attemptErr: any) {
          lastError = attemptErr;
          const errMsg = String(attemptErr?.message || '');
          const isTransient = errMsg.includes('503') || errMsg.includes('500') || errMsg.includes('UNAVAILABLE') || errMsg.includes('overloaded') || errMsg.includes('429') || errMsg.includes('404') || errMsg.toLowerCase().includes('timeout');
          console.warn(`[AI Parser] Attempt ${attempt} encountered error:`, errMsg.slice(0, 150));

          if (!isTransient && attempt > 1) {
            break;
          }

          if (attempt < maxRetries) {
            const backoffMs = attempt * 1500;
            console.log(`[AI Parser] Applying exponential backoff: waiting ${backoffMs}ms before attempt ${attempt + 1}...`);
            await new Promise(r => setTimeout(r, backoffMs));
          }
        }
      }

      if (!parsedData) {
        throw lastError || new Error('Failed to parse price list after automated retries');
      }

      // Server-side robust deduplication & packing merger
      if (Array.isArray(parsedData.products)) {
        const normalizeServerGroupName = (g: any): string => {
          const s = String(g || '').trim();
          const lower = s.toLowerCase();
          if (lower.includes('group a') || lower.includes('water soluble')) return 'Group A - Water Soluble Fertilizers';
          if (lower.includes('specialty')) return 'Specialty Grades';
          if (lower.includes('group b') || lower.includes('micronutrient') || lower.includes('micro')) return 'Group B - Micronutrients';
          if (lower.includes('group c') || lower.includes('growth regulator') || lower.includes('pgr') || lower.includes('stimulant')) return 'Group C - Plant Growth Regulators';
          return s.replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim();
        };

        const dedupMap = new Map<string, any>();
        parsedData.products.forEach((p: any) => {
          if (!p) return;
          const normGroup = normalizeServerGroupName(p.groupName);
          let brand = String(p.brandName || '').trim() || 'Airawat®';
          let grade = String(p.gradeName || '').trim();

          // Strip leading numbering or codes like "C 1.", "B 1.", "A 1.", "S 1.", "1."
          grade = grade.replace(/^[A-Za-z]?\s*\d+\s*[\.\-\)]\s*/i, '').trim();

          // If grade starts with brand name, strip brand from grade
          if (brand) {
            const bClean = brand.toLowerCase().replace(/[^a-z0-9]/g, '');
            const gClean = grade.toLowerCase().replace(/[^a-z0-9]/g, '');
            if (gClean.startsWith(bClean) && grade.length > brand.length) {
              const matchedPrefix = grade.match(new RegExp(`^${brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[®™]?\\s*`, 'i'));
              if (matchedPrefix) {
                grade = grade.slice(matchedPrefix[0].length).trim();
              }
            }
          }

          // Generate canonical key using Group + Serial code
          let key = '';
          const codeStr = String(p.code || '').trim();
          const numMatch = codeStr.match(/(\d+)/);
          if (numMatch) {
            const num = parseInt(numMatch[1], 10);
            let groupPrefix = '';
            if (normGroup.includes('Group A')) groupPrefix = 'grp_a';
            else if (normGroup.includes('Specialty')) groupPrefix = 'grp_s';
            else if (normGroup.includes('Group B')) groupPrefix = 'grp_b';
            else if (normGroup.includes('Group C')) groupPrefix = 'grp_c';
            if (groupPrefix && num > 0) {
              key = `${groupPrefix}_${num}`;
            }
          }

          if (!key) {
            const gradeClean = grade
              .toLowerCase()
              .replace(/[®™]/g, '')
              .replace(/blackworm|airawat/g, '')
              .trim();
            key = gradeClean.replace(/[^a-z0-9]/g, '');
            const ratioM = gradeClean.match(/(\d+)\s*[:\-/]\s*(\d+)\s*[:\-/]\s*(\d+)/);
            if (ratioM) {
              const n1 = parseInt(ratioM[1], 10);
              const n2 = parseInt(ratioM[2], 10);
              const n3 = parseInt(ratioM[3], 10);
              key = `${n1}-${n2}-${n3}`;
              if (/\bfe\b/i.test(gradeClean)) key += '-fe';
              if (/\bmg\b/i.test(gradeClean)) key += '-mg';
              if (/\bzn\b/i.test(gradeClean)) key += '-zn';
              if (/\bcu\b/i.test(gradeClean)) key += '-cu';
              if (/\bs\b/i.test(gradeClean)) key += '-s';
              if (/\bcombi\b/i.test(gradeClean)) key += '-combi';
            }
          }

          const productItem = {
            ...p,
            groupName: normGroup,
            brandName: brand,
            gradeName: grade,
          };

          if (!dedupMap.has(key)) {
            dedupMap.set(key, productItem);
          } else {
            const existing = dedupMap.get(key);
            const exPackings = Array.isArray(existing.packings) ? [...existing.packings] : [];
            const inPackings = Array.isArray(p.packings) ? p.packings : [];
            inPackings.forEach((pk: any) => {
              const cleanPk = String(pk.packingSize || '').toLowerCase().replace(/[^a-z0-9]/g, '');
              const found = exPackings.find((ep: any) => String(ep.packingSize || '').toLowerCase().replace(/[^a-z0-9]/g, '') === cleanPk);
              if (!found) {
                exPackings.push(pk);
              } else if (pk.rate > 0) {
                found.rate = pk.rate;
                if (pk.mrp > 0) found.mrp = pk.mrp;
              }
            });
            existing.packings = exPackings;
            // Keep cleanest gradeName
            if (existing.gradeName.length > grade.length && grade.length > 2) {
              existing.gradeName = grade;
            }
          }
        });
        parsedData.products = Array.from(dedupMap.values());
      }

      res.json(parsedData);
    } catch (error: any) {
      console.error('Final parsing error after retries:', error);
      const errMsg = String(error?.message || '');
      const is503 = errMsg.includes('503') || errMsg.includes('UNAVAILABLE') || errMsg.includes('overloaded');
      const is429 = errMsg.includes('429') || errMsg.includes('RESOURCE_EXHAUSTED');

      let userFriendlyMessage = 'सर्व्हरकडून फाईल वाचताना त्रुटी आली. कृपया थोड्या वेळाने पुन्हा प्रयत्न करा.';
      if (is503) {
        userFriendlyMessage = 'AI सर्व्हरवर सध्या खूप जास्त लोड (High Demand) आहे. सिस्टीमने स्वयंचलित २-३ वेळा प्रयत्न केले, परंतु सर्व्हर तात्पुरता व्यस्त आहे. कृपया १-२ मिनिटांनंतर पुन्हा प्रयत्न करा किंवा थेट एक्सेल (.xlsx) फाईल वापरा जी त्वरित लोड होते.';
      } else if (is429) {
        userFriendlyMessage = 'सर्व्हरवरील रिक्वेस्ट मर्यादा संपली आहे. कृपया थोडा वेळ थांबून पुन्हा प्रयत्न करा.';
      }

      res.status(is503 ? 503 : 500).json({ 
        error: userFriendlyMessage,
        isOverloaded: is503 || is429,
        status: is503 ? 'UNAVAILABLE' : 'SERVER_ERROR'
      });
    }
  });

  // Dual-DB Secondary Sync Endpoints (SQLite WAL + Real-Time SSE + Optional Supabase Mirror)
  app.get('/api/sync/health', (_req, res) => {
    try {
      res.json(secondarySyncDb.getStats());
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err?.message || 'Secondary DB unavailable' });
    }
  });

  app.get('/api/sync/stream', (req, res) => {
    res.set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    if (typeof (res as any).flushHeaders === 'function') {
      (res as any).flushHeaders();
    }

    const sinceRev = Number(req.query.sinceRevision) || 0;
    const stats = secondarySyncDb.getStats();
    res.write(`event: connected\ndata: ${JSON.stringify({ latestRevision: stats.latestRevision, engine: stats.engine })}\n\n`);

    if (sinceRev > 0) {
      try {
        const catchup = secondarySyncDb.getChangesSince(sinceRev, 500);
        catchup.events.forEach((evt) => {
          res.write(`event: delta\ndata: ${JSON.stringify(evt)}\n\n`);
        });
      } catch (e) {
        console.warn('[SecondaryDB SSE] Catchup error:', e);
      }
    }

    secondarySyncDb.addSseClient(res);
    const keepAlive = setInterval(() => {
      try {
        res.write(`: keepalive ${Date.now()}\n\n`);
      } catch {
        clearInterval(keepAlive);
        secondarySyncDb.removeSseClient(res);
      }
    }, 25000);

    req.on('close', () => {
      clearInterval(keepAlive);
      secondarySyncDb.removeSseClient(res);
    });
  });

  app.get('/api/sync/collection/:name', (req, res) => {
    try {
      const colName = String(req.params.name || '').trim();
      if (!colName) {
        return res.status(400).json({ ok: false, error: 'Collection name is required' });
      }
      const sinceMs = Number(req.query.since) || 0;
      const limit = Number(req.query.limit) || 1000;
      const offset = Number(req.query.offset) || 0;
      const includeDeleted = req.query.includeDeleted === 'true' || req.query.includeDeleted === '1';

      const result = secondarySyncDb.getCollection(colName, { sinceMs, limit, offset, includeDeleted });
      res.json({ ok: true, ...result });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err?.message || 'Failed to query secondary collection' });
    }
  });

  app.get('/api/sync/changes', (req, res) => {
    try {
      const sinceRev = Number(req.query.since) || 0;
      const limit = Number(req.query.limit) || 500;
      const result = secondarySyncDb.getChangesSince(sinceRev, limit);
      res.json({ ok: true, ...result });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err?.message || 'Failed to read secondary changes' });
    }
  });

  app.post('/api/sync/upsert', (req, res) => {
    try {
      const { collection, id, doc: docData, updatedAtMs, deleted, merge } = req.body || {};
      if (!collection || !id) {
        return res.status(400).json({ ok: false, error: 'collection and id are required' });
      }
      const result = secondarySyncDb.upsert({
        collection: String(collection),
        id: String(id),
        doc: docData && typeof docData === 'object' ? docData : {},
        updatedAtMs: updatedAtMs ? Number(updatedAtMs) : undefined,
        deleted: Boolean(deleted),
        merge: merge !== false,
      });
      res.json({ ok: true, applied: result.applied, stored: result.stored });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err?.message || 'Secondary upsert failed' });
    }
  });

  app.post('/api/sync/batch', (req, res) => {
    try {
      const items = Array.isArray(req.body?.items) ? req.body.items : [];
      if (items.length === 0) {
        return res.json({ ok: true, count: 0, latestRevision: secondarySyncDb.getStats().latestRevision });
      }
      const result = secondarySyncDb.upsertBatch(items);
      res.json({ ok: true, count: result.count, latestRevision: result.latestRevision });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err?.message || 'Secondary batch upsert failed' });
    }
  });

  // Return clean JSON 404 for unmatched API routes before SPA middlewares handle them
  app.all('/api/*', (_req, res) => {
    res.status(404).json({ error: 'API route not found' });
  });

  // Never cache Service Worker or manifest
  app.use((req, res, next) => {
    if (req.url === '/sw.js' || req.url.startsWith('/dev-sw.js') || req.url === '/manifest.webmanifest' || req.url === '/registerSW.js') {
      res.set({
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
      });
    }
    next();
  });

  if (process.env.NODE_ENV !== 'production') {
    app.get(['/dev-sw.js', '/sw.js'], (_req, res) => {
      res.set({
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
      });
      res.send(
        `self.addEventListener('install', () => self.skipWaiting());\n` +
        `self.addEventListener('activate', (event) => {\n` +
        `  event.waitUntil(caches.keys().then((ks) => Promise.all(ks.map((k) => caches.delete(k)))).then(() => self.registration.unregister()));\n` +
        `});\n`
      );
    });
  }

  const distPath = path.join(process.cwd(), 'dist');
  const indexPath = path.join(distPath, 'index.html');

  if (process.env.NODE_ENV === 'production' && fs.existsSync(indexPath)) {
    console.log('Serving production-ready application from dist/');
    app.use('/assets', express.static(path.join(distPath, 'assets'), { maxAge: '1y' }));
    app.use(express.static(distPath, { index: false }));
    
    app.get('*', (req, res) => {
      if (req.url.startsWith('/api/')) {
        res.status(404).json({ error: 'API route not found' });
        return;
      }
      res.set({
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
      });
      res.sendFile(indexPath);
    });
  } else {
    console.log('Starting application in development mode with Vite...');
    const vite = await createViteServer({
      server: { middlewareMode: true, hmr: false },
      appType: 'spa'
    });
    app.use(vite.middlewares);

    app.use('*', async (req, res, next) => {
      const url = req.originalUrl;
      if (url.startsWith('/api/')) {
        return res.status(404).json({ error: 'API route not found' });
      }
      try {
        let template = fs.readFileSync(path.resolve(process.cwd(), 'index.html'), 'utf-8');
        template = await vite.transformIndexHtml(url, template);
        res.status(200).set({
          'Content-Type': 'text/html',
          'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
          'Pragma': 'no-cache',
          'Expires': '0',
        }).end(template);
      } catch (e) {
        next(e);
      }
    });
  }

  app.listen(port, '0.0.0.0', () => {
    console.log(`Server running at http://0.0.0.0:${port}`);
  });
}

createServer();
