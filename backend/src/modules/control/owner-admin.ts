import type { Services } from '../../context.js';
import type { Db } from '../../db.js';
import { hashSecret } from '../../lib/crypto.js';
import { generateTotpSecret, otpauthUri } from '../../lib/totp.js';
import { controlAudit } from './owner.js';

/**
 * Creates (or re-provisions the second factor of) an Owner account. Used by the
 * operator CLI on the central server: owners cannot self-register.
 */
export async function provisionOwner(
  db: Db,
  secrets: Services['secrets'],
  input: { email: string; displayName: string; password: string },
) {
  const secret = generateTotpSecret();
  const owner = await db.controlOwner.create({
    data: {
      email: input.email.toLowerCase(),
      displayName: input.displayName,
      passwordHash: await hashSecret(input.password),
      mfaSecretEnc: secrets.encrypt(secret),
      mfaEnabledAt: new Date(),
    },
  });
  await controlAudit(db, null, {
    ownerId: owner.id,
    action: 'owner.provision',
    entityType: 'owner',
    entityId: owner.id,
    data: { source: 'cli' },
  });
  return {
    id: owner.id,
    mfaSecret: secret,
    otpauth: otpauthUri(secret, owner.email, 'FastFood Owner'),
  };
}

/** Approves a pending Owner device by fingerprint (operator CLI). */
export async function approveOwnerDevice(db: Db, fingerprint: string) {
  const device = await db.controlOwnerDevice.findUnique({
    where: { fingerprint },
  });
  if (!device) return false;
  await db.controlOwnerDevice.update({
    where: { id: device.id },
    data: { status: 'APPROVED', approvedAt: new Date() },
  });
  await controlAudit(db, null, {
    ownerId: device.ownerId,
    action: 'owner.device.approve',
    entityType: 'owner_device',
    entityId: device.id,
    data: { source: 'cli' },
  });
  return true;
}
