/**
 * GitHub wiki URL derivation, shared by `scripts/publish-wiki.mjs` and its tests.
 *
 * A page wiki lives in its own repository, `<owner>/<repo>.wiki.git`, so the
 * publisher has to turn whatever `origin` happens to be into that address. The
 * address appears in the wild in several spellings — an HTTPS clone copied from
 * the repository page, an `scp`-style SSH remote, a URL with a trailing slash
 * because it came from a browser address bar, a URL with a token embedded in it —
 * and every one of them means the same wiki. Keeping the parsing here, rather
 * than in one regex at the call site, is what lets the unit tests pin all of the
 * spellings instead of only the one the author happened to have configured.
 *
 * Deliberately dependency-free (no node_modules) so publishing works from a
 * fresh checkout.
 */

const GITHUB_HOST = 'github.com';

/** Trim surrounding whitespace, then drop trailing slashes and a `.git` suffix. */
function bare(spec) {
  return String(spec ?? '')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '');
}

/**
 * Pull `{ userinfo, host, owner, repo }` out of a GitHub remote, or return null
 * when the argument is not one.
 *
 * Extra path segments are ignored, so a URL copied out of the browser
 * (`https://github.com/o/r/tree/main`, `…/r/wiki`, `…/r/issues/12`) still yields
 * the repository; a remote pointed straight at a wiki (`<repo>.wiki.git`) yields
 * the repository too, rather than `<repo>.wiki.wiki.git`.
 */
export function parseGithubRepo(spec) {
  const s = bare(spec);
  if (!s) return null;

  // `https://[user[:token]@]github.com/owner/repo` and friends.
  const scheme = s.match(/^([a-zA-Z][\w+.-]*):\/\/(.*)$/);
  // `git@github.com:owner/repo` — the scp-like spelling has no `//` after the colon.
  const scp = s.match(/^(?:[^@/\s]+@)?([^:/\s]+):([^/].*)$/);

  let userinfo = '';
  let host = '';
  let rest = '';

  if (scheme) {
    const proto = scheme[1].toLowerCase();
    rest = scheme[2];
    const slash = rest.indexOf('/');
    const authority = slash === -1 ? rest : rest.slice(0, slash);
    const at = authority.lastIndexOf('@');
    // Only http(s) carries credentials worth keeping — a token in the remote is how
    // the publisher authenticates. The `git@` of an ssh remote is a login name that
    // would be a nonsense username in the https url we derive; either way it has to
    // come off the authority before the host is read.
    const userPart = at === -1 ? '' : authority.slice(0, at + 1);
    const kept = at !== -1 && (proto === 'http' || proto === 'https');
    userinfo = kept ? userPart : '';
    host = authority.slice(userPart.length).toLowerCase();
    rest = slash === -1 ? '' : rest.slice(slash + 1);
  } else if (scp) {
    host = scp[1].toLowerCase();
    rest = scp[2];
  } else {
    return null;
  }

  if (host !== GITHUB_HOST) return null;
  const segments = rest.split('/').filter(Boolean);
  if (segments.length < 2) return null;
  const owner = segments[0];
  const repo = segments[1].replace(/\.wiki$/i, '');
  if (!owner || !repo) return null;
  return { userinfo, host, owner, repo };
}

/**
 * The wiki git url for a repository remote: `origin` in, `<owner>/<repo>.wiki.git`
 * out. Returns null when the remote is not a GitHub repository url, which the
 * caller reports as "pass --url" rather than guessing.
 */
export function wikiUrlFromRemote(remote) {
  const p = parseGithubRepo(remote);
  return p ? wikiUrlOf(p) : null;
}

/**
 * Normalise an explicit `--url`. A recognisable GitHub url is canonicalised like a
 * remote (so `--url https://github.com/o/r` works); anything else — an enterprise
 * host, a local path — is passed through untouched apart from trailing slashes and
 * a missing `.git`, because an explicit flag is the user overriding the guess.
 */
export function wikiUrlFromInput(input) {
  const s = bare(input);
  if (!s) return null;
  const p = parseGithubRepo(s);
  if (p) return wikiUrlOf(p);
  return /\.wiki$/i.test(s) ? `${s}.git` : s;
}

/** `https://github.com/<owner>/<repo>.wiki.git` */
function wikiUrlOf({ userinfo, host, owner, repo }) {
  return `https://${userinfo}${host}/${owner}/${repo}.wiki.git`;
}

/** The human page — `https://github.com/<owner>/<repo>/wiki` — for the success line. */
export function wikiSiteUrl(url) {
  const p = parseGithubRepo(url);
  return p ? `https://${p.host}/${p.owner}/${p.repo}/wiki` : String(url);
}
