import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import type { Plugin } from 'vite';
import { normalizeApiBase } from './src/shared/public-api.js';

const projectRoot = fileURLToPath(new URL('.', import.meta.url));

const developmentStyleUrl: Plugin = {
  name: 'development-style-url',
  apply: 'serve',
  configureServer(server) {
    server.middlewares.use((request, response, next) => {
      const url = request.url ?? '';
      if (/^\/styles\.scss(?:\?|$)/u.test(url)) {
        response.writeHead(307, { Location: url.replace(/^\/styles\.scss/u, '/styles.css') });
        response.end();
        return;
      }
      if (/^\/styles\.css(?:\?|$)/u.test(url)) {
        request.url = url.replace(/^\/styles\.css/u, '/styles.scss');
      }
      next();
    });
  },
};

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, projectRoot, '');
  const port = process.env.PORT ?? environment.PORT ?? '3000';
  normalizeApiBase(process.env.VITE_API_BASE_URL ?? environment.VITE_API_BASE_URL);
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    throw new Error('PORT має бути цілим числом від 1 до 65535.');
  }

  const pagesBase = process.env.PAGES_BASE_PATH === '' ? '/' : process.env.PAGES_BASE_PATH ?? '/Site/';
  if (mode === 'pages' && (!/^\/(?:[A-Za-z0-9_.-]+\/?)*$/u.test(pagesBase)
    || pagesBase.split('/').some((part) => part === '.' || part === '..'))) {
    throw new Error('PAGES_BASE_PATH має бути абсолютним шляхом сайту.');
  }

  return {
    base: mode === 'pages' ? `${pagesBase.replace(/\/$/u, '')}/` : '/',
    plugins: [developmentStyleUrl],
    root: fileURLToPath(new URL('./src/client', import.meta.url)),
    envDir: projectRoot,
    server: {
      host: '127.0.0.1',
      port: 5173,
      strictPort: true,
      proxy: { '^/api(?:/|$)': `http://127.0.0.1:${port}` },
    },
    build: {
      outDir: fileURLToPath(new URL('./dist/client', import.meta.url)),
      emptyOutDir: true,
    },
  };
});
