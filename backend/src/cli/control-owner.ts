// Operator tool of the central server (SUPER_OWNER accounts). Secrets come from the
// environment, never argv (visible in process lists), and are never printed except
// the one-time authenticator secret shown to the new owner.
//
//   OWNER_EMAIL=... OWNER_NAME=... OWNER_PASSWORD=... npm run control:owner -w backend
//   OWNER_DEVICE_FINGERPRINT=... npm run control:owner -w backend   (approve a device)
import { loadConfig } from '../config.js';
import { createPrisma } from '../db.js';
import { createSecretBox } from '../lib/crypto.js';
import { passwordSchema } from '../modules/auth/auth.routes.js';
import {
  approveOwnerDevice,
  provisionOwner,
} from '../modules/control/owner-admin.js';

const config = loadConfig();
const db = createPrisma(config.DATABASE_URL);
try {
  const fingerprint = process.env.OWNER_DEVICE_FINGERPRINT?.trim();
  if (fingerprint) {
    const ok = await approveOwnerDevice(db, fingerprint);
    console.log(ok ? 'Device approved.' : 'Device not found.');
    process.exitCode = ok ? 0 : 1;
  } else {
    const email = process.env.OWNER_EMAIL?.trim().toLowerCase() ?? '';
    const displayName = process.env.OWNER_NAME?.trim() || 'SUPER_OWNER';
    const password = process.env.OWNER_PASSWORD ?? '';
    if (
      !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ||
      !passwordSchema.safeParse(password).success
    ) {
      console.error(
        'Set OWNER_EMAIL and OWNER_PASSWORD (10+ chars with letters and digits).',
      );
      process.exitCode = 1;
    } else {
      const result = await provisionOwner(
        db,
        createSecretBox(config.APP_SECRET_KEY),
        { email, displayName, password },
      );
      console.log('Owner created. Add this authenticator secret once:');
      console.log(result.otpauth);
    }
  }
} catch {
  console.error('Owner provisioning failed (does the account already exist?).');
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}
