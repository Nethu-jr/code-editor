import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  // Monaco ships its own worker bundles. Vite handles these correctly when
  // we let it: just `import * as monaco from 'monaco-editor'` and Vite's
  // worker plugin compiles editor.worker.js etc. on the fly.
  optimizeDeps: { include: ['monaco-editor'] },
});
