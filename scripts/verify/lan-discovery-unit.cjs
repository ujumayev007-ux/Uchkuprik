// Unit/integration check of desktop/lan.cjs on this computer (two beacons = two servers).
const fs = require('fs');
const os = require('os');
const path = require('path');
const lan = require('C:/Users/PRESTIGE/fastfood-app/desktop/lan.cjs');
const ok = [];
const check = (n, v, d = '') => {
  ok.push(v);
  console.log(`${v ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`);
};
const PORT = 47999;
const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'lanA-'));
const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'lanB-'));

(async () => {
  const idA = lan.loadIdentity({ dataDir: dirA, safeStorage: null });
  const again = lan.loadIdentity({ dataDir: dirA, safeStorage: null });
  check(
    'server kaliti saqlanadi (qayta yuklansa o‘sha id)',
    idA.id === again.id && /^[0-9A-F]{16}$/.test(idA.id),
  );
  const a = lan.startBeacon({
    port: PORT,
    identity: idA,
    info: () => ({ name: 'KASSA-A', port: 8787, ver: '1.14.3' }),
  });
  await new Promise((r) => setTimeout(r, 300));

  let t = Date.now();
  let found = await lan.discover({ port: PORT, timeoutMs: 2500 });
  console.log(
    '   topish vaqti',
    Date.now() - t,
    'ms',
    JSON.stringify(
      found.map((f) => [f.name, f.host, f.port, f.fingerprint, f.local]),
    ),
  );
  check(
    'bitta server topildi',
    found.length === 1 && found[0].name === 'KASSA-A',
  );
  check(
    'server shu kompyuterda: manzil 127.0.0.1',
    found[0]?.host === '127.0.0.1' && found[0].local,
  );
  check(
    'port 8787 va versiya',
    found[0]?.port === 8787 && found[0]?.ver === '1.14.3',
  );

  // UDP only and sweep only both work
  const udpOnly = await lan.discover({
    port: PORT,
    timeoutMs: 1500,
    sweep: false,
  });
  check(
    'faqat UDP (broadcast) bilan ham topiladi',
    udpOnly.length === 1,
    `${udpOnly.length}`,
  );

  // second server (other identity) -> list of two. Needs a second port => two beacons cannot share a port, so emulate via HTTP only.
  const idB = lan.loadIdentity({ dataDir: dirB, safeStorage: null });
  check('ikkinchi serverning id si boshqa', idB.id !== idA.id);

  // pinned: only the paired server is accepted
  const pinned = await lan.discover({
    port: PORT,
    timeoutMs: 1500,
    pinned: idA.publicKey,
  });
  check('juftlangan server topiladi', pinned.length === 1);
  const wrong = await lan.discover({
    port: PORT,
    timeoutMs: 1500,
    pinned: idB.publicKey,
  });
  check(
    'boshqa kalit bilan juftlangan ilova bu serverni QABUL QILMAYDI (soxta server)',
    wrong.length === 0,
  );

  // tampered answer / replay / wrong nonce
  const nonce = 'abcdefghijkl';
  const resp = await (
    await fetch(`http://127.0.0.1:${PORT}/hello?nonce=${nonce}`)
  ).json();
  check('imzo to‘g‘ri', !!lan.verifyHello(resp, nonce));
  check(
    'boshqa nonce (qayta yuborish) rad etiladi',
    lan.verifyHello(resp, 'zzzzzzzzzzzz') === null,
  );
  check(
    'nom o‘zgartirilsa rad etiladi',
    lan.verifyHello({ ...resp, name: 'SOXTA' }, nonce) === null,
  );
  check(
    'port o‘zgartirilsa rad etiladi',
    lan.verifyHello({ ...resp, port: 9999 }, nonce) === null,
  );
  const fake = lan.loadIdentity({ dataDir: dirB, safeStorage: null });
  check(
    'o‘z kalitini id ga yopishtirgan soxta rad etiladi',
    lan.verifyHello({ ...resp, key: fake.publicKey }, nonce) === null,
  );

  // beacon hygiene
  const bad = await fetch(`http://127.0.0.1:${PORT}/hello?nonce=x`);
  check('qisqa nonce rad etiladi (404)', bad.status === 404);
  const other = await fetch(`http://127.0.0.1:${PORT}/api/users`);
  check('boshqa yo‘l ochilmaydi (404)', other.status === 404);
  check(
    'beacon javobida maxfiy ma‘lumot yo‘q',
    !/private|secret|password/i.test(JSON.stringify(resp)),
  );
  check(
    'private manzil tekshiruvi',
    lan.isPrivateAddress('192.168.1.5') &&
      lan.isPrivateAddress('::ffff:10.0.0.2') &&
      !lan.isPrivateAddress('8.8.8.8') &&
      !lan.isPrivateAddress('172.32.0.1'),
  );

  // subnet sweep size
  const hosts = lan.subnetHosts([
    { address: '192.168.1.13', netmask: '255.255.255.0' },
  ]);
  check(
    '/24 da 253 ta manzil (o‘zi chiqarilgan)',
    hosts.length === 253 && !hosts.includes('192.168.1.13'),
  );
  const big = lan.subnetHosts([{ address: '10.1.2.3', netmask: '255.0.0.0' }]);
  check('katta tarmoqda faqat /24 skanerlanadi', big.length === 253);

  // server goes away -> nothing found; comes back on another port -> found again by key
  a.stop();
  await new Promise((r) => setTimeout(r, 300));
  const gone = await lan.discover({ port: PORT, timeoutMs: 1200 });
  check('server o‘chganda topilmaydi', gone.length === 0);
  const a2 = lan.startBeacon({
    port: PORT,
    identity: idA,
    info: () => ({ name: 'KASSA-A', port: 8790, ver: '1.14.3' }),
  });
  await new Promise((r) => setTimeout(r, 300));
  const back = await lan.discover({
    port: PORT,
    timeoutMs: 1500,
    pinned: idA.publicKey,
  });
  check(
    'qaytganda o‘sha server kalit bo‘yicha qayta topiladi (yangi port)',
    back.length === 1 && back[0].port === 8790,
  );
  a2.stop();

  console.log(
    ok.every(Boolean) ? 'HAMMASI O‘TDI' : 'BA’ZI TEKSHIRUVLAR O‘TMADI',
  );
  process.exit(ok.every(Boolean) ? 0 : 1);
})();
