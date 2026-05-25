import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const demoPath = path.resolve(process.cwd(), '../examples/autorecipe-popup-demo.html');

test('AutoRecipe popup demo fixture covers search, popup and after-popup refresh', () => {
  const html = fs.readFileSync(demoPath, 'utf8');

  assert.match(html, /fetch\('\/api\/search'/);
  assert.match(html, /window\.open\('/);
  assert.match(html, /fetch\('\/api\/popup\/select'/);
  assert.match(html, /window\.opener\.postMessage/);
  assert.match(html, /window\.close\(\)/);
  assert.match(html, /fetch\('\/api\/search\/refresh-after-popup'/);
  assert.match(html, /password: 'must-not-be-captured'/);
  assert.match(html, /token: 'must-not-be-captured'/);
  assert.match(html, /accessToken: 'must-not-be-captured'/);
});
