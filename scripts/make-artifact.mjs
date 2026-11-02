// Turns dist/ (a normal web build) into artifact/: an Artifact page body with inlined CSS,
// plus the JS bundle and the MuJoCo .wasm as supporting files.
import fs from 'node:fs';
import path from 'node:path';

const dist = 'dist', out = 'artifact';
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'assets'), { recursive: true });
const html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
const body = html.slice(html.indexOf('<body>') + 6, html.lastIndexOf('</body>'));
const head = html.slice(html.indexOf('<head>') + 6, html.indexOf('</head>'));
const css = [...head.matchAll(/<link rel="stylesheet"[^>]*href="\.\/(assets\/[^"]+\.css)"[^>]*>/g)].map((m) => fs.readFileSync(path.join(dist, m[1]), 'utf8')).join('\n');
const scripts = [...head.matchAll(/<script type="module"[^>]*src="\.\/(assets\/[^"]+\.js)"[^>]*><\/script>/g)].map((m) => m[1]);
// body already starts with <title> and the meta tag; put the styles right after them
let page = body.replace(/<script type="module" src="\/src\/app\.js"><\/script>\s*/, '');
const cut = page.indexOf('<div id="app">');
page = page.slice(0, cut) + `<style>\n${css}\n</style>\n` + page.slice(cut) + scripts.map((s) => `<script type="module" src="${s}"></script>`).join('\n') + '\n';
fs.writeFileSync(path.join(out, 'index.html'), page);
for (const f of fs.readdirSync(path.join(dist, 'assets'))) if (!f.endsWith('.css')) fs.copyFileSync(path.join(dist, 'assets', f), path.join(out, 'assets', f));
console.log('artifact/ ready:', fs.readdirSync(path.join(out, 'assets')).join(', '));
