'use strict';
// Automatic connection on the local network ("Avtomatik ulanish").
//
// The restaurant SERVER computer runs a small "beacon": it answers "who is the FastFood
// server here?" over UDP broadcast and over a tiny HTTP page, both on ONE port
// (DISCOVERY_PORT). Every answer is signed with the server's own key, so an application
// that has already paired with a server accepts only that server again, even when its
// address (IP) changes. The beacon carries no restaurant data and no credentials; signing
// in is still done on the server's own pages (login, PIN, device registration).
//
// The Admin / Kassa / Ofitsiant applications call discover(): UDP broadcast plus a
// quick sweep of the local subnets (outbound TCP only, so no firewall change is needed
// on those computers).
//
// Used by desktop/main.cjs (beacon) and admin-desktop/main.cjs (discover).
const crypto = require('node:crypto');
const dgram = require('node:dgram');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const DISCOVERY_PORT = 47870;
const TEST_DISCOVERY_PORT = 47871;
const MAGIC = 'FFLAN1';

/** RFC 1918 / link-local / loopback: the only addresses that may talk to the beacon. */
function isPrivateAddress(address) {
  const ip = String(address || '').replace(/^::ffff:/, '');
  if (ip === '::1') return true;
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n)))
    return false;
  const [a, b] = parts;
  return (
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  );
}

// ------------------------------------------------------------------- identity

const idOf = (publicKeyB64) =>
  crypto
    .createHash('sha256')
    .update(Buffer.from(publicKeyB64, 'base64'))
    .digest('hex')
    .slice(0, 16)
    .toUpperCase();

/** "4F2A-91C7-0B3D": what the person compares on the server and on the client. */
const fingerprint = (id) =>
  String(id)
    .slice(0, 12)
    .replace(/(.{4})(?=.)/g, '$1-');

const signedText = (h, nonce) =>
  [MAGIC, h.id, h.name, h.port, h.ver, nonce].join('|');

/**
 * The server's long-term signing key. Created once per computer; kept encrypted with the
 * Windows user key (DPAPI) when available. It never leaves this computer.
 */
function loadIdentity({ dataDir, safeStorage }) {
  const sealed = path.join(dataDir, 'lan-identity.enc');
  const plain = path.join(dataDir, 'lan-identity.json');
  const secure = !!safeStorage && safeStorage.isEncryptionAvailable();
  let value = null;
  try {
    if (secure && fs.existsSync(sealed))
      value = JSON.parse(safeStorage.decryptString(fs.readFileSync(sealed)));
    else if (fs.existsSync(plain))
      value = JSON.parse(fs.readFileSync(plain, 'utf8'));
  } catch {
    value = null; // unreadable: a new identity is made (clients simply pair again)
  }
  // A plain identity (server moved from another computer) is sealed here at once.
  if (
    secure &&
    value?.privateKey &&
    value?.publicKey &&
    !fs.existsSync(sealed) &&
    fs.existsSync(plain)
  ) {
    const text = JSON.stringify({
      privateKey: value.privateKey,
      publicKey: value.publicKey,
    });
    fs.writeFileSync(`${sealed}.tmp`, safeStorage.encryptString(text), {
      mode: 0o600,
    });
    fs.renameSync(`${sealed}.tmp`, sealed);
    if (safeStorage.decryptString(fs.readFileSync(sealed)) === text)
      fs.rmSync(plain, { force: true });
  }
  if (!value?.privateKey || !value?.publicKey) {
    const pair = crypto.generateKeyPairSync('ed25519');
    value = {
      privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }),
      publicKey: pair.publicKey
        .export({ type: 'spki', format: 'der' })
        .toString('base64'),
    };
    fs.mkdirSync(dataDir, { recursive: true });
    const file = secure ? sealed : plain;
    const text = JSON.stringify(value);
    fs.writeFileSync(
      `${file}.tmp`,
      secure ? safeStorage.encryptString(text) : text,
      {
        mode: 0o600,
      },
    );
    fs.renameSync(`${file}.tmp`, file);
  }
  return { ...value, id: idOf(value.publicKey) };
}

// --------------------------------------------------------------------- beacon

/**
 * Starts answering discovery requests. Returns { stop, id, key, fingerprint, port }.
 * `info()` supplies the live values (server name, application port, version).
 */
