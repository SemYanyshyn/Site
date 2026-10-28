import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import type { Plugin } from 'vite';

const projectRoot = fileURLToPath(new URL('.', import.meta.url));

// Keep the existing development stylesheet URL available while all authored
// styles use SCSS. Both URLs reach Vite's normal Sass/HMR pipeline.
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
  const port = process.env.PORT ?? loadEnv(mode, projectRoot, '').PORT ?? '3000';
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    throw new Error('PORT має бути цілим числом від 1 до 65535.');
  }

  return {
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
