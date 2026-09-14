/** Build identity and GitHub comparison used by the main-menu status badge. */

declare const __RF_BUILD_COMMIT__: string;

const REPOSITORY = 'iant89/red-frontier';
const MAIN_COMMIT_URL = `https://api.github.com/repos/${REPOSITORY}/commits/main`;
const SHA_PATTERN = /^[0-9a-f]{40}$/i;

/** Injected by Vite from GITHUB_SHA in Actions, or the local Git HEAD. */
export const BUILD_COMMIT =
  typeof __RF_BUILD_COMMIT__ === 'string' && SHA_PATTERN.test(__RF_BUILD_COMMIT__)
    ? __RF_BUILD_COMMIT__.toLowerCase()
    : null;

export type BuildState = 'latest' | 'old' | 'unknown';

export interface BuildAssessment {
  state: BuildState;
  current: string | null;
  latest: string | null;
}

function validSha(value: unknown): string | null {
  return typeof value === 'string' && SHA_PATTERN.test(value) ? value.toLowerCase() : null;
}

/** Compare full hashes; abbreviated hashes are display-only and never trusted. */
export function assessBuild(current: unknown, latest: unknown): BuildAssessment {
  const currentSha = validSha(current);
  const latestSha = validSha(latest);
  if (!currentSha || !latestSha) return { state: 'unknown', current: currentSha, latest: latestSha };
  return {
    state: currentSha === latestSha ? 'latest' : 'old',
    current: currentSha,
    latest: latestSha,
  };
}

let latestRequest: Promise<string> | null = null;

/**
 * Ask GitHub for main's current commit. Browsers cannot execute `gh`; this is
 * the equivalent public API request. The promise is shared so revisiting the
 * menu does not consume another unauthenticated API request.
 */
export function latestMainCommit(fetcher: typeof fetch = fetch): Promise<string> {
  if (!latestRequest) {
    latestRequest = fetcher(MAIN_COMMIT_URL, {
      cache: 'no-store',
      headers: { Accept: 'application/vnd.github+json' },
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
        const body = (await response.json()) as { sha?: unknown };
        const sha = validSha(body.sha);
        if (!sha) throw new Error('GitHub returned an invalid commit');
        return sha;
      })
      .catch((error) => {
        // A temporary network/rate-limit failure should be retryable if the
        // player comes back to the menu later.
        latestRequest = null;
        throw error;
      });
  }
  return latestRequest;
}

export function shortSha(sha: string | null): string {
  return sha?.slice(0, 7) ?? 'unknown';
}

/** The manifest the Vite build writes next to the bundle (vite.config.ts). */
export const MANIFEST_NAME = 'version.json';

/**
 * Ask the page's own origin which commit it is serving. The GitHub Pages
 * workflow uploads the built `dist/` tree — manifest included — as one
 * artifact, so the file that answers is by construction the build that is
 * live. This is the in-play update check's source of truth (TDD §23); the
 * GitHub API above answers a different question ("where is main?") and is
 * what the main-menu badge uses.
 */
export function latestDeployedCommit(
  fetcher: typeof fetch = fetch,
  url?: string,
): Promise<string> {
  // A fresh query string per call: CDN caches key on the full URL, so the
  // manifest can never be answered from a pre-deploy copy.
  const target =
    url ??
    (() => {
      try {
        return new URL(`${MANIFEST_NAME}?t=${Date.now()}`, document.baseURI).toString();
      } catch {
        return `${MANIFEST_NAME}?t=${Date.now()}`; // no DOM (tests): relative is enough
      }
    })();
  return fetcher(target, { cache: 'no-store' }).then(async (response) => {
    if (!response.ok) throw new Error(`manifest returned ${response.status}`);
    const body = (await response.json()) as { commit?: unknown };
    const sha = validSha(body.commit);
    if (!sha) throw new Error('manifest has no valid commit');
    return sha;
  });
}