function startBeacon({
  port = DISCOVERY_PORT,
  host = '0.0.0.0',
  identity,
  info,
  log = () => {},
}) {
  const hello = (nonce) => {
    const base = { id: identity.id, ...info() };
    const signature = crypto
      .sign(
        null,
        Buffer.from(signedText(base, nonce)),
        crypto.createPrivateKey(identity.privateKey),
      )
      .toString('base64');
    return { v: 1, ...base, key: identity.publicKey, nonce, sig: signature };
  };
  const goodNonce = (value) =>
    /^[A-Za-z0-9_-]{8,64}$/.test(String(value || ''));

  // Cheap protection against being used to flood someone: at most 20 answers per
  // second per source address.
  const seen = new Map();
  const allowed = (address) => {
    const second = Math.floor(Date.now() / 1000);
    const entry = seen.get(address);
    if (!entry || entry.second !== second) {
      seen.set(address, { second, count: 1 });
      if (seen.size > 500) seen.clear();
      return true;
    }
    return ++entry.count <= 20;
  };

  const udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  udp.on('message', (message, remote) => {
    if (!isPrivateAddress(remote.address) || !allowed(remote.address)) return;
    let request;
    try {
      request = JSON.parse(message.toString('utf8'));
    } catch {
      return;
    }
    if (request?.t !== MAGIC || !goodNonce(request.nonce)) return;
    const body = Buffer.from(JSON.stringify(hello(request.nonce)));
    udp.send(body, remote.port, remote.address);
  });
  udp.on('error', (error) => log(`lan udp: ${error.message}`));
  udp.bind(port, host);

  const web = http.createServer((req, res) => {
    const remote = req.socket.remoteAddress;
    if (!isPrivateAddress(remote) || !allowed(remote)) {
      res.writeHead(403).end();
      return;
    }
    const url = new URL(req.url || '/', 'http://x');
    if (
      req.method !== 'GET' ||
      url.pathname !== '/hello' ||
      !goodNonce(url.searchParams.get('nonce'))
    ) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    });
    res.end(JSON.stringify(hello(url.searchParams.get('nonce'))));
  });
  web.on('error', (error) => log(`lan http: ${error.message}`));
  web.listen(port, host);

  return {
    id: identity.id,
    key: identity.publicKey,
    fingerprint: fingerprint(identity.id),
    port,
    stop: () => {
      try {
        udp.close();
      } catch {
        /* already closed */
      }
      web.close();
    },
  };
}

// ----------------------------------------------------------------- client side

/** Checks an answer: shape, key↔id, signature and (when given) the paired key. */
function verifyHello(h, nonce, pinnedKey) {
  try {
    if (!h || h.v !== 1 || h.nonce !== nonce) return null;
    if (typeof h.key !== 'string' || h.id !== idOf(h.key)) return null;
    if (pinnedKey && h.key !== pinnedKey) return null;
    const port = Number(h.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    const name = String(h.name || '').slice(0, 80);
    const ver = String(h.ver || '').slice(0, 20);
    const ok = crypto.verify(
      null,
      Buffer.from(
        signedText({ id: h.id, name: h.name, port: h.port, ver: h.ver }, nonce),
      ),
      crypto.createPublicKey({
        key: Buffer.from(h.key, 'base64'),
        format: 'der',
        type: 'spki',
      }),
      Buffer.from(String(h.sig), 'base64'),
    );
    return ok ? { id: h.id, key: h.key, name, port, ver } : null;
  } catch {
    return null;
  }
}

const newNonce = () => crypto.randomBytes(12).toString('base64url');

/** This computer's private IPv4 interfaces with their address and prefix length. */
function localInterfaces() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter(
      (i) =>
        i && i.family === 'IPv4' && !i.internal && isPrivateAddress(i.address),
    )
    .map((i) => ({ address: i.address, netmask: i.netmask }));
}

const toInt = (ip) =>
  ip.split('.').reduce((n, part) => n * 256 + Number(part), 0);
