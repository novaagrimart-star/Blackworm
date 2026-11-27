import fs from 'fs';
import path from 'path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

function readPackageVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'package.json'), 'utf-8'));
    return String(pkg?.version || '1.0.1');
  } catch {
    return '1.0.1';
  }
}

function readFirebaseMetadata(): { firebaseProjectId: string; firestoreDatabaseId: string } {
  try {
    const fb = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'firebase-applet-config.json'), 'utf-8'));
    return {
      firebaseProjectId: String(fb?.projectId || ''),
      firestoreDatabaseId: String(fb?.firestoreDatabaseId || ''),
    };
  } catch {
    return { firebaseProjectId: '', firestoreDatabaseId: '' };
  }
}

function emitVersionManifestPlugin(meta: {
  version: string;
  buildId: string;
  builtAt: string;
  firebaseProjectId: string;
  firestoreDatabaseId: string;
}): Plugin {
  let isBuild = false;
  let outDir = path.resolve(__dirname, 'dist');

  return {
    name: 'emit-version-manifest',
    configResolved(config) {
      isBuild = config.command === 'build';
      outDir = path.resolve(config.root || __dirname, config.build.outDir || 'dist');
    },
    closeBundle() {
      if (!isBuild) return;
      try {
        fs.mkdirSync(outDir, { recursive: true });
        fs.writeFileSync(
          path.join(outDir, 'version.json'),
          JSON.stringify(meta, null, 2),
          'utf-8'
        );
      } catch (err) {
        console.warn('[emit-version-manifest] Could not write dist/version.json:', err);
      }
    },
  };
}

export default defineConfig(({ command }) => {
  const appVersion = readPackageVersion();
  const fbMeta = readFirebaseMetadata();
  const buildId =
    process.env.BLACKWORM_BUILD_ID ||
    `${command === 'build' ? 'b' : 'dev'}_${Date.now().toString(36)}`;
  const builtAt = new Date().toISOString();

  return {
    define: {
      __APP_VERSION__: JSON.stringify(appVersion),
      __APP_BUILD_ID__: JSON.stringify(buildId),
      __APP_BUILD_TIME__: JSON.stringify(builtAt),
      'import.meta.env.VITE_APP_VERSION': JSON.stringify(appVersion),
      'import.meta.env.VITE_APP_BUILD_ID': JSON.stringify(buildId),
      'import.meta.env.VITE_APP_BUILD_TIME': JSON.stringify(builtAt),
    },
    plugins: [
      react(),
      tailwindcss(),
      emitVersionManifestPlugin({
        version: appVersion,
        buildId,
        builtAt,
        firebaseProjectId: fbMeta.firebaseProjectId,
        firestoreDatabaseId: fbMeta.firestoreDatabaseId,
      }),
      VitePWA({
        registerType: 'autoUpdate',
        injectRegister: false,
        devOptions: {
          enabled: false,
        },
        workbox: {
          globPatterns: ['**/*.{js,css,html,ico,png,svg,webp,jpg,mjs,woff,woff2,webmanifest}'],
          globIgnores: ['**/version.json', '**/server.js*', '**/*.map'],
          ignoreURLParametersMatching: [/^utm_/, /^fbclid$/],
          cleanupOutdatedCaches: true,
          skipWaiting: true,
          clientsClaim: true,
          maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
          navigateFallback: '/index.html',
          navigateFallbackDenylist: [/^\/api\//, /^\/data\//, /^\/version\.json$/, /^\/robots\.txt$/, /^\/favicon\.ico$/],
          runtimeCaching: [
            {
              urlPattern: /\/(?:api\/|data\/|version\.json)/i,
              handler: 'NetworkOnly',
            },
            {
              urlPattern: /^https:\/\/(firestore|identitytoolkit|securetoken)\.googleapis\.com\/.*/i,
              handler: 'NetworkOnly',
            },
            {
              urlPattern: /\.(?:png|jpg|jpeg|svg|gif|webp|ico)$/i,
              handler: 'StaleWhileRevalidate',
              options: {
                cacheName: 'images-cache',
                expiration: {
                  maxEntries: 60,
                  maxAgeSeconds: 30 * 24 * 60 * 60,
                },
              },
            },
          ],
        },
        manifest: false,
      }),
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      hmr: false,
      allowedHosts: true,
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
