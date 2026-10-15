import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';

// Cryptographic helpers of the control channel:
//  - licence keys: random, shown once, stored only as keyed hashes;
//  - signed documents (`<b64url payload>.<b64url signature>`, Ed25519): grants and
//    release metadata signed by the central server only;
//  - device identity: an Ed25519 key pair generated on the installation; every
//    request after activation is signed with its private key.

// Crockford base32 without ambiguous characters.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** 100 bits of randomness: `FFL-XXXXX-XXXXX-XXXXX-XXXXX`. */
export function generateLicenseKey(): string {
  const bytes = randomBytes(20);
  let text = '';
  for (let i = 0; i < 20; i++) text += ALPHABET[bytes[i]! & 31];
  return `FFL-${text.match(/.{5}/g)!.join('-')}`;
}

/** Accepts lowercase, spaces and the usual look-alikes; returns null when malformed. */
export function normalizeLicenseKey(input: string): string | null {
  const compact = input.toUpperCase().replace(/[\s-]/g, '');
  if (!compact.startsWith('FFL')) return null;
  // Look-alikes are fixed only in the random part (the prefix itself contains an L).
  const body = compact.slice(3).replace(/O/g, '0').replace(/[IL]/g, '1');
  if (!/^[0-9A-HJKMNP-TV-Z]{20}$/.test(body)) return null;
  return `FFL-${body.match(/.{5}/g)!.join('-')}`;
}

/** Stable JSON with sorted keys: the exact bytes both sides sign and verify. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
}

export function toPublicKey(input: string | KeyObject): KeyObject {
  if (typeof input !== 'string') return input;
  // SPKI as PEM or base64url DER.
  return input.includes('BEGIN')
    ? createPublicKey(input)
    : createPublicKey({
        key: Buffer.from(input, 'base64url'),
        format: 'der',
        type: 'spki',
      });
}

export function publicKeyOf(privateKeyPem: string): KeyObject {
  return createPublicKey(createPrivateKey(privateKeyPem));
}

export function exportPublicKey(key: KeyObject): string {
  return key.export({ format: 'der', type: 'spki' }).toString('base64url');
}

export function fingerprintOf(publicKey: string | KeyObject): string {
  const der = toPublicKey(publicKey).export({ format: 'der', type: 'spki' });
  return createHash('sha256').update(der).digest('hex').slice(0, 32);
}

export function generateIdentity() {
  const pair = generateKeyPairSync('ed25519');
  return {
    publicKey: exportPublicKey(pair.publicKey),
    privateKeyPem: pair.privateKey
      .export({ format: 'pem', type: 'pkcs8' })
      .toString(),
  };
}

/** Normalizes a PEM that was passed through an environment variable or as base64. */
export function readPem(value: string): string {
  const trimmed = value.trim();
  if (trimmed.includes('BEGIN')) return trimmed.replace(/\\n/g, '\n');
  return Buffer.from(trimmed, 'base64').toString('utf8');
}

export function signDocument(privateKeyPem: string, payload: unknown): string {
  const body = Buffer.from(canonicalJson(payload));
  const signature = sign(null, body, createPrivateKey(privateKeyPem));
  return `${body.toString('base64url')}.${signature.toString('base64url')}`;
}

/** Verifies against any of the trusted public keys; returns the payload or null. */
export function verifyDocument<T>(
  document: string,
  trusted: (string | KeyObject)[],
): T | null {
  const [body, signature] = document.trim().split('.');
  if (!body || !signature) return null;
  try {
    const data = Buffer.from(body, 'base64url');
    const sig = Buffer.from(signature, 'base64url');
    for (const key of trusted)
      if (verify(null, data, toPublicKey(key), sig))
        return JSON.parse(data.toString('utf8')) as T;
  } catch {
    return null;
  }
  return null;
}

/** Detached signature over canonical JSON (device requests). */
export function signValue(privateKeyPem: string, value: unknown): string {
  return sign(
    null,
    Buffer.from(canonicalJson(value)),
    createPrivateKey(privateKeyPem),
  ).toString('base64url');
}

export function verifyValue(
  publicKey: string,
  value: unknown,
  signature: string,
): boolean {
  try {
    return verify(
      null,
      Buffer.from(canonicalJson(value)),
      toPublicKey(publicKey),
      Buffer.from(signature, 'base64url'),
    );
  } catch {
    return false;
  }
}
