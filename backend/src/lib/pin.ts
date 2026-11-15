import { createHmac } from 'node:crypto';
import type { Db, Tx } from '../db.js';
import type { SecretBox } from './crypto.js';
import { hashSecret, verifySecret } from './crypto.js';

/**
 * Staff PIN hashes. A PIN used to be peppered with this server's own key, so a hash
 * only worked on the server that made it. A restaurant taking part in replication has
 * a shared restaurant key (kept by its Kassa server and the central server, each
 * sealed with its own server key); hashes made with it ("t1:" prefix) work on both, so
 * staff sign in with the same PIN on the Kassa and through the central server.
 * Old hashes keep working where they were made and are upgraded at the next sign-in.
 */
const PREFIX = 't1:';
const TTL_MS = 30_000;
const keys = new Map<string, { at: number; key: Buffer | null }>();

export function clearPinKeyCache() {
  keys.clear();
}

async function restaurantKey(
  db: Db | Tx,
  secrets: SecretBox,
  tenantId: string,
): Promise<Buffer | null> {
  const hit = keys.get(tenantId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.key;
  const row = await db.replicationTenant.findUnique({
    where: { tenantId },
    select: { pinKeyEnc: true },
  });
  let key: Buffer | null = null;
  try {
    key = row?.pinKeyEnc
      ? Buffer.from(secrets.decrypt(row.pinKeyEnc), 'base64')
      : null;
  } catch {
    key = null; // sealed with another server's key: unusable here
  }
  keys.set(tenantId, { at: Date.now(), key });
  return key;
}

const pepper = (key: Buffer, userId: string, pin: string) =>
  createHmac('sha256', key).update(`${userId}:${pin}`).digest();

export async function hashPin(
  db: Db | Tx,
  secrets: SecretBox,
  tenantId: string,
  userId: string,
  pin: string,
): Promise<string> {
  const key = await restaurantKey(db, secrets, tenantId);
  return key
    ? PREFIX + (await hashSecret(pepper(key, userId, pin)))
    : hashSecret(secrets.pepperPin(userId, pin));
}

/**
 * Checks a PIN. `upgrade` is a new restaurant-key hash to store when the PIN was right
 * but its hash was made with this server's own key (so it then works on both servers).
 */
export async function verifyPin(
  db: Db | Tx,
  secrets: SecretBox,
  tenantId: string,
  userId: string,
  pin: string,
  stored: string,
): Promise<{ ok: boolean; upgrade: string | null }> {
  const key = await restaurantKey(db, secrets, tenantId);
  if (stored.startsWith(PREFIX)) {
    if (!key) return { ok: false, upgrade: null };
    return {
      ok: await verifySecret(
        pepper(key, userId, pin),
        stored.slice(PREFIX.length),
      ),
      upgrade: null,
    };
  }
  const ok = await verifySecret(secrets.pepperPin(userId, pin), stored);
  return {
    ok,
    upgrade:
      ok && key ? PREFIX + (await hashSecret(pepper(key, userId, pin))) : null,
  };
}
