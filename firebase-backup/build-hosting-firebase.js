'use strict';

// Keep Firebase Hosting's static release in sync with the canonical source.
// Firebase Hosting only publishes hosting/, so credentials and server files
// never enter the frontend deployment.
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const hosting = path.join(root, 'hosting');
const files = [
  ['auth.html', 'auth.html'],
  ['auth.html', 'index.html'],
  ['auth.js', 'auth.js'],
  ['auth-extra.js', 'auth-extra.js'],
  ['db-service.js', 'db-service.js'],
  ['firebase.js', 'firebase.js'],
  ['reset-password.html', 'reset-password.html'],
  ['settings-behaviors.js', 'settings-behaviors.js'],
  ['receipt.js', 'receipt.js'],
  ['styles.css', 'styles.css'],
  ['app.js', 'app.js'],
  ['manifest.json', 'manifest.json'],
  ['sw.js', 'sw.js']
];

fs.mkdirSync(path.join(hosting, 'app'), { recursive: true });
for (const [source, target] of files) {
  fs.copyFileSync(path.join(root, source), path.join(hosting, target));
}
fs.copyFileSync(path.join(root, 'app', 'index.html'), path.join(hosting, 'app', 'index.html'));
console.log('Firebase Hosting assets refreshed from the canonical source files.');
