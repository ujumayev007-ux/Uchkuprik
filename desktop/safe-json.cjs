'use strict';
// Small JSON files that the application writes itself (vendor state, issued licences,
// migration list …). A power cut or crash can leave such a file zero-filled or half
// written; reading it must never stop the application from starting, and writing it
// must never leave a half-written file behind.
const fs = require('node:fs');
const path = require('node:path');

/**
 * Reads a JSON file. A missing file gives `fallback`. A damaged file is NOT deleted:
 * it is moved aside (`<name>.damaged-<time>`) so nothing is lost, and `fallback` is
 * returned. `onDamaged` (optional) is told about it for the log.
 */
function readJson(file, fallback, onDamaged) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return fallback;
    throw error;
  }
  try {
    return JSON.parse(text.replace(/^﻿/, ''));
  } catch (error) {
    const moved = `${file}.damaged-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    try {
      fs.renameSync(file, moved);
    } catch {
      /* The damaged file stays where it is; the fallback is still used. */
    }
    if (onDamaged) onDamaged(file, moved, error);
    return fallback;
  }
}

/** Writes through a temporary file and renames it: readers never see a partial file. */
function writeJson(file, value, options = {}) {
  const text =
    typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  const temp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(temp, 'w', options.mode ?? 0o666);
  try {
    fs.writeSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temp, file);
}

module.exports = {
  readJson,
  writeJson,
  ensureDir: (dir) => fs.mkdirSync(path.resolve(dir), { recursive: true }),
};
