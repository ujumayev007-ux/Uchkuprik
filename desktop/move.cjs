// Moving the restaurant server to another computer (for example the always-on Kassa
// computer, so the Admin computer may be switched off). The keys that are sealed with this
// computer's Windows user key (secrets, LAN identity, device key) are written in plain
// form into the package; the new computer seals them with its own key on first start and
// removes the plain copies. Same data, passwords, PINs, licence identity and LAN identity
// (paired terminals find the server again by themselves).
const fs = require('node:fs');
const path = require('node:path');

const SEALED = /(^|[\\/])(secrets|lan-identity|device-key)\.enc$/;
const SKIP = /(^|[\\/])(moved\.json|postmaster\.pid)$/;

function readme(version) {
  return [
    `FastFood serverini ko'chirish paketi (versiya ${version}, ${new Date().toISOString().slice(0, 16).replace('T', ' ')})`,
    '',
    'DIQQAT: bu papkada maxfiy kalitlar ochiq holda turibdi. Ishdan keyin uni o‘chiring,',
    'hech kimga bermang va internetga yuklamang.',
    '',
    'Yangi kompyuterda (masalan, doim yoqiq turadigan Kassa kompyuterida):',
    '1. "FastFood Admin" o‘rnatuvchisini (server) o‘rnating.',
    '2. Agar dastur ochilib qolgan bo‘lsa: tray (soat yonida) → FastFood → "Chiqish".',
    '3. %APPDATA%\\FastFood-Data papkasi bo‘lsa, nomini FastFood-Data-yangi deb o‘zgartiring.',
    '4. Shu paketdagi FastFood-Data papkasini %APPDATA%\\ ichiga nusxalang.',
    '5. FastFood Admin’ni oching. Kalitlar shu kompyuter uchun qayta shifrlanadi.',
    '6. Kassa, Oshxona, TV va Ofitsiant ilovalari serverni yangi manzilda o‘zi topadi.',
    '   Admin kompyuterida "FastFood Admin" o‘rniga yengil Admin ilovasini ishlating.',
    '',
    'Eski kompyuterdagi server o‘chirib qo‘yildi (ikki server bir vaqtda ishlamasin).',
    "Uni qaytarish kerak bo'lsa: eski kompyuterdagi FastFood-Data\\moved.json faylini o'chiring.",
  ].join('\r\n');
}

/**
 * Writes `<dest>/FastFood-Data`: a copy of the (stopped) data folder with the sealed keys
 * replaced by plain ones. Throws if the target exists (never overwrites).
 */
function exportPackage({
  dataDir,
  dest,
  secrets,
  lanIdentity,
  deviceKeyPem,
  version,
}) {
  if (!secrets?.appSecretKey || !secrets?.dbPassword)
    throw new Error('Maxfiy kalitlar o‘qilmadi.');
  if (fs.existsSync(path.join(dataDir, 'pgdata', 'postmaster.pid')))
    throw new Error('Ma’lumotlar bazasi hali to‘xtamagan.');
  const target = path.join(dest, 'FastFood-Data');
  if (fs.existsSync(target)) throw new Error(`${target} allaqachon bor.`);
  fs.cpSync(dataDir, target, {
    recursive: true,
    filter: (source) => !SEALED.test(source) && !SKIP.test(source),
  });
  const write = (name, text) =>
    fs.writeFileSync(path.join(target, name), text, { mode: 0o600 });
  write('secrets.json', JSON.stringify(secrets, null, 2));
  if (lanIdentity?.privateKey && lanIdentity?.publicKey)
    write(
      'lan-identity.json',
      JSON.stringify({
        privateKey: lanIdentity.privateKey,
        publicKey: lanIdentity.publicKey,
      }),
    );
  if (deviceKeyPem) write('device-key.pem', deviceKeyPem);
  fs.writeFileSync(path.join(dest, 'KOCHIRISH-YORIQNOMA.txt'), readme(version));
  return target;
}

/** Marks this computer's copy as moved: the server here does not start any more. */
function markMoved(dataDir, info) {
  fs.writeFileSync(
    path.join(dataDir, 'moved.json'),
    JSON.stringify({ ...info, at: new Date().toISOString() }, null, 2),
  );
}

function movedInfo(dataDir) {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(dataDir, 'moved.json'), 'utf8'),
    );
  } catch {
    return null;
  }
}

module.exports = { exportPackage, markMoved, movedInfo };
