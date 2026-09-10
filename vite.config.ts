import { execFileSync } from 'node:child_process';
import { defineConfig } from 'vite';

function buildCommit(): string {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

export default defineConfig({
  base: './',
  define: {
    // Browser code cannot run `gh`; stamp the checked-out commit into its bundle.
    __RF_BUILD_COMMIT__: JSON.stringify(buildCommit()),
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    // Allow the Arena live-preview host to reach the dev server.
    allowedHosts: true,
  },
  preview: {
    host: '0.0.0.0',
    port: 4173,
    allowedHosts: true,
  },
  build: {
    target: 'es2020',
    sourcemap: false,
    chunkSizeWarningLimit: 1200,
  },
});
