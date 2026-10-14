import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { generateKey, validKey, encryptText, decryptText, isEncryptedText, contentAAD } from '../src/e2ee.js';

const encode = (value: Buffer) => value.toString('base64url');
const aad = contentAAD('room-encryption-id', 'message', 'participant-id', 'text', 'recipient-id', 3);

test('room keys are independent, random, canonical 256-bit keys', () => {
  const keys = new Set(Array.from({ length: 128 }, () => generateKey()));
  assert.equal(keys.size, 128);
  for (const key of keys) assert.equal(validKey(key), true);
  for (const key of [undefined, null, 1, '', 'a'.repeat(42), 'a'.repeat(44), 'A'.repeat(42) + 'B', 'A'.repeat(42) + '=', ' '.repeat(43)]) {
    assert.equal(validKey(key), false);
  }
});

test('AES-256-GCM known-answer empty-message vector authenticates with a full 128-bit tag', async () => {
  // NIST GCM test case: all-zero 256-bit key and 96-bit IV, empty plaintext/AAD.
  const key = encode(Buffer.alloc(32));
  const iv = encode(Buffer.alloc(12));
  const tag = encode(Buffer.from('530f8afbc74536b9a963b4f1c4cb738b', 'hex'));
  assert.equal(await decryptText(key, `nkenc1.${iv}.${tag}`, ''), '');
});

test('Web Crypto encryption interoperates with Node AES-256-GCM and UTF-8', async () => {
  const key = generateKey(), text = '机密上下文 — 🦉\nline two\u0000';
  const wire = await encryptText(key, text, aad);
  assert.equal(isEncryptedText(wire), true);
  const [, iv, payload] = wire.split('.'), bytes = Buffer.from(payload, 'base64url');
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(key, 'base64url'), Buffer.from(iv, 'base64url'));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(bytes.subarray(-16));
  assert.equal(Buffer.concat([decipher.update(bytes.subarray(0, -16)), decipher.final()]).toString(), text);
  const second = await encryptText(key, text, aad);
  assert.notEqual(second.split('.')[1], iv, 'Every encryption obtains a fresh 96-bit IV.');
  assert.equal(await decryptText(key, wire, aad), text);
});

test('Node ciphertext interoperates; wrong key, ciphertext, IV, tag and every AAD field fail closed', async () => {
  const key = generateKey(), iv = randomBytes(12), text = 'Only intended participants can read this';
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'base64url'), iv);
  cipher.setAAD(Buffer.from(aad));
  const bytes = Buffer.concat([cipher.update(text), cipher.final(), cipher.getAuthTag()]);
  const wire = `nkenc1.${encode(iv)}.${encode(bytes)}`;
  assert.equal(await decryptText(key, wire, aad), text);
  await assert.rejects(decryptText(generateKey(), wire, aad), { code: 'E2EE_DECRYPTION_FAILED' });
  for (const offset of [0, bytes.length - 1]) {
    const changed = Buffer.from(bytes); changed[offset] ^= 1;
    await assert.rejects(decryptText(key, `nkenc1.${encode(iv)}.${encode(changed)}`, aad), { code: 'E2EE_DECRYPTION_FAILED' });
  }
  const changedIv = Buffer.from(iv); changedIv[0] ^= 1;
  await assert.rejects(decryptText(key, `nkenc1.${encode(changedIv)}.${encode(bytes)}`, aad), { code: 'E2EE_DECRYPTION_FAILED' });
  const context = JSON.parse(aad);
  for (let index = 0; index < context.length; index++) {
    const changed = [...context]; changed[index] = index === 6 ? 4 : `${changed[index]}-changed`;
    await assert.rejects(decryptText(key, wire, JSON.stringify(changed)), { code: 'E2EE_DECRYPTION_FAILED' });
  }
});

test('encrypted content syntax rejects plaintext, noncanonical base64url, short tags and unsupported versions', async () => {
  const wire = await encryptText(generateKey(), '', aad);
  const [, iv, payload] = wire.split('.');
  const alteredTrailingBits = payload.slice(0, -1) + 'B';
  for (const value of [undefined, {}, 1, '', 'plaintext', wire.replace('nkenc1', 'nkenc2'), `${wire}.extra`, `${wire}=`,
    `nkenc1.${iv}=.${payload}`, `nkenc1.${iv}.`, `nkenc1.${iv}.${encode(Buffer.alloc(15))}`, `nkenc1.${iv}.${alteredTrailingBits}`, `nkenc1.${iv}.a`]) {
    assert.equal(isEncryptedText(value), false, `Should reject ${String(value)}`);
  }
  await assert.rejects(decryptText(generateKey(), 'plaintext', aad), { code: 'E2EE_INVALID_CONTENT' });
  await assert.rejects(decryptText('bad-key', wire, aad), { code: 'E2EE_INVALID_KEY' });
});

test('field limits count decoded UTF-8 plaintext bytes and enforce the 64 KiB ceiling', async () => {
  const key = generateKey(), wire = await encryptText(key, '机密', aad);
  assert.equal(isEncryptedText(wire, 6), true);
  assert.equal(isEncryptedText(wire, 5), false);
  assert.equal(isEncryptedText(await encryptText(key, '', aad), 0), true);
  for (const max of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 65537]) assert.equal(isEncryptedText(wire, max), false);
  const maximum = 'a'.repeat(65536), large = await encryptText(key, maximum, aad);
  assert.equal(isEncryptedText(large), true);
  assert.equal(await decryptText(key, large, aad), maximum);
  await assert.rejects(encryptText(key, `${maximum}a`, aad), { code: 'E2EE_INVALID_CONTENT' });
});

test('authenticated invalid UTF-8 is rejected instead of producing corrupted plaintext', async () => {
  const key = generateKey(), iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'base64url'), iv);
  cipher.setAAD(Buffer.from(aad));
  const bytes = Buffer.concat([cipher.update(Buffer.from([0xc3, 0x28])), cipher.final(), cipher.getAuthTag()]);
  await assert.rejects(decryptText(key, `nkenc1.${encode(iv)}.${encode(bytes)}`, aad), { code: 'E2EE_DECRYPTION_FAILED' });
});

test('AAD distinguishes absent and explicit routing, fields, and delimiters inside values', () => {
  assert.equal(contentAAD('room', 'started', 'system', 'purpose'), '["noknok-e2ee-v1","room","started","system","purpose",null,null]');
  assert.notEqual(contentAAD('a,b', 'c', 'd', 'e'), contentAAD('a', 'b,c', 'd', 'e'));
  assert.notEqual(contentAAD('room', 'message', 'sender', 'text'), contentAAD('room', 'message', 'sender', 'text', 'recipient'));
});
