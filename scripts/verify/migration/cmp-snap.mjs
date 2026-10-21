// Compares two snapshots made by snap.mjs (after was made with --ref before).
//   node cmp-snap.mjs before.json after.json [--volatile Session,AuditLog,...]
import fs from 'node:fs';

const [beforeFile, afterFile] = process.argv.slice(2, 4);
const volIndex = process.argv.indexOf('--volatile');
const volatile = new Set(
  volIndex >= 0 ? process.argv[volIndex + 1].split(',') : [],
);
const before = JSON.parse(fs.readFileSync(beforeFile, 'utf8'));
const after = JSON.parse(fs.readFileSync(afterFile, 'utf8'));
const problems = [];
const notes = [];
let rowsChecked = 0;

for (const [table, b] of Object.entries(before.tables)) {
  const a = after.tables[table];
  if (!a) {
    if (b.count > 0)
      problems.push(`${table}: TABLE REMOVED (${b.count} rows lost)`);
    else notes.push(`${table}: table removed (it was empty)`);
    continue;
  }
  if (a.missingColumns.length) {
    const msg = `${table}: column(s) removed: ${a.missingColumns.join(', ')}`;
    (b.count > 0 ? problems : notes).push(msg);
  }
  rowsChecked += b.count;
  // multiset difference of fingerprints
  const pool = new Map();
  for (const h of a.hashes) pool.set(h, (pool.get(h) ?? 0) + 1);
  let missing = 0;
  for (const h of b.hashes) {
    const left = pool.get(h) ?? 0;
    if (left > 0) pool.set(h, left - 1);
    else missing++;
  }
  const extra = a.count - (b.count - missing);
  if (a.count < b.count) {
    (volatile.has(table) ? notes : problems).push(
      `${table}: rows ${b.count} -> ${a.count} (LOST ${b.count - a.count})`,
    );
  } else if (missing > 0) {
    (volatile.has(table) ? notes : problems).push(
      `${table}: ${missing} of ${b.count} rows changed or replaced (rows now ${a.count})`,
    );
  } else if (a.count > b.count) {
    notes.push(
      `${table}: +${a.count - b.count} new rows (existing ${b.count} intact)`,
    );
  }
  void extra;
}
for (const [table, a] of Object.entries(after.tables))
  if (!before.tables[table])
    notes.push(`${table}: NEW table (${a.count} rows)`);
const newMigrations = after.migrations.filter(
  (m) => !before.migrations.includes(m),
);
const lostMigrations = before.migrations.filter(
  (m) => !after.migrations.includes(m),
);
if (lostMigrations.length)
  problems.push(`migrations missing after: ${lostMigrations.join(', ')}`);

console.log(
  `tables before ${Object.keys(before.tables).length}, after ${Object.keys(after.tables).length}; existing rows verified: ${rowsChecked}`,
);
console.log(
  `migrations before ${before.migrations.length}, after ${after.migrations.length} (+${newMigrations.length})`,
);
console.log(
  `encoding/collation before ${before.meta.enc}/${before.meta.collate}, after ${after.meta.enc}/${after.meta.collate}`,
);
for (const n of notes) console.log('  note:', n);
for (const p of problems) console.log('  PROBLEM:', p);
console.log(
  problems.length
    ? `RESULT: ${problems.length} problem(s)`
    : 'RESULT: no existing row lost or changed',
);
process.exit(problems.length ? 1 : 0);
