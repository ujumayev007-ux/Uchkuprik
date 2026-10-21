// SHA-256 manifest of a folder tree.   node manifest.mjs <dir> <out.json>   |   node manifest.mjs verify <dir> <manifest.json>
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function walk(dir, base = dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, base, out);
    else out.push(path.relative(base, full).replace(/\\/g, '/'));
  }
  return out.sort();
}
const hashFile = (file) =>
  crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function build(dir) {
  const files = {};
  for (const rel of walk(dir))
    files[rel] = {
      sha256: hashFile(path.join(dir, rel)),
      size: fs.statSync(path.join(dir, rel)).size,
    };
  return files;
}
if (process.argv[2] === 'verify') {
  const dir = path.resolve(process.argv[3]);
  const expected = JSON.parse(fs.readFileSync(process.argv[4], 'utf8')).files;
  const actual = build(dir);
  const problems = [];
  for (const [rel, info] of Object.entries(expected)) {
    if (!actual[rel]) problems.push(`missing ${rel}`);
    else if (actual[rel].sha256 !== info.sha256)
      problems.push(`changed ${rel}`);
  }
  for (const rel of Object.keys(actual))
    if (!expected[rel]) problems.push(`extra ${rel}`);
  console.log(
    problems.length
      ? `MISMATCH (${problems.length}): ${problems.slice(0, 8).join('; ')}`
      : `OK: ${Object.keys(expected).length} files identical`,
  );
  process.exit(problems.length ? 1 : 0);
} else {
  const dir = path.resolve(process.argv[2]);
  const files = build(dir);
  fs.writeFileSync(
    path.resolve(process.argv[3]),
    JSON.stringify(
      { dir, createdAt: new Date().toISOString(), files },
      null,
      1,
    ),
  );
  const bytes = Object.values(files).reduce((s, f) => s + f.size, 0);
  console.log(
    `manifest: ${Object.keys(files).length} files, ${(bytes / 1048576).toFixed(1)} MB`,
  );
}
