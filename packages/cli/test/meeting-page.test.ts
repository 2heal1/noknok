import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { startHostedService } from '../src/hosted-service.js';
import { startRelay } from '../src/relay.js';
// Execute the built entrypoint used by the served page, not a separate renderer.
import { MeetingCache, startMeetingApp } from '../dist/web/meeting.js';

async function pageFixture(t, hosted) {
  const directory = await mkdtemp(join(tmpdir(), 'noknok-page-'));
  const service = hosted
    ? await startHostedService({ dataDir: directory, port: 0, publicUrl: 'http://127.0.0.1:4317' })
    : await startRelay({ port: 0 });
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  const origin = service.origin || service.url;
  const response = await fetch(origin + '/meeting');
  assert.equal(response.status, 200);
  const dom = new JSDOM(await response.text(), { url: `${origin}/meeting#id=ui-regression` });
  t.after(() => dom.window.close());
  const { document } = dom.window;
  for (const element of document.querySelectorAll('link[rel="stylesheet"]')) {
    const css = await fetch(new URL(element.getAttribute('href'), origin));
    assert.equal(css.status, 200);
    const style = document.createElement('style');
    style.textContent = await css.text();
    document.head.append(style);
  }
  const entry = document.querySelector('script[type="module"]');
  assert.ok(entry, 'The invitation destination must load the meeting app.');
  const script = await fetch(new URL(entry.getAttribute('src'), origin));
  assert.equal(script.status, 200);
  assert.equal(await script.text(), await readFile(new URL('../dist/web/meeting.js', import.meta.url), 'utf8'));
  return { origin, window: dom.window, document };
}

for (const hosted of [true, false]) {
  test(`${hosted ? 'hosted' : 'relay'} /meeting renders the current viewer and serves its actual brand dependencies`, async t => {
    const { origin, window, document } = await pageFixture(t, hosted);
    const globals = ['window', 'document', 'location', 'history', 'localStorage', 'Option'];
    const original = new Map(globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, value: window[key] });
    t.after(() => {
      window.dispatchEvent(new window.Event('beforeunload'));
      for (const key of globals) {
        const descriptor = original.get(key);
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globalThis[key];
      }
    });

    const participants = [
      { id: 'host', name: 'agent-codex', kind: 'agent', role: 'host' },
      { id: 'peer', name: 'agent-dot', kind: 'agent', role: 'member' },
      { id: 'other', name: 'Research agent', kind: 'agent', role: 'member' },
      { id: 'human', name: 'Claude Code', kind: 'human', role: 'member' },
    ];
    new MeetingCache(window.localStorage).save({
      meeting: { id: 'ui-regression', purpose: 'Synthetic discussion', context: 'Synthetic background', state: 'ended', hostId: 'host', participants },
      access: {}, mode: 'view', archived: true, snapshotCursor: 4,
      events: participants.map((p, index) => ({ seq: index + 1, from: p.id, type: 'message', at: '2026-10-14T00:00:00Z', data: { text: `Message from ${p.name}` } })),
    }, '');
    startMeetingApp();

    assert.equal(document.querySelector('#room').hidden, false);
    assert.equal(document.querySelectorAll('#timeline .message').length, 4);
    assert.equal(document.querySelector('#message-form').hidden, true, 'A saved read-only record must not expose the composer.');
    const logo = document.querySelector('.brand img');
    assert.ok(logo, 'The real meeting page must use the NokNok symbol.');
    assert.equal(new URL(logo.src).pathname, '/mark.svg');

    const messages = [...document.querySelectorAll('#timeline .message')];
    assert.equal(messages[0].querySelector('.avatar img').getAttribute('src'), '/agent-openai.svg');
    assert.equal(messages[1].querySelector('.avatar img').getAttribute('src'), '/agent-dot.svg');
    assert.equal(messages[2].querySelector('.avatar').textContent, 'RA');
    assert.equal(messages[3].querySelector('.avatar img'), null, 'A human name must not impersonate a model logo.');
    for (const message of messages) {
      const style = window.getComputedStyle(message.querySelector('.message-text'));
      assert.ok(['', '0px'].includes(style.borderTopWidth), 'Messages must use the plain viewer layout, not bordered bubbles.');
      assert.ok(['', 'rgba(0, 0, 0, 0)'].includes(style.backgroundColor), 'Messages must not regain colored chat bubbles.');
    }

    // Follow references from the rendered DOM. An unused logo file returning 200
    // is insufficient if the actual /meeting entrypoint never renders it.
    for (const image of document.querySelectorAll('img')) {
      const asset = await fetch(image.src);
      assert.equal(asset.status, 200, `Missing rendered image: ${new URL(image.src).pathname}`);
      assert.match(asset.headers.get('content-type'), /^image\/svg\+xml/);
      assert.match(await asset.text(), /<svg\b/);
    }
    assert.equal((await fetch(origin + '/avatar-catalog.js')).status, 200, 'The hosted server must serve the module imported by meeting.js.');

    const avatar = messages[0].querySelector('.avatar');
    avatar.querySelector('img').dispatchEvent(new window.Event('error'));
    assert.equal(avatar.querySelector('img'), null);
    assert.equal(avatar.textContent, 'AC');
    const toggle = document.querySelector('#toggle-details');
    const details = document.getElementById(toggle.getAttribute('aria-controls'));
    assert.equal(details.hidden, true);
    toggle.click();
    assert.equal(details.hidden, false);
    assert.equal(toggle.getAttribute('aria-expanded'), 'true');
    assert.equal(details.querySelector('#room-context').textContent, 'Synthetic background');
    toggle.click();
    assert.equal(details.hidden, true);
    assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  });
}
