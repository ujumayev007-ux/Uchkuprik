import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { AppError } from '../http/errors.js';
import type { BackupStore } from './backup-store.js';
import type { SecretBox } from './crypto.js';

/**
 * Off-device copies of the newest backup (Zaxira nusxani boshqa joyga): encrypted with
 * the restaurant's own password (AES-256-GCM, the .ffbk export) before it leaves this
 * computer, to a folder (another disk, a USB stick, a network share) and/or the central
 * server. The password is kept here encrypted with the install's secret key and never
 * sent anywhere; without it nobody — the central server included — can read a copy.
 */
export type OffsiteConfig = {
  folder: string | null;
  central: boolean;
  // Copies kept in the folder.
  keep: number;
};
type Stored = OffsiteConfig & { passwordEnc: string | null };
export type OffsiteTarget = {
  name: string | null;
  at: string | null;
  ok: boolean | null;
  error: string | null;
};
export type OffsiteState = { folder: OffsiteTarget; central: OffsiteTarget };

const EMPTY: OffsiteTarget = { name: null, at: null, ok: null, error: null };
const COPY = /^fastfood-zaxira-[0-9A-Za-z-]+\.ffbk$/;
// The central server takes at most this much per copy.
export const CENTRAL_MAX_BYTES = 60 * 1024 * 1024;

export type CentralUpload = (
  file: string,
  meta: { name: string; sha256: string; bytes: number },
) => Promise<void>;