const toIp = (n) =>
  [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');

/** Every host address of the local subnets (a /22 at most) except this computer. */
function subnetHosts(interfaces = localInterfaces()) {
  const own = new Set(interfaces.map((i) => i.address));
  const hosts = new Set();
  for (const { address, netmask } of interfaces) {
    const mask = toInt(netmask);
    // Larger than /22 (1022 hosts): scan only the /24 around this computer.
    const width = 32 - mask.toString(2).replace(/0/g, '').length;
    const usable = width > 10 ? 0xffffff00 : mask;
    const network = (toInt(address) & usable) >>> 0;
    const size = (~usable >>> 0) + 1;
    for (let i = 1; i < size - 1; i++) {
      const ip = toIp(network + i);
      if (!own.has(ip)) hosts.add(ip);
    }
  }
  return [...hosts];
}

function broadcastTargets(interfaces = localInterfaces()) {
  const targets = new Set(['255.255.255.255']);
  for (const { address, netmask } of interfaces) {
    const mask = toInt(netmask);
    targets.add(toIp(((toInt(address) & mask) | (~mask >>> 0)) >>> 0));
  }
  return [...targets];
}

async function probeHttp(host, port, nonce, timeoutMs) {
  try {
    const response = await fetch(
      `http://${host}:${port}/hello?nonce=${nonce}`,
      {
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

function udpScan({ port, nonce, timeoutMs, onAnswer }) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket({ type: 'udp4' });
    const finish = () => {
      try {
        socket.close();
      } catch {
        /* closed */
      }
      resolve();
    };
    socket.on('error', finish);
    socket.on('message', (message, remote) => {
      try {
        onAnswer(JSON.parse(message.toString('utf8')), remote.address);
      } catch {
        /* not ours */
      }
    });
    socket.bind(0, () => {
      try {
        socket.setBroadcast(true);
        const body = Buffer.from(JSON.stringify({ t: MAGIC, nonce }));
        for (const target of broadcastTargets())
          socket.send(body, port, target, () => {});
      } catch {
        /* a network card without broadcast */
      }
      setTimeout(finish, timeoutMs);
    });
  });
}

/**
 * Finds FastFood servers on this network. Returns
 * [{ id, key, name, port, ver, host, fingerprint, local }], without duplicates.
 * `pinned` (a server's public key) limits the answer to that one server.
 */
async function discover({
  port = DISCOVERY_PORT,
  timeoutMs = 2500,
  pinned = null,
  sweep = true,
} = {}) {
  const found = new Map();
  const nonce = newNonce();
  const ownAddresses = new Set(localInterfaces().map((i) => i.address));
  const accept = (answer, host) => {
    const hello = verifyHello(answer, nonce, pinned);
    if (!hello) return;
    // The server on this very computer is reached over loopback: stable when Wi-Fi changes.
    const local = ownAddresses.has(host) || host === '127.0.0.1';
    const old = found.get(hello.id);
    if (old && (old.local || !local)) return;
    found.set(hello.id, {
      ...hello,
      host: local ? '127.0.0.1' : host,
      local,
      fingerprint: fingerprint(hello.id),
    });
  };

  const jobs = [udpScan({ port, nonce, timeoutMs, onAnswer: accept })];
  if (sweep) {
    const hosts = [
      '127.0.0.1',
      ...localInterfaces().map((i) => i.address),
      ...subnetHosts(),
    ];
    jobs.push(
      (async () => {
        let next = 0;
        const worker = async () => {
          while (next < hosts.length) {
            const host = hosts[next++];
            const answer = await probeHttp(
              host,
              port,
              nonce,
              Math.min(900, timeoutMs),
            );
            if (answer) accept(answer, host);
          }
        };
        await Promise.all(Array.from({ length: 128 }, worker));
      })(),
    );
  }
  await Promise.all(jobs);
  return [...found.values()].sort(
    (a, b) => Number(b.local) - Number(a.local) || a.name.localeCompare(b.name),
  );
}

// ------------------------------------------------------------ Windows Firewall

const RULE_TCP = 'FastFood server (tarmoq, TCP)';
const RULE_UDP = 'FastFood server (topish, UDP)';

const runFile = (file, args) =>
  new Promise((resolve) =>
    require('node:child_process').execFile(
      file,
      args,
      { windowsHide: true, timeout: 60_000 },
      (error, stdout) => resolve({ ok: !error, out: String(stdout || '') }),
    ),
  );

/** Are this program's inbound rules present? (reading rules needs no administrator.) */
async function firewallState() {
  if (process.platform !== 'win32') return { applicable: false, ok: true };
  const [tcp, udp] = await Promise.all(
    [RULE_TCP, RULE_UDP].map((name) =>
      runFile('netsh', [
        'advfirewall',
        'firewall',
        'show',
        'rule',
        `name=${name}`,
      ]),
    ),
  );
  return { applicable: true, ok: tcp.ok && udp.ok };
}

/**
 * Adds two NARROW inbound rules for this program only (the application port and the
 * discovery port, local subnet only). Windows Firewall stays on. One Windows
 * "administrator permission" prompt is shown; the person can decline.
 */
async function enableFirewall({
  exe,
  appPort,
  discoveryPort = DISCOVERY_PORT,
}) {
  if (process.platform !== 'win32') return { ok: true };
  const esc = (text) => String(text).replace(/'/g, "''");
  const rule = (name, protocol, ports) =>
    `netsh advfirewall firewall delete rule name='${esc(name)}'; ` +
    `netsh advfirewall firewall add rule name='${esc(name)}' dir=in action=allow ` +
    `program='${esc(exe)}' protocol=${protocol} localport=${ports} ` +
    `remoteip=LocalSubnet profile=any enable=yes`;
  const script = [
    rule(RULE_TCP, 'TCP', `${appPort},${discoveryPort}`),
    rule(RULE_UDP, 'UDP', discoveryPort),
  ].join('; ');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  await runFile('powershell', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `Start-Process -FilePath powershell -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile','-EncodedCommand','${encoded}'`,
  ]);
  const state = await firewallState();
  return { ok: state.ok };
}

module.exports = {
  DISCOVERY_PORT,
  TEST_DISCOVERY_PORT,
  isPrivateAddress,
  loadIdentity,
  startBeacon,
  discover,
  verifyHello,
  subnetHosts,
  fingerprint,
  firewallState,
  enableFirewall,
};
