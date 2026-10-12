// Copy canonical frontend sources into the static directory served by the Node API.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hosting = path.join(root, 'hosting');
const files = [
  ['auth.html', 'auth.html'], ['auth.html', 'index.html'],
  ['auth.js', 'auth.js'],
  ['db-service.js', 'db-service.js'], ['local-api.js', 'local-api.js'],
  ['local-auth.js', 'local-auth.js'], ['local-data.js', 'local-data.js'],
  ['reset-password.html', 'reset-password.html'], ['settings-behaviors.js', 'settings-behaviors.js'],
  ['receipt.js', 'receipt.js'], ['styles.css', 'styles.css'], ['app.js', 'app.js'],
  ['manifest.json', 'manifest.json'], ['sw.js', 'sw.js'], ['runtime-config.js', 'runtime-config.js']
];

fs.mkdirSync(path.join(hosting, 'app'), { recursive: true });
for (const folder of ['shared','staff','admin']) {
  fs.mkdirSync(path.join(hosting, folder), { recursive: true });
  fs.cpSync(path.join(root, folder), path.join(hosting, folder), { recursive: true });
}
fs.copyFileSync(path.join(root, 'display.html'), path.join(hosting, 'display.html'));
for (const [source, target] of files) fs.copyFileSync(path.join(root, source), path.join(hosting, target));
fs.cpSync(path.join(root, 'app'), path.join(hosting, 'app'), { recursive: true });
fs.mkdirSync(path.join(hosting, 'icons'), { recursive: true });
fs.cpSync(path.join(root, 'public', 'food'), path.join(hosting, 'food'), { recursive: true });
for (const icon of ['logo-180.png', 'logo-192.png', 'logo-512.png']) {
  fs.copyFileSync(path.join(root, 'public', 'icons', icon), path.join(hosting, 'icons', icon));
}
console.log('Render frontend assets copied from the canonical source files.');