export function offsiteBackups(options: {
  dir: string;
  store: BackupStore;
  secrets: SecretBox;
  // The central server's upload (only on a restaurant computer linked to the Owner).
  central?: (() => CentralUpload | null) | undefined;
  now?: () => Date;
}) {
  const { dir, store, secrets } = options;
  const configFile = join(dir, 'offsite.json');
  const stateFile = join(dir, 'offsite-state.json');
  const now = () => options.now?.() ?? new Date();

  async function stored(): Promise<Stored> {
    return readFile(configFile, 'utf8')
      .then((text) => JSON.parse(text) as Stored)
      .catch(() => ({
        folder: null,
        central: false,
        keep: 7,
        passwordEnc: null,
      }));
  }
  async function state(): Promise<OffsiteState> {
    return readFile(stateFile, 'utf8')
      .then((text) => ({
        folder: EMPTY,
        central: EMPTY,
        ...(JSON.parse(text) as Partial<OffsiteState>),
      }))
      .catch(() => ({ folder: EMPTY, central: EMPTY }));
  }
  async function saveState(next: OffsiteState) {
    await mkdir(dir, { recursive: true });
    await writeFile(stateFile, JSON.stringify(next), { mode: 0o600 });
  }

  async function config() {
    const value = await stored();
    return {
      folder: value.folder,
      central: value.central,
      keep: value.keep,
      hasPassword: !!value.passwordEnc,
    };
  }

  async function configure(
    input: OffsiteConfig & { password?: string | undefined },
  ) {
    const current = await stored();
    if (input.folder && !isAbsolute(input.folder))
      throw new AppError(400, 'OFFSITE_FOLDER', 'offsiteFolder');
    if (input.folder) {
      // The folder must be writable now (a missing USB stick or share is reported).
      await mkdir(input.folder, { recursive: true }).catch(() => {
        throw new AppError(400, 'OFFSITE_FOLDER', 'offsiteFolder');
      });
      const probe = join(
        input.folder,
        `.fastfood-${randomBytes(4).toString('hex')}`,
      );
      await writeFile(probe, 'ok')
        .then(() => rm(probe, { force: true }))
        .catch(() => {
          throw new AppError(400, 'OFFSITE_FOLDER', 'offsiteFolder');
        });
    }
    const passwordEnc = input.password
      ? secrets.encrypt(input.password)
      : current.passwordEnc;
    if ((input.folder || input.central) && !passwordEnc)
      throw new AppError(400, 'BACKUP_PASSWORD', 'backupPassword');
    await mkdir(dir, { recursive: true });
    await writeFile(
      configFile,
      JSON.stringify({
        folder: input.folder,
        central: input.central,
        keep: input.keep,
        passwordEnc,
      } satisfies Stored),
      { mode: 0o600 },
    );
    return config();
  }

  /** Encrypts a backup into a temporary .ffbk next to the backups. */
  async function encrypted(name: string, password: string) {
    const file = join(dir, `.offsite-${randomBytes(6).toString('hex')}.ffbk`);
    const out = createWriteStream(file, { mode: 0o600 });
    await store.exportEncrypted(name, password, out);
    if (!out.writableFinished)
      await new Promise((resolve, reject) => {
        out.once('finish', () => resolve(undefined));
        out.once('error', reject);
      });
    return file;
  }

  async function sha256(file: string) {
    return createHash('sha256')
      .update(await readFile(file))
      .digest('hex');
  }

  /**
   * Copies the newest good backup to each destination that does not have it yet.
   * Failures are recorded (and shown to the Owner); the next run tries again.
   */
  async function run() {
    const value = await stored();
    const current = await state();
    if (!value.passwordEnc || (!value.folder && !value.central)) return current;
    const latest = (await store.list()).find(
      (row) => row.verified !== false && row.kind !== 'imported',
    );
    if (!latest) return current;
    const password = secrets.decrypt(value.passwordEnc);
    const stamp = latest.createdAt.replace(/[^0-9]/g, '').slice(0, 14);
    const next: OffsiteState = { ...current };
    let file: string | null = null;
    try {
      if (
        value.folder &&
        (current.folder.name !== latest.name || !current.folder.ok)
      ) {
        try {
          file ??= await encrypted(latest.name, password);
          await mkdir(value.folder, { recursive: true });
          const target = join(value.folder, `fastfood-zaxira-${stamp}.ffbk`);
          const part = `${target}.part`;
          await writeFile(part, await readFile(file));
          await rename(part, target);
          // Only our own copies are pruned, newest first.
          const copies = (await readdir(value.folder))
            .filter((entry) => COPY.test(entry))
            .sort()
            .reverse();
          for (const old of copies.slice(Math.max(1, value.keep)))
            await rm(join(value.folder, old), { force: true });
          next.folder = {
            name: latest.name,
            at: now().toISOString(),
            ok: true,
            error: null,
          };
        } catch (error) {
          next.folder = {
            name: latest.name,
            at: now().toISOString(),
            ok: false,
            error:
              error instanceof Error ? error.message.slice(0, 200) : 'xato',
          };
        }
      }
      const upload = value.central ? options.central?.() : null;
      if (
        value.central &&
        (current.central.name !== latest.name || !current.central.ok)
      ) {
        try {
          if (!upload)
            throw new Error(
              'Owner bilan aloqa yo‘q (markaziy server ulanmagan)',
            );
          file ??= await encrypted(latest.name, password);
          const bytes = (await stat(file)).size;
          if (bytes > CENTRAL_MAX_BYTES)
            throw new Error('Nusxa markaziy server uchun juda katta');
          await upload(file, {
            name: `fastfood-zaxira-${stamp}.ffbk`,
            sha256: await sha256(file),
            bytes,
          });
          next.central = {
            name: latest.name,
            at: now().toISOString(),
            ok: true,
            error: null,
          };
        } catch (error) {
          next.central = {
            name: latest.name,
            at: now().toISOString(),
            ok: false,
            error:
              error instanceof Error ? error.message.slice(0, 200) : 'xato',
          };
        }
      }
    } finally {
      if (file) await rm(file, { force: true });
    }
    await saveState(next);
    return next;
  }

  return { config, configure, run, state };
}
export type OffsiteBackups = ReturnType<typeof offsiteBackups>;

export function startOffsiteWorker(
  offsite: OffsiteBackups,
  logger: { warn: (message: string) => void },
  intervalMs = 15 * 60_000,
) {
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    offsite
      .run()
      .catch(() => logger.warn('Off-device backup copy failed'))
      .finally(() => {
        running = false;
      });
  };
  const first = setTimeout(tick, 2 * 60_000);
  const timer = setInterval(tick, intervalMs);
  first.unref();
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
