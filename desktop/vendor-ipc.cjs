// Vendor (SUPER_OWNER) local tools: licence signing, GitHub status document, update
// publishing, install reports and Telegram alerts. Shared by the customer app (only
// active on the vendor's own computer, which holds the private key) and the Owner app.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const alerts = require('./vendor-alerts.cjs');
const reports = require('./reports.cjs');

function registerVendor({ ipcMain, dialog, getWindow, log, vendorDir }) {
  // --------------------------------------------------- vendor licence panel

  // Present only on the vendor's computer; customers' installs never have it.
  const VENDOR_DIR =
    vendorDir ||
    process.env.FASTFOOD_VENDOR_DIR ||
    path.join(os.homedir(), '.fastfood');
  const VENDOR_KEY = path.join(VENDOR_DIR, 'vendor-license-private.pem');
  const VENDOR_HISTORY = path.join(VENDOR_DIR, 'licenses-issued.json');
  const VENDOR_STATE = path.join(VENDOR_DIR, 'vendor.json');
  const ALL_FEATURES = [
    'inventory',
    'delivery',
    'online_ordering',
    'loyalty',
    'kitchen_printing',
    'online_payments',
    'hr',
    'finance',
    'multi_brand',
    'franchise',
    'operations',
    'developer_api',
  ];

  function vendorHistory() {
    return fs.existsSync(VENDOR_HISTORY)
      ? JSON.parse(fs.readFileSync(VENDOR_HISTORY, 'utf8'))
      : [];
  }

  /** Vendor state: GitHub gist for remote control and one entry per customer install. */
  function vendorState() {
    const state = fs.existsSync(VENDOR_STATE)
      ? JSON.parse(fs.readFileSync(VENDOR_STATE, 'utf8'))
      : { customers: {} };
    state.customers ??= {};
    // Customers from licences issued before the customer list existed.
    for (const row of vendorHistory())
      if (
        !state.customers[row.installId] ||
        state.customers[row.installId].issuedAt < row.issuedAt
      )
        state.customers[row.installId] = {
          ...(state.customers[row.installId] ?? { blocked: false }),
          ...row,
        };
    return state;
  }

  function saveVendorState(state) {
    fs.writeFileSync(VENDOR_STATE, JSON.stringify(state, null, 2), {
      mode: 0o600,
    });
  }

  function signLicense(input, statusUrl) {
    if (!fs.existsSync(VENDOR_KEY))
      throw new Error('Sotuvchi kaliti topilmadi');
    if (!/^FF-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/.test(input.installId || ''))
      throw new Error('O‘rnatish ID noto‘g‘ri (FF-XXXX-XXXX-XXXX)');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.expiresAt || ''))
      throw new Error('Sana noto‘g‘ri');
    if (!input.customer) throw new Error('Mijoz nomini kiriting');
    const payload = {
      v: 1,
      customer: String(input.customer).slice(0, 120),
      installId: input.installId,
      issuedAt: new Date().toISOString(),
      expiresAt: input.expiresAt,
      features: Array.isArray(input.features)
        ? input.features.map(String)
        : ALL_FEATURES,
      maxBranches: input.maxBranches ?? null,
      maxUsers: input.maxUsers ?? null,
      maxDevices: input.maxDevices ?? null,
      ...(statusUrl ? { statusUrl } : {}),
      hiddenMenus: Array.isArray(input.hiddenMenus)
        ? input.hiddenMenus
            .map(String)
            .filter((item) => /^\/[a-z0-9/-]*$/.test(item))
        : [],
      // Locked restaurant settings and permissions removed for everyone (SUPER_OWNER).
      settings: {
        orders: Object.fromEntries(
          Object.entries(input.settings?.orders ?? {}).filter(
            ([key, value]) =>
              /^[a-zA-Z]{1,40}$/.test(key) && typeof value === 'boolean',
          ),
        ),
      },
      deniedPermissions: Array.isArray(input.deniedPermissions)
        ? input.deniedPermissions
            .map(String)
            .filter((key) => /^[a-z]+\.[a-z.]+$/.test(key))
        : [],
    };
    const body = Buffer.from(JSON.stringify(payload));
    const signature = crypto.sign(
      null,
      body,
      crypto.createPrivateKey(fs.readFileSync(VENDOR_KEY)),
    );
    const key = `${body.toString('base64url')}.${signature.toString('base64url')}`;
    const history = vendorHistory();
    history.push({ ...payload, key });
    fs.writeFileSync(VENDOR_HISTORY, JSON.stringify(history, null, 2));
    return { payload, key };
  }

  async function github(state, method, url, body) {
    const response = await fetch(`https://api.github.com${url}`, {
      method,
      headers: {
        Authorization: `Bearer ${state.githubToken}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'FastFood-Vendor',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok)
      throw new Error(
        response.status === 401
          ? 'GitHub token noto‘g‘ri yoki muddati o‘tgan'
          : `GitHub xatosi ${response.status}`,
      );
    return response.json();
  }

  const STATUS_FILE = 'fastfood-licenses.txt';

  /** Signs and uploads the status document every customer app polls. */
  async function publishStatus(state) {
    if (!state.githubToken || !state.gistId) return { published: false };
    const entries = {};
    for (const installId of Object.keys(state.blockedInstalls ?? {}))
      entries[installId] = { blocked: true };
    for (const [installId, customer] of Object.entries(state.customers))
      entries[installId] = {
        blocked: !!customer.blocked,
        ...(customer.key ? { key: customer.key } : {}),
      };
    const body = Buffer.from(
      JSON.stringify({
        v: 1,
        issuedAt: new Date().toISOString(),
        entries,
        ...(state.update ? { update: state.update } : {}),
      }),
    );
    const signature = crypto.sign(
      null,
      body,
      crypto.createPrivateKey(fs.readFileSync(VENDOR_KEY)),
    );
    await github(state, 'PATCH', `/gists/${state.gistId}`, {
      files: {
        [STATUS_FILE]: {
          content: `${body.toString('base64url')}.${signature.toString('base64url')}`,
        },
      },
    });
    return { published: true };
  }

  function vendorView(state) {
    return {
      connected: !!state.gistId,
      statusUrl: state.statusUrl ?? null,
      telegram: {
        connected: !!state.telegram?.chatId,
        bot: state.telegram?.bot ?? null,
      },
      blockedInstalls: Object.keys(state.blockedInstalls ?? {}),
      update: state.update
        ? {
            version: state.update.version,
            publishedAt: state.update.publishedAt,
          }
        : null,
      customers: Object.values(state.customers)
        .map((customer) => ({
          installId: customer.installId,
          customer: customer.customer,
          expiresAt: customer.expiresAt,
          blocked: !!customer.blocked,
          features: customer.features ?? [],
          maxBranches: customer.maxBranches ?? null,
          maxUsers: customer.maxUsers ?? null,
          maxDevices: customer.maxDevices ?? null,
          hiddenMenus: customer.hiddenMenus ?? [],
          settings: customer.settings ?? { orders: {} },
          deniedPermissions: customer.deniedPermissions ?? [],
          key: customer.key ?? null,
        }))
        .sort((a, b) => String(a.customer).localeCompare(String(b.customer))),
    };
  }

  const isVendorComputer = () => fs.existsSync(VENDOR_KEY);
  ipcMain.on('vendor:isVendor', (event) => {
    event.returnValue = isVendorComputer();
  });
  ipcMain.handle('vendor:history', () => vendorHistory());
  ipcMain.handle('vendor:state', () => vendorView(vendorState()));

  ipcMain.handle('vendor:connect', async (_event, token) => {
    const state = vendorState();
    state.githubToken = String(token || '').trim();
    if (!state.githubToken) throw new Error('GitHub token kiriting');
    if (!state.gistId) {
      const gist = await github(state, 'POST', '/gists', {
        description: 'FastFood licence status (signed)',
        public: false,
        files: { [STATUS_FILE]: { content: 'init' } },
      });
      state.gistId = gist.id;
      state.statusUrl = `https://gist.githubusercontent.com/${gist.owner.login}/${gist.id}/raw/${STATUS_FILE}`;
    }
    saveVendorState(state);
    await publishStatus(state);
    return vendorView(state);
  });

  /** New customer (or new terms): signs a key and publishes it. */
  ipcMain.handle('vendor:sign', async (_event, input) => {
    const state = vendorState();
    const { payload, key } = signLicense(input, state.statusUrl);
    state.customers[payload.installId] = {
      ...(state.customers[payload.installId] ?? { blocked: false }),
      ...payload,
      key,
    };
    saveVendorState(state);
    const result = await publishStatus(state).catch((error) => ({
      published: false,
      error: error.message,
    }));
    return { key, ...result };
  });

  /** Extends a customer by whole months from the later of today and the current end. */
  ipcMain.handle('vendor:extend', async (_event, installId, months) => {
    const state = vendorState();
    const customer = state.customers[installId];
    if (!customer) throw new Error('Mijoz topilmadi');
    const today = new Date().toISOString().slice(0, 10);
    const base = new Date(
      `${customer.expiresAt > today ? customer.expiresAt : today}T00:00:00Z`,
    );
    base.setUTCMonth(base.getUTCMonth() + Number(months || 1));
    const { payload, key } = signLicense(
      { ...customer, expiresAt: base.toISOString().slice(0, 10) },
      state.statusUrl,
    );
    state.customers[installId] = {
      ...customer,
      ...payload,
      key,
      blocked: false,
    };
    saveVendorState(state);
    const result = await publishStatus(state).catch((error) => ({
      published: false,
      error: error.message,
    }));
    return { key, expiresAt: payload.expiresAt, ...result };
  });

  /** Changes a customer's features, menus and limits without touching the paid period. */
  // Configuration keys a template / rollback carries (never the paid period).
  const CONFIG_KEYS = [
    'features',
    'hiddenMenus',
    'settings',
    'deniedPermissions',
    'maxBranches',
    'maxUsers',
    'maxDevices',
  ];
  const pickConfig = (source) =>
    Object.fromEntries(
      CONFIG_KEYS.filter((key) => source[key] !== undefined).map((key) => [
        key,
        source[key],
      ]),
    );

  /** Re-signs one customer with configuration changes (state saved by the caller). */
  function resign(state, installId, changes) {
    const customer = state.customers[installId];
    if (!customer) throw new Error('Mijoz topilmadi');
    const { payload, key } = signLicense(
      { ...customer, ...pickConfig(changes) },
      state.statusUrl,
    );
    state.customers[installId] = { ...customer, ...payload, key };
    return key;
  }

  const publishSafe = (state) =>
    publishStatus(state).catch((error) => ({
      published: false,
      error: error.message,
    }));

  ipcMain.handle('vendor:update', async (_event, installId, changes) => {
    const state = vendorState();
    const key = resign(state, installId, changes);
    saveVendorState(state);
    return { key, ...(await publishSafe(state)) };
  });

  /** Same configuration for several customers at once (one publish). */
  ipcMain.handle('vendor:bulkUpdate', async (_event, installIds, changes) => {
    const state = vendorState();
    const ids = [...new Set((installIds ?? []).map(String))];
    if (!ids.length) throw new Error('Mijoz tanlanmagan');
    for (const id of ids) resign(state, id, changes);
    saveVendorState(state);
    return { updated: ids.length, ...(await publishSafe(state)) };
  });

  // Named configuration templates ("Oddiy fast food", "Faqat kassa", ...).
  ipcMain.handle('vendor:templates', () => vendorState().templates ?? {});
  ipcMain.handle('vendor:saveTemplate', (_event, name, config) => {
    const state = vendorState();
    const title = String(name || '')
      .trim()
      .slice(0, 60);
    if (!title) throw new Error('Shablon nomini kiriting');
    state.templates = {
      ...(state.templates ?? {}),
      [title]: pickConfig(config),
    };
    saveVendorState(state);
    return state.templates;
  });
  ipcMain.handle('vendor:deleteTemplate', (_event, name) => {
    const state = vendorState();
    if (state.templates) delete state.templates[name];
    saveVendorState(state);
    return state.templates ?? {};
  });

  /** Every licence signed for a customer, newest first (configuration history). */
  ipcMain.handle('vendor:customerHistory', (_event, installId) =>
    vendorHistory()
      .filter((row) => row.installId === installId)
      .map((row) => ({
        issuedAt: row.issuedAt,
        expiresAt: row.expiresAt,
        features: row.features ?? [],
        hiddenMenus: row.hiddenMenus ?? [],
        deniedPermissions: row.deniedPermissions ?? [],
        locked: Object.keys(row.settings?.orders ?? {}),
      }))
      .reverse(),
  );

  /** Restores an earlier configuration; the current paid period is kept. */
  ipcMain.handle('vendor:rollback', async (_event, installId, issuedAt) => {
    const row = vendorHistory().find(
      (item) => item.installId === installId && item.issuedAt === issuedAt,
    );
    if (!row) throw new Error('Tarixdagi holat topilmadi');
    const state = vendorState();
    const key = resign(state, installId, row);
    saveVendorState(state);
    return { key, ...(await publishSafe(state)) };
  });

  const paymentWatch = alerts.createPaymentWatch({
    vendorState,
    saveVendorState,
    log,
  });

  const reportWatch = reports.createReportWatch({
    vendorDir: VENDOR_DIR,
    vendorState,
    saveVendorState,
    log,
  });

  /** Every install that reported in (demo and paid), newest first. */
  ipcMain.handle('vendor:installs', () => {
    const state = vendorState();
    const installs = Object.values(state.installs ?? {});
    return installs
      .map((item) => ({
        installId: item.installId,
        version: item.version,
        installedAt: item.installedAt,
        firstSeen: item.firstSeen,
        lastSeen: item.lastSeen,
        license: item.license ?? null,
        business: item.business ?? null,
        paid: !!state.customers[item.installId],
        blocked:
          !!state.blockedInstalls?.[item.installId] ||
          !!state.customers[item.installId]?.blocked,
        sameMachine: item.machine
          ? installs
              .filter(
                (other) =>
                  other.machine === item.machine &&
                  other.installId !== item.installId,
              )
              .map((other) => other.installId)
          : [],
      }))
      .sort((a, b) => String(b.firstSeen).localeCompare(String(a.firstSeen)));
  });

  ipcMain.handle('vendor:checkReports', () => reportWatch.poll());

  /** Blocks or unblocks any install by its ID (e.g. a demo that has no licence). */
  ipcMain.handle('vendor:blockInstall', async (_event, installId, blocked) => {
    const id = String(installId || '')
      .trim()
      .toUpperCase();
    if (!/^FF-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/.test(id))
      throw new Error('O‘rnatish ID noto‘g‘ri (FF-XXXX-XXXX-XXXX)');
    const state = vendorState();
    if (state.customers[id]) state.customers[id].blocked = !!blocked;
    else {
      state.blockedInstalls ??= {};
      if (blocked) state.blockedInstalls[id] = new Date().toISOString();
      else delete state.blockedInstalls[id];
    }
    saveVendorState(state);
    return publishStatus(state).catch((error) => ({
      published: false,
      error: error.message,
    }));
  });

  /** Connects the vendor's Telegram bot; the chat is found from the vendor's /start. */
  ipcMain.handle('vendor:telegram', async (_event, token) => {
    const state = vendorState();
    if (token && String(token).trim()) {
      state.telegram = { token: String(token).trim() };
      const me = await alerts.telegram(state, 'getMe');
      state.telegram.bot = me.username;
      saveVendorState(state);
    }
    if (!state.telegram?.token) throw new Error('Bot tokenini kiriting');
    const updates = await alerts.telegram(state, 'getUpdates', { timeout: 0 });
    const chat = [...updates]
      .reverse()
      .map((update) => update.message?.chat)
      .find((item) => item && item.type === 'private');
    if (!chat) return { connected: false, bot: state.telegram.bot ?? null };
    state.telegram.chatId = chat.id;
    saveVendorState(state);
    await alerts.telegram(state, 'sendMessage', {
      chat_id: chat.id,
      text: '✅ FastFood sotuvchi paneli ulandi. Mijozlarning to‘lov muddati yaqinlashganda yoki tugaganda shu yerga xabar keladi.',
    });
    void paymentWatch.check();
    return { connected: true, bot: state.telegram.bot ?? null };
  });

  ipcMain.handle('vendor:telegramOff', () => {
    const state = vendorState();
    delete state.telegram;
    saveVendorState(state);
    return true;
  });

  ipcMain.handle('vendor:block', async (_event, installId, blocked) => {
    const state = vendorState();
    if (!state.customers[installId]) throw new Error('Mijoz topilmadi');
    state.customers[installId].blocked = !!blocked;
    saveVendorState(state);
    return publishStatus(state);
  });

  const RELEASE_REPO = 'fastfood-yangilanish';

  async function uploadAsset(state, release, file, name, contentType) {
    const data = fs.readFileSync(file);
    const url = release.upload_url.replace(/\{.*\}$/, '');
    const response = await fetch(`${url}?name=${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${state.githubToken}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': contentType,
        'User-Agent': 'FastFood-Vendor',
      },
      body: data,
      signal: AbortSignal.timeout(30 * 60_000),
    });
    if (!response.ok) throw new Error(`Fayl yuklanmadi (${response.status})`);
    const asset = await response.json();
    return {
      url: asset.browser_download_url,
      sha256: crypto.createHash('sha256').update(data).digest('hex'),
      size: data.length,
    };
  }

  /**
   * Publishes a new version to every customer: uploads the installer (and APK) to a
   * public GitHub release, then adds the signed update entry to the status document.
   */
  ipcMain.handle('vendor:publishUpdate', async (_event, notes) => {
    const state = vendorState();
    if (!state.githubToken || !state.gistId)
      throw new Error('Avval masofaviy boshqaruvni ulang (GitHub token)');
    const picked = await dialog.showOpenDialog(getWindow(), {
      title: 'Yangi versiya o‘rnatuvchisini tanlang (FastFood-Setup-X.Y.Z.exe)',
      properties: ['openFile'],
      filters: [{ name: 'FastFood', extensions: ['exe'] }],
    });
    if (picked.canceled || !picked.filePaths[0]) return { cancelled: true };
    const exe = picked.filePaths[0];
    const match = /FastFood-Setup-(\d+\.\d+\.\d+)\.exe$/i.exec(exe);
    if (!match)
      throw new Error(
        'Fayl nomi FastFood-Setup-X.Y.Z.exe ko‘rinishida bo‘lishi kerak',
      );
    const version = match[1];
    const apkPath = path.join(path.dirname(exe), `FastFood-${version}.apk`);
    const user = await github(state, 'GET', '/user');
    let repo;
    try {
      repo = await github(state, 'GET', `/repos/${user.login}/${RELEASE_REPO}`);
    } catch {
      try {
        repo = await github(state, 'POST', '/user/repos', {
          name: RELEASE_REPO,
          description: 'FastFood dasturi yangilanishlari',
          private: false,
          auto_init: true,
        });
      } catch {
        throw new Error(
          'GitHub token yangilanish joylashga ruxsat bermadi. Yangi token yarating: “gist” va “public_repo” belgilari yoqilgan bo‘lsin, so‘ng uni shu sahifada qayta ulang.',
        );
      }
    }
    const tag = `v${version}`;
    let release;
    try {
      release = await github(
        state,
        'GET',
        `/repos/${repo.full_name}/releases/tags/${tag}`,
      );
    } catch {
      release = await github(
        state,
        'POST',
        `/repos/${repo.full_name}/releases`,
        {
          tag_name: tag,
          name: `FastFood ${version}`,
          body: String(notes || ''),
        },
      );
    }
    const existing = new Map(
      (release.assets ?? []).map((asset) => [asset.name, asset]),
    );
    for (const name of [path.basename(exe), path.basename(apkPath)])
      if (existing.has(name))
        await github(
          state,
          'DELETE',
          `/repos/${repo.full_name}/releases/assets/${existing.get(name).id}`,
        ).catch(() => null);
    const exeAsset = await uploadAsset(
      state,
      release,
      exe,
      path.basename(exe),
      'application/octet-stream',
    );
    const apkAsset = fs.existsSync(apkPath)
      ? await uploadAsset(
          state,
          release,
          apkPath,
          path.basename(apkPath),
          'application/vnd.android.package-archive',
        )
      : null;
    state.update = {
      version,
      notes: String(notes || '').slice(0, 2000),
      publishedAt: new Date().toISOString(),
      exe: exeAsset,
      ...(apkAsset ? { apk: apkAsset } : {}),
    };
    saveVendorState(state);
    await publishStatus(state);
    log(`published update ${version}`);
    return { version, apk: !!apkAsset };
  });

  return {
    VENDOR_DIR,
    VENDOR_KEY,
    vendorState,
    saveVendorState,
    paymentWatch,
    reportWatch,
    isVendorComputer,
    ALL_FEATURES,
  };
}

module.exports = { registerVendor };
