import { readFileSync } from 'node:fs';

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

function readHttpsConfig() {
  if (process.env.VITE_DEV_HTTPS !== '1') {
    return undefined;
  }

  const certPath = process.env.VITE_DEV_HTTPS_CERT;
  const keyPath = process.env.VITE_DEV_HTTPS_KEY;

  if (!certPath || !keyPath) {
    throw new Error(
      'VITE_DEV_HTTPS=1 requires VITE_DEV_HTTPS_CERT and VITE_DEV_HTTPS_KEY',
    );
  }

  return {
    cert: readFileSync(certPath),
    key: readFileSync(keyPath),
  };
}

function readBackendUrl() {
  const backendUrl = process.env.VITE_BACKEND_URL?.trim();

  if (backendUrl) {
    return backendUrl.replace(/\/+$/, '');
  }

  return 'http://localhost:4000';
}

const backendUrl = readBackendUrl();
const backendWsUrl = backendUrl.replace(/^http/, 'ws');

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 3000,
    https: readHttpsConfig(),
    proxy: {
      '/api': backendUrl,
      '/ws': {
        target: backendWsUrl,
        ws: true,
      },
    },
  },
});
