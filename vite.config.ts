import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

function buildCommit(): string {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

/**
 * The manifest's "what's new": the most recent non-merge commit subjects.
 * CI must check out with `fetch-depth: 0` (pages.yml), because main's HEAD
 * is a merge commit and a shallow clone would leave the list empty. Local
 * builds and the smoke tests get real subjects; anything without git
 * history degrades to an empty list and the update card says so.
 */
function buildNotes(): string[] {
  try {
    const out = execFileSync('git', ['log', '--no-merges', '--pretty=%s', '-n', 8, 'HEAD'], {
      encoding: 'utf8',
    });
    return out
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      // `--no-merges` already skips real merges, but on a shallow clone a
      // boundary merge cannot be followed and leaks through — the player's
      // changelog is for features, not "Merge pull request #49".
      .filter((s) => !/^merge (pull request|branch|remote-tracking|commit)/i.test(s))
      .slice(0, 8);
  } catch {
    return [];
  }
}

const BUILD_COMMIT = buildCommit();

/**
 * Ship `version.json` next to the bundle: the Pages workflow uploads this
 * exact `dist/` tree, so a deployed page asking its own origin "which commit
 * are you serving?" gets the answer for *what is actually live* — main can
 * sit ahead of a deploy (a failed smoke gate blocks publishing while main
 * keeps moving), and the GitHub API neither says that nor survives
 * unauthenticated rate limits (TDD §23).
 */
function buildManifest(commit: string, notes: string[]): Plugin {
  let outDir = 'dist';
  return {
    name: 'red-frontier:build-manifest',
    apply: 'build',
    configResolved(config) {
      outDir = config.build.outDir;
    },
    closeBundle() {
      writeFileSync(
        join(outDir, 'version.json'),
        `${JSON.stringify(
          { name: 'red-frontier', commit, builtAt: new Date().toISOString(), notes },
          null,
          2,
        )}\n`,
      );
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [buildManifest(BUILD_COMMIT, buildNotes())],
  define: {
    // Browser code cannot run `gh`; stamp the checked-out commit into its bundle.
    __RF_BUILD_COMMIT__: JSON.stringify(BUILD_COMMIT),
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
