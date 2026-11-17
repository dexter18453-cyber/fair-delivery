'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

test('Render deployment refuses an ephemeral production data store', () => {
  const result = spawnSync(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, RENDER: 'true', DATABASE_URL: '', DEMO_MODE: 'false' },
    encoding: 'utf8',
    timeout: 5000
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Ασφαλής εκκίνηση: απαιτείται DATABASE_URL/);
});
