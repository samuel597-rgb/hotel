'use strict';

// Copy the canonical browser modules into the static directory served by Render.
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const hosting = path.join(root, 'hosting');
const files = [
  ['auth.html', 'auth.html'], ['auth.html', 'index.html'],
  ['auth.js', 'auth.js'],
  ['db-service.js', 'db-service.js'], ['supabase.js', 'supabase.js'],
  ['supabase-auth.js', 'supabase-auth.js'], ['supabase-data.js', 'supabase-data.js'],
  ['reset-password.html', 'reset-password.html'], ['settings-behaviors.js', 'settings-behaviors.js'],
  ['receipt.js', 'receipt.js'], ['styles.css', 'styles.css'], ['app.js', 'app.js'],
  ['manifest.json', 'manifest.json'], ['sw.js', 'sw.js'], ['runtime-config.js', 'runtime-config.js']
];

fs.mkdirSync(path.join(hosting, 'app'), { recursive: true });
for (const [source, target] of files) fs.copyFileSync(path.join(root, source), path.join(hosting, target));
fs.copyFileSync(path.join(root, 'app', 'index.html'), path.join(hosting, 'app', 'index.html'));
console.log('Render frontend assets copied from the canonical source files.');
