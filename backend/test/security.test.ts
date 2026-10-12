import { describe, expect, it } from 'vitest';
import {
  createSecretBox,
  hashSecret,
  verifySecret,
} from '../src/lib/crypto.js';
import { base32Encode, totpCode, verifyTotp } from '../src/lib/totp.js';

describe('secret hashing', () => {
  it('verifies the original secret only and salts every hash', async () => {
    const first = await hashSecret('Xavfsiz-parol-2026');
    const second = await hashSecret('Xavfsiz-parol-2026');
    expect(first).not.toBe(second);
    expect(first).toMatch(/^scrypt\$32768\$8\$1\$/);
    expect(await verifySecret('Xavfsiz-parol-2026', first)).toBe(true);
    expect(await verifySecret('xavfsiz-parol-2026', first)).toBe(false);
    expect(await verifySecret('anything', 'not-a-hash')).toBe(false);
  });
});

describe('secret box', () => {
  const box = createSecretBox(Buffer.alloc(32, 9).toString('base64'));

  it('encrypts with authentication and random nonces', () => {
    const sealed = box.encrypt('JBSWY3DPEHPK3PXP');
    expect(sealed).not.toContain('JBSWY3DPEHPK3PXP');
    expect(box.encrypt('JBSWY3DPEHPK3PXP')).not.toBe(sealed);
    expect(box.decrypt(sealed)).toBe('JBSWY3DPEHPK3PXP');
    const tampered = `${sealed.slice(0, -2)}AA`;
    expect(() => box.decrypt(tampered)).toThrow();
  });

  it('binds PIN input to the user and the server key', () => {
    const other = createSecretBox(Buffer.alloc(32, 1).toString('base64'));
    expect(box.pepperPin('u1', '1234')).not.toEqual(
      box.pepperPin('u2', '1234'),
    );
    expect(box.pepperPin('u1', '1234')).not.toEqual(
      other.pepperPin('u1', '1234'),
    );
  });

  it('rejects short master keys', () => {
    expect(() =>
      createSecretBox(Buffer.alloc(16).toString('base64')),
    ).toThrow();
  });
});

describe('TOTP', () => {
  // RFC 6238 Appendix B, SHA-1 secret "12345678901234567890", T=59 s -> 94287082 (8 digits).
  const secret = base32Encode(Buffer.from('12345678901234567890'));

  it('matches the RFC 6238 reference vector (last six digits)', () => {
    expect(totpCode(secret, 1)).toBe('287082');
    expect(totpCode(secret, Math.floor(1111111109 / 30))).toBe('081804');
  });

  it('accepts one step of drift and rejects replayed or older steps', () => {
    const now = 1111111109_000;
    const step = Math.floor(now / 30000);
    expect(verifyTotp(secret, totpCode(secret, step), null, now)).toBe(step);
    expect(verifyTotp(secret, totpCode(secret, step - 1), null, now)).toBe(
      step - 1,
    );
    expect(
      verifyTotp(secret, totpCode(secret, step - 2), null, now),
    ).toBeNull();
    expect(
      verifyTotp(secret, totpCode(secret, step), BigInt(step), now),
    ).toBeNull();
    expect(verifyTotp(secret, '12345', null, now)).toBeNull();
  });
});
