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
