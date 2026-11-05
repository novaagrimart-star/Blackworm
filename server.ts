import express from 'express';
import { createServer as createViteServer } from 'vite';
import multer from 'multer';
import { GoogleGenAI, Type } from "@google/genai";
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

dotenv.config();

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY || '',
  httpOptions: {
    headers: {
      'User-Agent': 'aistudio-build',
    }
  }
});

const upload = multer({ storage: multer.memoryStorage() });

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
  app.post('/api/parse-pricelist', upload.single('file') as any, async (req: any, res: any) => {
    try {
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
      5. MULTIPLE PACKINGS PER PRODUCT:
         If a product grade has multiple packing sizes (e.g. "1Kg * 25 Nos" with Rate 195 and MRP 370, AND "25 Kg" with Rate 3710 and MRP 4960), group them together under the same product's "packings" array.
      6. ALL ROWS MUST BE CAPTURED:
         Extract every single product grade row present in the table. If there are 9 products, extract all 9. If 17 products, extract all 17.
      
      JSON SCHEMA FIELDS:
      - validityDate: string (e.g., "Pricelist w.e.f 01/10/2026 to 31/10/2026")
      - products: array of objects:
        - groupName: string (Exact category heading from the file)
        - code: string (Sr. No / Code, e.g., "A 1.", "A 2.", "S 1.", etc.)
        - brandName: string (e.g., "Airawat®")
        - gradeName: string (e.g., "19:19:19", "11:44:11 + Zn", "00:42:47 + Fe")
        - hsn: string (HSN code, e.g., "31052000")
        - gstRate: number (GST percentage, e.g., 5)
        - packings: array of { packingSize: string, rate: number, mrp: number }`;

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
      const candidateModels = ['gemini-3.8-flash', 'gemini-3.1-flash-lite', 'gemini-flash-latest'];
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
          const isOverload = errMsg.includes('503') || errMsg.includes('UNAVAILABLE') || errMsg.includes('overloaded') || errMsg.includes('429');
          console.warn(`[AI Parser] Attempt ${attempt} encountered error:`, errMsg.slice(0, 150));

          if (attempt < maxRetries) {
            const backoffMs = attempt * 2000; // 2s, 4s...
            console.log(`[AI Parser] Applying exponential backoff: waiting ${backoffMs}ms before attempt ${attempt + 1}...`);
            await new Promise(r => setTimeout(r, backoffMs));
          }
        }
      }

      if (!parsedData) {
        throw lastError || new Error('Failed to parse price list after automated retries');
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

  // Never cache Service Worker or manifest
  app.use((req, res, next) => {
    if (req.url === '/sw.js' || req.url === '/manifest.webmanifest' || req.url === '/registerSW.js') {
      res.set({
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
      });
    }
    next();
  });

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
