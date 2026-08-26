'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(ROOT, 'src/renderer/app.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'src/renderer/index.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'src/renderer/styles.css'), 'utf8');

describe('renderer dialog UI', () => {
  it('provides a custom alert/confirm/prompt surface', () => {
    for (const id of [
      'app-dialog',
      'app-dialog-title',
      'app-dialog-message',
      'app-dialog-input',
      'app-dialog-cancel',
      'app-dialog-ok',
    ]) {
      assert.match(html, new RegExp(`id=["']${id}["']`), id);
    }
    assert.match(app, /function showAppDialog\b/);
    assert.match(app, /function appConfirm\b/);
    assert.match(app, /function appPrompt\b/);
    assert.match(css, /\.app-dialog-card\b/);
  });

  it('does not call browser-native alert, confirm, or prompt', () => {
    assert.doesNotMatch(app, /\b(?:alert|confirm|prompt)\s*\(/);
  });
});
