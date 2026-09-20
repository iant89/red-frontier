#!/usr/bin/env node
/**
 * Serve wiki/ like the GitHub wiki does, so a page can be read — and its links
 * clicked — before anything is published.
 *
 *   npm run wiki:preview              # http://localhost:5175
 *   node scripts/preview-wiki.mjs --port 8080
 *
 * Rendering is `marked` (GFM tables, as GitHub does). It is resolved at runtime and
 * deliberately not a project dependency:
 *
 *   npm i --no-save marked
 *
 * The same `.md` links that `publish-wiki.mjs` rewrites for the wiki are rewritten
 * here to local routes, so relative links work in both directions: the repo file,
 * this preview, and the published page.
 */

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WIKI = path.join(ROOT, 'wiki');
const argv = process.argv.slice(2);
const port = Number(argv[argv.indexOf('--port') + 1] || process.env.PORT || 5175);
const host = argv.includes('--host') ? argv[argv.indexOf('--host') + 1] : '0.0.0.0';

let marked;
try {
  marked = (await createRequire(import.meta.url)('marked')).marked;
  marked.setOptions({ gfm: true, breaks: false });
} catch {
  console.error('\n`marked` is not installed — this preview renders Markdown with it.\n' + '    npm i --no-save marked\n');
  process.exit(1);
}

if (!fs.existsSync(WIKI)) {
  console.error(`no wiki directory at ${path.relative(ROOT, WIKI)}`);
  process.exit(1);
}

const pages = new Map();
for (const f of fs.readdirSync(WIKI)) {
  if (f.endsWith('.md') && f !== 'README.md') pages.set(f.replace(/\.md$/, ''), fs.readFileSync(path.join(WIKI, f), 'utf8'));
}

/** `[text](Page)` / `(Page.md)` / `(Page#frag)` → local routes; external links pass through. */
function localize(html) {
  return html.replace(/href="(?!https?:|mailto:|#)([^"]+?)">/g, (full, href) => {
    const [file, anchor] = href.split('#');
    const name = file.replace(/\.md$/, '');
    if (!name) return full;
    if (!pages.has(name)) return full;
    return `href="/${name}${anchor ? `#${anchor}` : ''}">`;
  });
}

function render(body, title) {
  const chrome = (name) => localize(marked.parse(pages.get(name) ?? ''));
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title ? `${title} · ` : ''}Red Frontier wiki (preview)</title>
<style>
  :root { --bg:#0d1117; --panel:#161b22; --fg:#e6edf3; --muted:#9198a1; --line:#30363d; --accent:#ff7a45; }
  @media (prefers-color-scheme: light) { :root { --bg:#fff; --panel:#f6f8fa; --fg:#1f2328; --muted:#59636e; --line:#d1d9e0; --accent:#bc4c00; } }
  * { box-sizing:border-box }
  body { margin:0; background:var(--bg); color:var(--fg);
    font:15px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif; }
  .wrap { display:flex; gap:28px; max-width:1280px; margin:0 auto; padding:22px; align-items:flex-start }
  nav { flex:0 0 240px; position:sticky; top:22px; background:var(--panel); border:1px solid var(--line);
    border-radius:8px; padding:14px 16px; font-size:13.5px; max-height:calc(100vh - 44px); overflow:auto }
  nav h3 { margin:.4em 0 .3em; font-size:13px; letter-spacing:.02em }
  nav ul { margin:0; padding-left:1.1em }
  main { flex:1 1 auto; min-width:0; max-width:900px }
  article { border:1px solid var(--line); border-radius:8px; padding:8px 34px 30px; background:var(--bg) }
  footer { margin-top:20px; padding:14px 18px; border:1px dashed var(--line); border-radius:8px;
    color:var(--muted); font-size:13px }
  .banner { background:color-mix(in srgb, var(--accent) 16%, transparent); border:1px solid var(--accent);
    color:var(--fg); border-radius:8px; padding:8px 14px; margin-bottom:16px; font-size:13px }
  a { color:var(--accent); text-decoration:none } a:hover { text-decoration:underline }
  h1,h2,h3 { line-height:1.3; font-weight:600 } h1{font-size:2em;padding-bottom:.2em;border-bottom:1px solid var(--line)}
  h2{font-size:1.5em;padding-bottom:.2em;border-bottom:1px solid var(--line);margin-top:1.8em}
  h3{font-size:1.2em;margin-top:1.5em}
  code { background:color-mix(in srgb, var(--fg) 8%, transparent); padding:.16em .36em; border-radius:5px;
    font:85% ui-monospace,SFMono-Regular,Menlo,monospace }
  pre { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:14px; overflow:auto }
  pre code { background:none; padding:0 }
  table { border-collapse:collapse; display:block; overflow-x:auto; margin:14px 0; width:100%; font-size:14px }
  th,td { border:1px solid var(--line); padding:7px 12px; text-align:left; vertical-align:top }
  th { background:var(--panel); font-weight:600 }
  blockquote { margin:12px 0; padding:2px 16px; border-left:3px solid var(--line); color:var(--muted) }
  img { max-width:100%; border:1px solid var(--line); border-radius:8px }
  hr { border:0; border-top:1px solid var(--line); margin:20px 0 }
</style></head><body><div class="wrap">
<nav>${chrome('_Sidebar')}</nav>
<div><main>
  <div class="banner">Local preview of <code>wiki/</code> — not the published GitHub wiki.
  ${pages.size - 2} content pages, from <code>${path.relative(os.homedir(), WIKI)}</code>.</div>
  <article>${body}</article>
  <footer>${chrome('_Footer')}</footer>
</main></div></div></body></html>`;
}

const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml' };

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  const asset = path.join(WIKI, url.replace(/^\/+/, ''));
  if (url.startsWith('/assets/') && asset.startsWith(WIKI) && fs.existsSync(asset)) {
    res.writeHead(200, { 'content-type': MIME[path.extname(asset)] ?? 'application/octet-stream' });
    return res.end(fs.readFileSync(asset));
  }

  const name = url === '/' ? 'Home' : url.replace(/^\/+|\/+$/g, '').replace(/\.md$/, '');
  if (name === '' || name === 'Home' && !pages.has('Home')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(render('<h1>No Home.md</h1>', ''));
  }
  const src = pages.get(name);
  if (!src) {
    res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(
      render(`<h1>404 — no such page</h1><p><code>${name}</code> is not a file in <code>wiki/</code>.
       A published wiki would show the same thing, which is why
       <code>node scripts/publish-wiki.mjs --check</code> validates every link.</p>`, 'Not found'),
    );
  }
  const title = (src.match(/^#\s+(.+)$/m) ?? [, name])[1];
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(render(localize(marked.parse(src)), title));
});

server.listen(port, host, () => {
  console.log(`\n  Red Frontier wiki preview\n    http://${host === '0.0.0.0' ? 'localhost' : host}:${port}/\n  ${pages.size} pages from wiki/  (Ctrl-C to stop)\n`);
});
