import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
  type ScryptOptions,
} from 'node:crypto';

// scrypt parameters (N=2^15, r=8, p=1, ~32 MiB) follow OWASP guidance and need
// no native dependency. Parameters are stored with each hash so they can evolve.
const SCRYPT = { N: 32768, r: 8, p: 1, keyLength: 32 } as const;

function scrypt(
  secret: string | Buffer,
  salt: Buffer,
  keyLength: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(secret, salt, keyLength, options, (error, key) =>
      error ? reject(error) : resolve(key),
    );
  });
}

export async function hashSecret(secret: string | Buffer): Promise<string> {
  const salt = randomBytes(16);
  const { N, r, p, keyLength } = SCRYPT;
  const key = await scrypt(secret, salt, keyLength, {
    N,
    r,
    p,
    maxmem: 64 * 1024 * 1024,
  });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifySecret(
  secret: string | Buffer,
  stored: string,
): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltText, keyText] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  const expected = Buffer.from(keyText, 'base64');
  const key = await scrypt(
    secret,
    Buffer.from(saltText, 'base64'),
    expected.length,
    {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: 64 * 1024 * 1024,
    },
  );
  return key.length === expected.length && timingSafeEqual(key, expected);
}

// A precomputed hash lets failed lookups spend the same time as real checks.
let dummyHash: Promise<string> | undefined;
export function verifyAgainstDummy(secret: string): Promise<boolean> {
  dummyHash ??= hashSecret(randomBytes(16));
  return dummyHash.then((hash) => verifySecret(secret, hash)).then(() => false);
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export type SecretBox = {
  encrypt(plain: string): string;
  decrypt(sealed: string): string;
  // Keyed PIN input: a stolen database alone cannot brute-force 4-digit PINs.
  pepperPin(userId: string, pin: string): Buffer;
};

export function createSecretBox(masterKeyBase64: string): SecretBox {
  const master = Buffer.from(masterKeyBase64, 'base64');
  if (master.length < 32) throw new Error('APP_SECRET_KEY must be 32 bytes.');
  const derive = (info: string) =>
    Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), info, 32));
  const encryptionKey = derive('fastfood/encryption/v1');
  const pinKey = derive('fastfood/pin-pepper/v1');
  return {
    encrypt(plain) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv);
      const body = Buffer.concat([
        cipher.update(plain, 'utf8'),
        cipher.final(),
      ]);
      return `v1.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${body.toString('base64url')}`;
    },
    decrypt(sealed) {
      const [version, iv, tag, body] = sealed.split('.');
      if (version !== 'v1' || !iv || !tag || !body)
        throw new Error('Unsupported ciphertext');
      const decipher = createDecipheriv(
        'aes-256-gcm',
        encryptionKey,
        Buffer.from(iv, 'base64url'),
      );
      decipher.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([
        decipher.update(Buffer.from(body, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
    },
    pepperPin(userId, pin) {
      return createHmac('sha256', pinKey).update(`${userId}:${pin}`).digest();
    },
  };
}
