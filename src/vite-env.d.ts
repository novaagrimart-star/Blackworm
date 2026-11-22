/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

interface ImportMetaEnv {
  readonly VITE_APP_VERSION?: string;
  readonly VITE_APP_BUILD_ID?: string;
  readonly VITE_APP_BUILD_TIME?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare const __APP_VERSION__: string;
declare const __APP_BUILD_ID__: string;
declare const __APP_BUILD_TIME__: string;
