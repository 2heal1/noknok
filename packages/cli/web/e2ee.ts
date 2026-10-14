/** Shared by the installed client and browser. Room keys never belong in HTTP requests. */
const PREFIX = 'nkenc1';
const MAX_PLAIN_BYTES = 64 * 1024;
const TAG_BYTES = 16;
const encoder = new TextEncoder();

function failure(code: string, message: string) { return Object.assign(new Error(message), { code }); }

function provider() {
  if (!globalThis.crypto?.subtle || typeof globalThis.crypto.getRandomValues !== 'function') {
    throw failure('E2EE_UNAVAILABLE', 'End-to-end encryption requires Web Crypto. Open the browser over HTTPS or localhost.');
  }
  return globalThis.crypto;
}

function encode(bytes: Uint8Array) {
  // Do not spread the whole ciphertext onto the call stack (contexts may be 64 KiB).
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function decode(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) throw new Error('Invalid base64url.');
  const binary = atob(value.replaceAll('-', '+').replaceAll('_', '/'));
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  if (encode(bytes) !== value) throw new Error('Noncanonical base64url.');
  return bytes;
}

export function validKey(key: unknown): key is string {
  if (typeof key !== 'string' || key.length !== 43) return false;
  try { return decode(key).length === 32; } catch { return false; }
}

export function generateKey(): string { return encode(provider().getRandomValues(new Uint8Array(32))); }

/** Stable, unambiguous authentication of cleartext routing context. */
export function contentAAD(encryptionId: string, type: string, from: string, field: string, to?: string, replyTo?: number): string {
  return JSON.stringify(['noknok-e2ee-v1', encryptionId, type, from, field, to ?? null, replyTo ?? null]);
}

function parts(wire: unknown, maxPlainBytes: number) {
  if (!Number.isSafeInteger(maxPlainBytes) || maxPlainBytes < 0 || maxPlainBytes > MAX_PLAIN_BYTES
    || typeof wire !== 'string' || wire.length > PREFIX.length + 18 + Math.ceil((maxPlainBytes + TAG_BYTES) * 4 / 3)) return undefined;
  const segments = wire.split('.');
  if (segments.length !== 3 || segments[0] !== PREFIX || segments[1].length !== 16) return undefined;
  try {
    const iv = decode(segments[1]), ciphertext = decode(segments[2]);
    if (iv.length !== 12 || ciphertext.length < TAG_BYTES || ciphertext.length > maxPlainBytes + TAG_BYTES) return undefined;
    return { iv, ciphertext };
  } catch { return undefined; }
}

/** Syntax and decoded size only; authentication happens exclusively in decryptText. */
export function isEncryptedText(wire: unknown, maxPlainBytes = MAX_PLAIN_BYTES): wire is string {
  return parts(wire, maxPlainBytes) !== undefined;
}

async function importKey(key: string, operation: 'encrypt' | 'decrypt') {
  if (!validKey(key)) throw failure('E2EE_INVALID_KEY', 'The end-to-end encryption key is missing or invalid.');
  return provider().subtle.importKey('raw', decode(key), { name: 'AES-GCM' }, false, [operation]);
}

export async function encryptText(key: string, text: string, aad: string): Promise<string> {
  if (typeof text !== 'string' || typeof aad !== 'string') throw failure('E2EE_INVALID_CONTENT', 'Encryption requires text and its authenticated context.');
  const plaintext = encoder.encode(text);
  if (plaintext.length > MAX_PLAIN_BYTES) throw failure('E2EE_INVALID_CONTENT', 'Encrypted content exceeds 64 KiB.');
  const imported = await importKey(key, 'encrypt');
  const iv = provider().getRandomValues(new Uint8Array(12));
  const ciphertext = await provider().subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(aad), tagLength: 128 }, imported, plaintext);
  return `${PREFIX}.${encode(iv)}.${encode(new Uint8Array(ciphertext))}`;
}

export async function decryptText(key: string, wire: string, aad: string): Promise<string> {
  const parsed = parts(wire, MAX_PLAIN_BYTES);
  if (!parsed || typeof aad !== 'string') throw failure('E2EE_INVALID_CONTENT', 'Expected valid encrypted content; plaintext fallback is forbidden.');
  const imported = await importKey(key, 'decrypt');
  try {
    const plaintext = await provider().subtle.decrypt({ name: 'AES-GCM', iv: parsed.iv, additionalData: encoder.encode(aad), tagLength: 128 }, imported, parsed.ciphertext);
    return new TextDecoder('utf-8', { fatal: true }).decode(plaintext);
  } catch {
    // Do not echo the key, wire payload or untrusted partially decrypted bytes.
    throw failure('E2EE_DECRYPTION_FAILED', 'Unable to authenticate encrypted content. The key, content or message context is incorrect.');
  }
}
