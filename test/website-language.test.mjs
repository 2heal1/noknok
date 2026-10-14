import assert from 'node:assert/strict';
import test from 'node:test';
import { languageStorageKey, readLanguage, resolveLanguage, saveLanguage } from '../website/language.js';

test('language selection recognizes Chinese regions and scripts regardless of case', () => {
  for (const language of ['zh', 'zh-CN', 'zh-TW', 'zh-Hant-HK', 'ZH-cn']) {
    assert.equal(resolveLanguage({ languages: [language] }), 'zh', language);
    assert.equal(resolveLanguage({ language }), 'zh', language);
  }
  for (const language of ['en', 'en-GB', 'fr-FR', 'zhang', 'zh_CN', undefined]) {
    assert.equal(resolveLanguage({ language }), 'en', String(language));
  }
  assert.equal(resolveLanguage(), 'en');
});

test('only the first browser preference selects the language, with a single-language fallback', () => {
  assert.equal(resolveLanguage({ languages: ['en-US', 'zh-CN'], language: 'zh-CN' }), 'en');
  assert.equal(resolveLanguage({ languages: ['fr-FR', 'zh-TW'] }), 'en');
  assert.equal(resolveLanguage({ languages: ['zh-Hant-HK', 'en-US'], language: 'en-US' }), 'zh');
  assert.equal(resolveLanguage({ languages: [], language: 'zh-TW' }), 'zh');
  assert.equal(resolveLanguage({ languages: [], language: 'de-DE' }), 'en');
});

test('a valid saved choice overrides browser preferences while invalid storage values are ignored', () => {
  assert.equal(resolveLanguage({ storedLanguage: 'en', languages: ['zh-CN'] }), 'en');
  assert.equal(resolveLanguage({ storedLanguage: 'zh', languages: ['en-US'] }), 'zh');
  for (const storedLanguage of ['', 'fr', 'ZH', '{broken', null, undefined]) {
    assert.equal(resolveLanguage({ storedLanguage, languages: ['zh-CN'] }), 'zh');
    assert.equal(resolveLanguage({ storedLanguage, languages: ['en-US', 'zh-CN'] }), 'en');
  }
});

test('reading preferences uses the website key and survives missing or denied storage', () => {
  const storage = { getItem(key) { assert.equal(key, 'noknok.website.language'); return 'en'; } };
  assert.equal(languageStorageKey, 'noknok.website.language');
  assert.equal(readLanguage(storage, { languages: ['zh-CN'] }), 'en');
  assert.equal(readLanguage({ getItem() { return '{broken'; } }, { language: 'zh-TW' }), 'zh');
  const denied = { getItem() { throw new Error('Storage denied'); } };
  assert.equal(readLanguage(denied, { languages: ['zh-Hant-HK'] }), 'zh');
  assert.equal(readLanguage(denied, {}), 'en');
  assert.equal(readLanguage(undefined, { language: 'zh-CN' }), 'zh');
  assert.equal(readLanguage(), 'en');
});

test('saving preferences accepts only explicit supported choices and reports denied writes', () => {
  const writes = [];
  const storage = { setItem(key, value) { writes.push([key, value]); } };
  assert.equal(saveLanguage(storage, 'zh'), true);
  assert.equal(saveLanguage(storage, 'en'), true);
  for (const language of ['zh-CN', 'ZH', 'fr', '', null, undefined]) {
    assert.equal(saveLanguage(storage, language), false);
  }
  assert.deepEqual(writes, [[languageStorageKey, 'zh'], [languageStorageKey, 'en']]);
  assert.equal(saveLanguage({ setItem() { throw new Error('Quota exceeded'); } }, 'zh'), false);
  assert.equal(saveLanguage(undefined, 'en'), false);
});
