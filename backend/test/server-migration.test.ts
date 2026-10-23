import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const move = require('../../desktop/move.cjs');

describe('Server Migration & Cashier LAN Host (move.cjs)', () => {
  it('exports migration package safely with unsealed keys and instructions', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-test-src-'));
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-test-dest-'));

    try {
      // Mock source data directory
      fs.writeFileSync(path.join(tmp, 'app.log'), 'test log');
      fs.writeFileSync(path.join(tmp, 'secrets.enc'), 'sealed-secret-bytes');

      const secrets = {
        appSecretKey: 'test-app-secret-12345',
        dbPassword: 'test-db-password-67890',
        installedAt: '2026-10-23T10:00:00.000Z',
      };
      const lanIdentity = {
        privateKey: 'test-private-key',
        publicKey: 'test-public-key',
      };
      const deviceKeyPem = '-----BEGIN PRIVATE KEY-----\nMOCK\n-----END PRIVATE KEY-----';

      const targetDataDir = move.exportPackage({
        dataDir: tmp,
        dest,
        secrets,
        lanIdentity,
        deviceKeyPem,
        version: '1.14.10',
      });

      expect(fs.existsSync(targetDataDir)).toBe(true);
      expect(fs.existsSync(path.join(dest, 'KOCHIRISH-YORIQNOMA.txt'))).toBe(true);

      // Verify sealed files were stripped and plain configs written
      expect(fs.existsSync(path.join(targetDataDir, 'secrets.enc'))).toBe(false);
      expect(fs.existsSync(path.join(targetDataDir, 'secrets.json'))).toBe(true);
      expect(fs.existsSync(path.join(targetDataDir, 'lan-identity.json'))).toBe(true);
      expect(fs.existsSync(path.join(targetDataDir, 'device-key.pem'))).toBe(true);

      const writtenSecrets = JSON.parse(
        fs.readFileSync(path.join(targetDataDir, 'secrets.json'), 'utf8')
      );
      expect(writtenSecrets.appSecretKey).toBe('test-app-secret-12345');
      expect(writtenSecrets.dbPassword).toBe('test-db-password-67890');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.rmSync(dest, { recursive: true, force: true });
    }
  });

  it('marks moved server and prevents duplicate active servers', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-test-moved-'));
    try {
      expect(move.movedInfo(tmp)).toBeNull();

      move.markMoved(tmp, { to: 'C:\\Users\\PRESTIGE\\Desktop\\Target' });

      const info = move.movedInfo(tmp);
      expect(info).not.toBeNull();
      expect(info.to).toBe('C:\\Users\\PRESTIGE\\Desktop\\Target');
      expect(info.at).toBeDefined();

      // Rollback: removing moved.json restores server viability
      fs.rmSync(path.join(tmp, 'moved.json'), { force: true });
      expect(move.movedInfo(tmp)).toBeNull();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

