import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { staticClient } from 'fumadocs-core/search/client/orama-static';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'out');
const content = path.join(root, 'docs-site/content/docs');
const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
async function files(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  return (await Promise.all(entries.map(e => e.isDirectory() ? files(path.join(dir, e.name)) : path.join(dir, e.name)))).flat();
}
async function isFile(file) { try { return (await stat(file)).isFile(); } catch { return false; } }
async function targetExists(url) {
  const pathname = decodeURIComponent(new URL(url, 'https://msk.invalid').pathname);
  const file = path.join(output, pathname);
  return await isFile(file) || await isFile(path.join(file, 'index.html')) || await isFile(file + '.html');
}
assert(await isFile(path.join(output, 'index.html')), 'Run npm run build first');
const pages = (await files(content)).filter(f => f.endsWith('.mdx'));
for (const page of pages) {
  const relative = path.relative(content, page).replaceAll(path.sep, '/').replace(/\.mdx$/, '').replace(/(^|\/)index$/, '');
  assert(await targetExists('/docs/' + relative), `Missing rendered page: ${relative}`);
  const text = await readFile(page, 'utf8');
  for (const match of text.matchAll(/https:\/\/github\.com\/New1Direction\/MSK\/blob\/main\/([^\s)"#]+)/g)) {
    assert(await isFile(path.join(root, decodeURIComponent(match[1]))), `Missing repository reference in ${relative}: ${match[1]}`);
  }
}
let localLinks = 0;
const htmlFiles = (await files(output)).filter(f => f.endsWith('.html'));
const checked = new Set();
for (const file of htmlFiles) {
  const html = await readFile(file, 'utf8');
  assert(/<html[^>]*lang="en"/.test(html), `Missing document language: ${file}`);
  assert(/<title>[^<]+<\/title>/.test(html), `Missing title: ${file}`);
  for (const match of html.matchAll(/<(?:a|link|script|img)\b[^>]*?\b(?:href|src)="(\/[^"<>]*)"/g)) {
    const href = match[1].replaceAll('&amp;', '&');
    if (href.startsWith('//') || checked.has(href)) continue;
    checked.add(href);
    assert(await targetExists(href), `Broken local target ${href} in ${path.relative(output, file)}`);
    localLinks++;
  }
}
const payload = await readFile(path.join(output, 'search-index.json'), 'utf8');
assert.equal(JSON.parse(payload).type, 'advanced');
const originalFetch = globalThis.fetch;
globalThis.fetch = async url => {
  assert.equal(url, '/search-index.json', 'Search must use the exported local index');
  return new Response(payload, { headers: { 'Content-Type': 'application/json' } });
};
try {
  const client = staticClient({ from: '/search-index.json' });
  for (const skill of manifest.skills) {
    const doc = path.join(content, 'skills', skill.name + '.mdx');
    assert(await isFile(doc), `Missing skill documentation: ${skill.name}`);
    const text = await readFile(doc, 'utf8');
    const title = JSON.parse(text.match(/^title: (".*")$/m)[1]);
    const results = await client.search(title);
    assert(results.some(result => result.url.split('#')[0].replace(/\/$/, '') === '/docs/skills/' + skill.name), `Search did not find ${skill.name}`);
  }
} finally { globalThis.fetch = originalFetch; }
console.log(`Docs verified: ${pages.length} pages, ${manifest.skills.length} skill searches, ${localLinks} distinct local links/assets.`);
