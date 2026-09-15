import type { Env } from '../env';

/** Plaid access tokens are stored as "v1.<iv>.<ciphertext>" using AES-256-GCM. */
const VERSION = 'v1';

const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const fromBase64 = (text: string) => Uint8Array.from(atob(text), (ch) => ch.charCodeAt(0));

async function importKey(env: Env): Promise<CryptoKey> {
  if (!env.TOKEN_ENC_KEY) throw new Error('TOKEN_ENC_KEY is not set');
  const raw = fromBase64(env.TOKEN_ENC_KEY);
  if (raw.byteLength !== 32) throw new Error('TOKEN_ENC_KEY must be 32 bytes, base64-encoded');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encryptToken(env: Env, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await importKey(env), new TextEncoder().encode(plaintext));
  return `${VERSION}.${toBase64(iv)}.${toBase64(new Uint8Array(cipher))}`;
}

export async function decryptToken(env: Env, stored: string): Promise<string> {
  const [version, iv, data] = stored.split('.');
  if (version !== VERSION || !iv || !data) throw new Error('Unrecognized token format');
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(iv) }, await importKey(env), fromBase64(data));
  return new TextDecoder().decode(plain);
}
