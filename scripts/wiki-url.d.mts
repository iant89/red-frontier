/**
 * Wiki url derivation, as used by `scripts/publish-wiki.mjs`.
 *
 * `origin` is spelled differently on every machine, and the publisher used to
 * accept exactly one of the spellings — a remote with a trailing slash (copied
 * out of a browser address bar) died with "cannot derive a wiki url". These
 * cases pin every spelling, the credentials case, and the refusal to guess at a
 * remote that is not GitHub.
 */

export interface GithubRepo {
  userinfo: string;
  host: string;
  owner: string;
  repo: string;
}

/** `{owner, repo}` for a GitHub remote, or null when it is not one. */
export function parseGithubRepo(spec: unknown): GithubRepo | null;

/** `<owner>/<repo>.wiki.git` for a repository remote, or null when it is not one. */
export function wikiUrlFromRemote(remote: unknown): string | null;

/** Normalise an explicit `--url`; non-GitHub values pass through untouched. */
export function wikiUrlFromInput(input: unknown): string | null;

/** The human page for a wiki git url: `https://github.com/<owner>/<repo>/wiki`. */
export function wikiSiteUrl(url: unknown): string;
