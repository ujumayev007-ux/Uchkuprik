// Checks a FastFood central server after a move (no secrets are read or printed).
//   node scripts/verify-server.mjs https://new.example.uz [--compare https://old.example.uz]
// With --compare the new server must report the same signing-key fingerprint and the
// same APP_SECRET_KEY check value as the old one: installs and licences keep working
// only when both keys were carried over unchanged.

const [target, flag, other] = process.argv.slice(2);
// ALLOW_LOCAL_HTTP=1 lets this script check a local test server (127.0.0.1).
const localOk = process.env.ALLOW_LOCAL_HTTP === '1';
if (
  !target ||
  !(
    /^https:\/\//.test(target) ||
    (localOk && /^http:\/\/(127\.0\.0\.1|localhost)/.test(target))
  )
) {
  console.error(
    'Usage: node scripts/verify-server.mjs https://<new-address> [--compare https://<old-address>]',
  );
  process.exit(2);
}
const base = target.replace(/\/+$/, '');
const old = flag === '--compare' && other ? other.replace(/\/+$/, '') : null;

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures += 1;
  console.log(
    `${ok ? 'OK  ' : 'XATO'}  ${name}${detail ? ` — ${detail}` : ''}`,
  );
};
const get = async (url, init = {}) => {
  try {
    const response = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(45_000),
      ...init,
    });
    return { response, text: await response.text() };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
};

const live = await get(`${base}/api/health/live`);
check('HTTPS manzil ochiladi (sertifikat to‘g‘ri)', !live.error, live.error);
check('Server ishlayapti (/api/health/live)', live.response?.status === 200);
const ready = await get(`${base}/api/health/ready`);
check('Baza ulangan (/api/health/ready)', ready.response?.status === 200);
if (live.text)
  try {
    console.log(`      versiya: ${JSON.parse(live.text).version ?? '?'}`);
  } catch {
    /* ignore */
  }
const hsts = live.response?.headers.get('strict-transport-security');
check(
  'HSTS sarlavhasi bor',
  !!hsts,
  hsts ?? 'proksi/Caddy sozlamasini tekshiring',
);

const info = await get(`${base}/api/control/info`);
let infoJson = null;
try {
  infoJson = JSON.parse(info.text ?? '');
} catch {
  /* not JSON */
}
check(
  'Markaziy boshqaruv yoqilgan (CONTROL_PLANE=true)',
  infoJson?.plane === true,
);

const polling = await get(`${base}/api/realtime/?EIO=4&transport=polling`);
check(
  'Socket.io (real vaqt) ishlaydi',
  polling.response?.status === 200 && String(polling.text).startsWith('0{'),
  polling.response ? `HTTP ${polling.response.status}` : polling.error,
);
const alerts = await get(`${base}/api/live/alerts`);
check(
  'Ofitsiant xabarlari oqimi (SSE) yetib boradi',
  alerts.response?.status === 401,
  alerts.response
    ? `HTTP ${alerts.response.status} (kirishsiz 401 kutiladi)`
    : alerts.error,
);
const owner = await get(`${base}/owner`);
check('Owner sahifasi ochiladi', owner.response?.status === 200);

if (old) {
  const before = await get(`${old}/api/control/info`);
  let beforeJson = null;
  try {
    beforeJson = JSON.parse(before.text ?? '');
  } catch {
    /* not JSON */
  }
  check('Eski server javob beradi', beforeJson?.plane === true, before.error);
  check(
    'Imzo kaliti eski serverniki bilan bir xil',
    !!beforeJson?.signingKey && beforeJson.signingKey === infoJson?.signingKey,
    `${beforeJson?.signingKey ?? '?'} / ${infoJson?.signingKey ?? '?'}`,
  );
  check(
    'APP_SECRET_KEY eski serverniki bilan bir xil',
    !!beforeJson?.secretCheck &&
      beforeJson.secretCheck === infoJson?.secretCheck,
    `${beforeJson?.secretCheck ?? '?'} / ${infoJson?.secretCheck ?? '?'}`,
  );
}

console.log(
  failures === 0 ? '\nHAMMASI JOYIDA' : `\n${failures} ta tekshiruv o‘tmadi`,
);
process.exit(failures === 0 ? 0 : 1);
