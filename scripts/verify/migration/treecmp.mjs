// Compares two folder trees by content hash.  node treecmp.mjs <dirA> <dirB> [ignoreSubstring,...]
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function tree(dir, base = dir, out = {}) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) tree(full, base, out);
    else
      out[path.relative(base, full).split(path.sep).join('/')] = crypto
        .createHash('sha256')
        .update(fs.readFileSync(full))
        .digest('hex');
  }
  return out;
}
const [a, b, ignore = ''] = process.argv.slice(2);
const skip = ignore.split(',').filter(Boolean);
const ta = tree(path.resolve(a));
const tb = tree(path.resolve(b));
const keys = [...new Set([...Object.keys(ta), ...Object.keys(tb)])].filter(
  (k) => !skip.some((s) => k.includes(s)),
);
const differ = keys
  .filter((k) => ta[k] !== tb[k])
  .map((k) => `${k}${ta[k] ? '' : ' (only B)'}${tb[k] ? '' : ' (only A)'}`);
console.log(
  `files A ${Object.keys(ta).length}, B ${Object.keys(tb).length}; compared ${keys.length}`,
);
console.log(
  differ.length
    ? `DIFFERENT (${differ.length}): ${differ.slice(0, 12).join(', ')}`
    : 'IDENTICAL',
);
