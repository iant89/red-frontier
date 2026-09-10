/**
 * Set up headless-Chromium screenshots in environments that have no system
 * NSS (this sandbox, minimal containers): installs the npm packages, builds
 * stub NSS shared libraries Chromium can link against, and smoke-tests a
 * real Playwright launch with WebGL.
 *
 * Usage:
 *   node scripts/setup-playwright.mjs [--dir <path>] [--rebuild] [--no-smoke]
 *
 * What it does, step by step:
 *   1. Installs `playwright` + `@sparticuz/chromium` with `--no-save`, in ONE
 *      `npm i` invocation. Two separate installs prune each other as
 *      extraneous — they must go in together. (Nothing is added to
 *      package.json; screenshot tooling stays out of the shipped deps.)
 *      Versions are pinned to the pair proven in this environment; when both
 *      are already present at those versions the install is skipped.
 *   2. If the loader already provides libnss3 (ordinary dev machines, CI
 *      runners), nothing else is needed and the stub build is skipped.
 *      Otherwise it compiles three tiny stub libraries — libnspr4.so,
 *      libnss3.so, libnssutil3.so — from the C sources embedded below. The
 *      sparticuz Chromium binary links against versioned NSS symbols, so the
 *      stubs carry the same symbol versions (see the .map files); the stub
 *      bodies return null/0, which is fine for local http:// screenshotting
 *      where no real certificate validation happens.
 *   3. Extracts the Chromium binary via `sparticuz.executablePath()` and runs
 *      a smoke test: launch through Playwright with the sparticuz flags,
 *      open a page, prove WebGL2 (which the game needs) is available.
 *
 * Consumers (e.g. scripts/screenshots.mjs in this environment) then launch
 * with the recipe printed at the end of a successful run:
 *   - executablePath: await sparticuz.executablePath()
 *   - args: sparticuz.args minus `--headless*` (Playwright passes its own
 *     headless flag; duplicates break the launch), plus
 *     `--disable-dev-shm-usage` for small-/dev/shm containers
 *   - env: LD_LIBRARY_PATH with the stub dir prepended (stub setups only)
 *
 * Operational notes learned the hard way:
 *   - The sparticuz build runs Chromium (near-)single-process: it exits when
 *     its last page/context closes, so long scripts should reuse one browser,
 *     one context and one page across scenarios.
 *   - Screenshots of this game's WebGL canvas work with plain
 *     `page.screenshot()` — no `preserveDrawingBuffer` needed.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// Proven pair — bump together and re-run the smoke test before committing.
const PLAYWRIGHT_PIN = '1.63.0';
const SPARTICUZ_PIN = '152.0.0';

const step = (msg) => console.log(`\n==> ${msg}`);
const fail = (msg) => {
  console.error(`\nsetup-playwright: ERROR: ${msg}`);
  process.exitCode = 1;
  process.exit(1);
};

// ---------------------------------------------------------------- args ----

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(
    'Usage: node scripts/setup-playwright.mjs [--dir <path>] [--rebuild] [--no-smoke]\n\n' +
      '  --dir <path>  where to build the NSS stubs (default: .playwright-libs/nss-stub)\n' +
      '  --rebuild     recompile the stubs even if they already exist\n' +
      '  --no-smoke    skip the Playwright launch smoke test',
  );
  process.exit(0);
}
const dirFlag = argv.indexOf('--dir');
const STUB_DIR =
  dirFlag >= 0 && argv[dirFlag + 1]
    ? resolve(ROOT, argv[dirFlag + 1])
    : join(ROOT, '.playwright-libs', 'nss-stub');
const REBUILD = argv.includes('--rebuild');
const SMOKE = !argv.includes('--no-smoke');

// ------------------------------------------------------------- sources ----

// Minimal NSPR: error plumbing plus a real microsecond clock (PR_Now), which
// Chromium calls on startup paths. No version script — Chromium references
// these symbols unversioned.
const NSPR_STUB_C = `#include <time.h>
#include <errno.h>
void PR_Init(void) {}
int PR_GetError(void) { return 0; }
int PR_GetErrorTextLength(void) { return 0; }
int PR_GetErrorText(void *p) { (void)p; return 0; }
int PR_GetOSError(void) { return errno; }
long long PR_Now(void) {
  struct timespec ts;
  clock_gettime(CLOCK_REALTIME, &ts);
  return (long long)ts.tv_sec * 1000000LL + ts.tv_nsec / 1000;
}
`;

// Every NSS symbol the sparticuz Chromium binary imports (see symbols.txt
// below), as inert stubs. Bodies return null/0: local http:// screenshots
// never exercise certificate validation.
const NSS_STUB_C = `void *CERT_DestroyCertList(void) { return 0; }
void *CERT_DestroyCertificate(void) { return 0; }
void *CERT_DupCertificate(void) { return 0; }
void *CERT_FindCertByDERCert(void) { return 0; }
void *CERT_GetCertTrust(void) { return 0; }
void *CERT_GetDefaultCertDB(void) { return 0; }
void *NSS_InitReadWrite(void) { return 0; }
void *NSS_NoDB_Init(void) { return 0; }
int NSS_VersionCheck(void) { return 1; }
void *PK11_FindCertInSlot(void) { return 0; }
void *PK11_FreeSlot(void) { return 0; }
void *PK11_GetInternalKeySlot(void) { return 0; }
void *PK11_GetTokenName(void) { return 0; }
void *PK11_InitPin(void) { return 0; }
void *PK11_IsPresent(void) { return 0; }
void *PK11_ListCerts(void) { return 0; }
void *PK11_NeedUserInit(void) { return 0; }
void *PK11_SetPasswordFunc(void) { return 0; }
void *SECITEM_AllocItem(void) { return 0; }
void *SECITEM_FreeItem(void) { return 0; }
void *PK11_GetModule(void) { return 0; }
void *PK11_ListCertsInSlot(void) { return 0; }
void *PK11_ReferenceSlot(void) { return 0; }
void *SECMOD_DestroyModule(void) { return 0; }
void *SECMOD_GetDefaultModuleList(void) { return 0; }
void *SECMOD_GetDefaultModuleListLock(void) { return 0; }
void *SECMOD_GetReadLock(void) { return 0; }
void *SECMOD_ReleaseReadLock(void) { return 0; }
void *CERT_CreateSubjectCertList(void) { return 0; }
void *PK11_HasRootCerts(void) { return 0; }
void *SECMOD_LoadUserModule(void) { return 0; }
void *CERT_IsUserCert(void) { return 0; }
void *PK11_DestroyGenericObjects(void) { return 0; }
void *PK11_FindGenericObjects(void) { return 0; }
void *PK11_GetNextGenericObject(void) { return 0; }
void *PK11_ReadRawAttribute(void) { return 0; }
void *PK11_HasAttributeSet(void) { return 0; }
`;

const NSSUTIL_STUB_C = `void *NSS_SetAlgorithmPolicy(void) { return 0; }
`;

// Linker version scripts: Chromium imports these symbols versioned
// (CERT_DestroyCertList@NSS_3.2, …), so the stubs must export the same
// symbol@version pairs or the loader refuses to start the browser.
const NSS_MAP = `NSS_3.2 {
  global:
    CERT_DestroyCertList;
    CERT_DestroyCertificate;
    CERT_DupCertificate;
    CERT_FindCertByDERCert;
    CERT_GetCertTrust;
    CERT_GetDefaultCertDB;
    NSS_InitReadWrite;
    NSS_NoDB_Init;
    NSS_VersionCheck;
    PK11_FindCertInSlot;
    PK11_FreeSlot;
    PK11_GetInternalKeySlot;
    PK11_GetTokenName;
    PK11_InitPin;
    PK11_IsPresent;
    PK11_ListCerts;
    PK11_NeedUserInit;
    PK11_SetPasswordFunc;
    SECITEM_AllocItem;
    SECITEM_FreeItem;
 local: *;
};
NSS_3.3 {
  global:
    PK11_GetModule;
    PK11_ListCertsInSlot;
    PK11_ReferenceSlot;
    SECMOD_DestroyModule;
    SECMOD_GetDefaultModuleList;
    SECMOD_GetDefaultModuleListLock;
    SECMOD_GetReadLock;
    SECMOD_ReleaseReadLock;

} NSS_3.2;
NSS_3.4 {
  global:
    CERT_CreateSubjectCertList;
    PK11_HasRootCerts;
    SECMOD_LoadUserModule;

} NSS_3.3;
NSS_3.6 {
  global:
    CERT_IsUserCert;

} NSS_3.4;
NSS_3.9.2 {
  global:
    PK11_DestroyGenericObjects;
    PK11_FindGenericObjects;
    PK11_GetNextGenericObject;
    PK11_ReadRawAttribute;

} NSS_3.6;
NSS_3.30 {
  global:
    PK11_HasAttributeSet;

} NSS_3.9.2;
`;

const NSSUTIL_MAP = `NSSUTIL_3.12.3 {
  global:
    NSS_SetAlgorithmPolicy;
  local: *;
};
`;

// Reference: `readelf -d` undefined imports of the Chromium binary, i.e. the
// contract the two version scripts above satisfy. If a sparticuz upgrade
// changes the binary, re-derive this list and extend the stubs.
const SYMBOLS_TXT = `CERT_CreateSubjectCertList@NSS_3.4
CERT_DestroyCertList@NSS_3.2
CERT_DestroyCertificate@NSS_3.2
CERT_DupCertificate@NSS_3.2
CERT_FindCertByDERCert@NSS_3.2
CERT_GetCertTrust@NSS_3.2
CERT_GetDefaultCertDB@NSS_3.2
CERT_IsUserCert@NSS_3.6
NSS_InitReadWrite@NSS_3.2
NSS_NoDB_Init@NSS_3.2
NSS_SetAlgorithmPolicy@NSSUTIL_3.12.3
NSS_VersionCheck@NSS_3.2
PK11_DestroyGenericObjects@NSS_3.9.2
PK11_FindCertInSlot@NSS_3.2
PK11_FindGenericObjects@NSS_3.9.2
PK11_FreeSlot@NSS_3.2
PK11_GetInternalKeySlot@NSS_3.2
PK11_GetModule@NSS_3.3
PK11_GetNextGenericObject@NSS_3.9.2
PK11_GetTokenName@NSS_3.2
PK11_HasAttributeSet@NSS_3.30
PK11_HasRootCerts@NSS_3.4
PK11_InitPin@NSS_3.2
PK11_IsPresent@NSS_3.2
PK11_ListCerts@NSS_3.2
PK11_ListCertsInSlot@NSS_3.3
PK11_NeedUserInit@NSS_3.2
PK11_ReadRawAttribute@NSS_3.9.2
PK11_ReferenceSlot@NSS_3.3
PK11_SetPasswordFunc@NSS_3.2
SECITEM_AllocItem@NSS_3.2
SECITEM_FreeItem@NSS_3.2
SECMOD_DestroyModule@NSS_3.3
SECMOD_GetDefaultModuleList@NSS_3.3
SECMOD_GetDefaultModuleListLock@NSS_3.3
SECMOD_GetReadLock@NSS_3.3
SECMOD_LoadUserModule@NSS_3.4
SECMOD_ReleaseReadLock@NSS_3.3
`;

// -------------------------------------------------------- 1. npm packages ----

function installedVersion(pkg) {
  // Read the manifest directly: `require.resolve('<pkg>/package.json')` fails
  // for packages whose `exports` map hides it (@sparticuz/chromium is one).
  try {
    const manifest = join(ROOT, 'node_modules', pkg, 'package.json');
    return JSON.parse(readFileSync(manifest, 'utf8')).version ?? null;
  } catch {
    return null;
  }
}

step(`npm packages (want playwright@${PLAYWRIGHT_PIN}, @sparticuz/chromium@${SPARTICUZ_PIN})`);
const havePw = installedVersion('playwright');
const haveSp = installedVersion('@sparticuz/chromium');
if (havePw === PLAYWRIGHT_PIN && haveSp === SPARTICUZ_PIN) {
  console.log(`already installed (playwright ${havePw}, sparticuz ${haveSp}) — skipping npm i`);
} else {
  console.log(
    `have playwright ${havePw ?? '—'}, sparticuz ${haveSp ?? '—'} — installing (single invocation!)`,
  );
  const r = spawnSync(
    'npm',
    ['i', '--no-save', `playwright@${PLAYWRIGHT_PIN}`, `@sparticuz/chromium@${SPARTICUZ_PIN}`],
    { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' },
  );
  if (r.status !== 0) fail('npm i failed — check network access and rerun');
}

// -------------------------------------------------- 2. NSS stubs (maybe) ----

function systemHasNss() {
  if (process.platform !== 'linux') return false;
  const r = spawnSync('ldconfig', ['-p'], { encoding: 'utf8' });
  if (r.status !== 0 || !r.stdout) return false;
  return r.stdout.split('\n').some((line) => line.includes('libnss3.so'));
}

function haveGcc() {
  const r = spawnSync('gcc', ['--version'], { stdio: 'ignore' });
  return r.status === 0;
}

const STUB_LIBS = ['libnspr4.so', 'libnss3.so', 'libnssutil3.so'];
let stubsNeeded = !systemHasNss();
step(`NSS libraries (${systemHasNss() ? 'system provides libnss3' : 'no system NSS detected'})`);
if (!stubsNeeded) {
  console.log('system NSS present — no stubs needed');
} else {
  if (!haveGcc()) {
    fail(
      'no system NSS and no gcc found. Install NSS (e.g. `apt install libnss3`) or a C compiler and rerun.',
    );
  }
  const fresh = STUB_LIBS.every((lib) => existsSync(join(STUB_DIR, lib)));
  if (fresh && !REBUILD) {
    console.log(`stubs already built in ${STUB_DIR} — skipping compile (use --rebuild to force)`);
  } else {
    console.log(`building stub libraries in ${STUB_DIR}`);
    mkdirSync(STUB_DIR, { recursive: true });
    writeFileSync(join(STUB_DIR, 'nspr_stub.c'), NSPR_STUB_C);
    writeFileSync(join(STUB_DIR, 'nss_stub.c'), NSS_STUB_C);
    writeFileSync(join(STUB_DIR, 'nssutil_stub.c'), NSSUTIL_STUB_C);
    writeFileSync(join(STUB_DIR, 'nss.map'), NSS_MAP);
    writeFileSync(join(STUB_DIR, 'nssutil.map'), NSSUTIL_MAP);
    writeFileSync(join(STUB_DIR, 'symbols.txt'), SYMBOLS_TXT);
    const cc = (out, src, map) => {
      const args = ['-shared', '-fPIC', '-O2', '-o', join(STUB_DIR, out), join(STUB_DIR, src)];
      if (map) args.push(`-Wl,--version-script=${join(STUB_DIR, map)}`);
      const r = spawnSync('gcc', args, { cwd: STUB_DIR, stdio: 'inherit' });
      if (r.status !== 0) fail(`compiling ${out} failed`);
    };
    cc('libnspr4.so', 'nspr_stub.c');
    cc('libnss3.so', 'nss_stub.c', 'nss.map');
    cc('libnssutil3.so', 'nssutil_stub.c', 'nssutil.map');
    console.log(`built ${STUB_LIBS.join(', ')}`);
  }
}

// ------------------------------------------------------- 3. smoke test ----

if (SMOKE) {
  step('smoke test: launch Chromium through Playwright');
  const { chromium } = await import('playwright');
  const sparticuzMod = await import('@sparticuz/chromium');
  const sparticuz = sparticuzMod.default ?? sparticuzMod;
  const exe = await sparticuz.executablePath();
  console.log(`browser binary: ${exe}`);
  // Playwright passes its own headless flag — the sparticuz `--headless`
  // would conflict, so it is filtered out (proven recipe, keep as is).
  const args = sparticuz.args.filter((a) => !a.startsWith('--headless'));
  args.push('--disable-dev-shm-usage');
  const env = { ...process.env };
  if (stubsNeeded) env.LD_LIBRARY_PATH = `${STUB_DIR}:${process.env.LD_LIBRARY_PATH ?? ''}`;
  const browser = await chromium.launch({ executablePath: exe, args, env });
  try {
    console.log(`browser up: ${browser.version()}`);
    const page = await browser.newPage();
    await page.goto('about:blank');
    const hasWebGL2 = await page.evaluate(
      () => !!document.createElement('canvas').getContext('webgl2'),
    );
    if (!hasWebGL2) fail('Chromium launched but WebGL2 is unavailable — screenshots would be blank');
    console.log('WebGL2 context: OK');
    await page.close();
  } finally {
    await browser.close();
  }
} else {
  console.log('\nskipping smoke test (--no-smoke)');
}

// -------------------------------------------------------------- summary ----

console.log('\nSetup complete.');
if (stubsNeeded) {
  console.log(`NSS stubs: ${STUB_DIR}`);
  console.log(`Launch env: LD_LIBRARY_PATH=${STUB_DIR}:$LD_LIBRARY_PATH`);
} else {
  console.log('NSS stubs: not needed on this machine (system libnss3)');
}
console.log(`Chromium: via (await import('@sparticuz/chromium')).executablePath()`);
console.log('Launch args: sparticuz.args minus --headless*, plus --disable-dev-shm-usage');
