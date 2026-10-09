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

  // API Route for parsing price list
  app.post('/api/parse-pricelist', upload.single('file') as any, async (req: any, res: any) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
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

      const response = await ai.models.generateContent({
        model: "gemini-3.8-flash",
        contents: [
          { inlineData: { data: fileData, mimeType } },
          { text: prompt }
        ],
        config: {
          systemInstruction: systemInstruction,
          responseMimeType: "application/json",
          responseSchema: {
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
          }
        }
      });

      const text = response.text;
      if (!text) {
        throw new Error('Empty response from Gemini');
      }
      
      const parsedData = JSON.parse(text);
      res.json(parsedData);
    } catch (error: any) {
      console.error('Parsing error:', error);
      res.status(500).json({ error: error.message || 'Failed to parse file' });
    }
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
      res.sendFile(indexPath);
    });
  } else {
    console.log('Starting application in development mode with Vite...');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa'
    });
    app.use(vite.middlewares);

    app.use('*', async (req, res, next) => {
      const url = req.originalUrl;
      try {
        let template = fs.readFileSync(path.resolve(process.cwd(), 'index.html'), 'utf-8');
        template = await vite.transformIndexHtml(url, template);
        res.status(200).set({ 'Content-Type': 'text/html' }).end(template);
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
