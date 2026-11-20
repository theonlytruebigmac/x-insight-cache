/**
 * Static dashboard wiring check. app.js looks elements up with $('id'), which is
 * document.getElementById -- it silently returns null for anything that isn't a
 * bare id (e.g. a CSS selector), and the first property access then throws inside
 * an event handler. That once made the "Generate API key" button a no-op while every
 * server-side test still passed. Verify each literal $('...') names a real id.
 */
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../src/public/index.html', import.meta.url), 'utf8');
const js = readFileSync(new URL('../src/public/app.js', import.meta.url), 'utf8');
const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
const used = [...js.matchAll(/\$\('([^']*)'\)/g)].map((m) => m[1]);
// Also cover id lists such as `for (const id of ['a', 'b']) $(id)`.
for (const list of js.matchAll(/for \(const id of \[([^\]]+)\]\)/g)) {
  used.push(...[...list[1].matchAll(/'([^']+)'/g)].map((m) => m[1]));
}

const missing = [...new Set(used)].filter((id) => !ids.has(id));
if (missing.length) {
  console.log(`  FAIL dashboard looks up ids that do not exist in index.html: ${missing.join(', ')}`);
  process.exit(1);
}
console.log(`  ok   all ${new Set(used).size} element ids used by app.js exist in index.html`);
