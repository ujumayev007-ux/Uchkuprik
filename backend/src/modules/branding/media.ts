import { createHash } from 'node:crypto';
import type { Request, Response } from 'express';
import type { Db } from '../../db.js';
import { AppError } from '../../http/errors.js';

/**
 * Advertising and branding media. Only recognised picture and video formats are
 * accepted, judged by their own bytes (never by the declared type or file name), so
 * scripts, SVG or HTML can not be smuggled in. Files are served with a locked-down
 * response (no sniffing, no scripts, sandboxed).
 */

export const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 20 * 1024 * 1024;

export type MediaKind = 'IMAGE' | 'VIDEO';

export function sniffMedia(
  bytes: Uint8Array,
): { kind: MediaKind; mime: string } | null {
  const at = (index: number) => bytes[index] ?? -1;
  const ascii = (from: number, to: number) =>
    Buffer.from(bytes.subarray(from, to)).toString('latin1');
  if (bytes.length < 16) return null;
  if (at(0) === 0x89 && ascii(1, 4) === 'PNG')
    return { kind: 'IMAGE', mime: 'image/png' };
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff)
    return { kind: 'IMAGE', mime: 'image/jpeg' };
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP')
    return { kind: 'IMAGE', mime: 'image/webp' };
  if (ascii(0, 4) === 'GIF8') return { kind: 'IMAGE', mime: 'image/gif' };
  if (ascii(4, 8) === 'ftyp') return { kind: 'VIDEO', mime: 'video/mp4' };
  if (at(0) === 0x1a && at(1) === 0x45 && at(2) === 0xdf && at(3) === 0xa3)
    return { kind: 'VIDEO', mime: 'video/webm' };
  return null;
}

export const sha256Of = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');

const cleanName = (name: string) =>
  name
    .replace(/[^\p{L}\p{N} ._()-]/gu, '')
    .trim()
    .slice(0, 80) || 'fayl';

/** Validates and stores an upload; returns the stored metadata (never the bytes). */
export async function storeMedia(
  db: Db,
  bytes: Uint8Array,
  name: string,
  allow: MediaKind[] = ['IMAGE', 'VIDEO'],
) {
  const found = sniffMedia(bytes);
  if (!found || !allow.includes(found.kind))
    throw new AppError(400, 'MEDIA_INVALID', 'mediaInvalid');
  const limit = found.kind === 'IMAGE' ? MAX_IMAGE_BYTES : MAX_VIDEO_BYTES;
  if (bytes.length > limit)
    throw new AppError(413, 'MEDIA_TOO_LARGE', 'mediaTooLarge');
  const row = await db.brandingMedia.create({
    data: {
      kind: found.kind,
      mime: found.mime,
      name: cleanName(name),
      sizeBytes: bytes.length,
      sha256: sha256Of(bytes),
      data: Buffer.from(bytes),
    },
    select: {
      id: true,
      kind: true,
      mime: true,
      name: true,
      sizeBytes: true,
      sha256: true,
      createdAt: true,
    },
  });
  return row;
}

/** Serves one stored file with a restrictive response. */
export async function sendMedia(
  db: Db,
  id: string,
  res: Response,
  req: Request,
) {
  const row = await db.brandingMedia.findUnique({ where: { id } });
  if (!row) {
    res.status(404).json({ code: 'NOT_FOUND', message: 'Topilmadi' });
    return;
  }
  const bytes = Buffer.from(row.data);
  const etag = `"${row.sha256}"`;
  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  if (req.headers['if-none-match'] === etag) {
    res.status(304).end();
    return;
  }
  res.type(row.mime).setHeader('Content-Length', String(bytes.length));
  res.send(bytes);
}
