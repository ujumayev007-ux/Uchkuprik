import type { Permission } from '../auth/permissions.js';

// Feature catalog: every panel, module, action, button, report field and financial
// visibility switch SUPER_OWNER can control per customer. Keys are stable identifiers
// stored in policies; labels are Uzbek UI text. Routes are the API endpoints the
// feature guards: the backend enforces them, the UI only mirrors the result.

export type FeatureKind =
  'panel' | 'module' | 'action' | 'button' | 'report_field' | 'financial';

export type ParamValue = number | string | boolean;

/**
 * A value SUPER_OWNER sets next to a feature's switch (a limit, a default mode).
 * Values can differ per role; `ownerCap` marks numbers a restaurant Admin may only
 * lower, never raise, when the feature is delegated.
 */
export type ParamDef =
  | {
      key: string;
      label: string;
      hint?: string;
      type: 'int';
      min: number;
      max: number;
      unit?: string;
      default: number;
      ownerCap?: boolean;
    }
  | {
      key: string;
      label: string;
      hint?: string;
      type: 'bool';
      default: boolean;
    }
  | {
      key: string;
      label: string;
      hint?: string;
      type: 'enum';
      options: { value: string; label: string }[];
      default: string;
    };

export type FeatureDef = {
  key: string;
  kind: FeatureKind;
  group: string;
  label: string;
  hint?: string;
  // Role permission removed from every user while the feature is off.
  permission?: Permission;
  // Sidebar path hidden while the feature is off (panels).
  menuPath?: string;
  // 'METHOD /path/:param' patterns relative to /api; '*' matches the rest of the path.
  routes?: string[];
  // Internet-dependent features can never be allowed offline.
  offlineCapable: boolean;
  // Offline default when the policy does not say otherwise.
  defaultOffline: boolean;
  // Features that start switched off (cashier cost visibility).
  defaultMode?: 'ON' | 'OFF';
  // Marks sensitive money-related switches in the Owner UI.
  sensitive?: boolean;
  // Values configured next to the switch (per restaurant and per role).
  params?: ParamDef[];
};

const f = (
  def: Omit<FeatureDef, 'offlineCapable' | 'defaultOffline'> & {
    offline?: 'default' | 'off' | 'never';
  },
): FeatureDef => {
  const { offline = 'default', ...rest } = def;
  return {
    ...rest,
    offlineCapable: offline !== 'never',
    defaultOffline: offline === 'default',
  };
};

export const featureCatalog: FeatureDef[] = [
  // ---- Kassa va buyurtmalar ----
  f({
    key: 'panel.pos',
    kind: 'panel',
    group: 'Kassa va buyurtmalar',
    label: 'Kassa paneli',
    permission: 'pos.access',
    menuPath: '/kassa',
  }),
  f({
    key: 'orders.view',
    kind: 'action',
    group: 'Kassa va buyurtmalar',
    label: 'Buyurtmalarni ko‘rish',
    permission: 'orders.view',
    menuPath: '/buyurtmalar',
    routes: ['GET /orders', 'GET /orders/:id', 'GET /orders/:id/events'],
  }),
  f({
    key: 'orders.create',
    kind: 'action',
    group: 'Kassa va buyurtmalar',
    label: 'Buyurtma yaratish',
    hint: 'Oflayn rejimda faqat Kassa panelidan.',
    permission: 'orders.create',
    routes: ['POST /orders'],
  }),
  f({
    key: 'orders.edit',
    kind: 'action',
    group: 'Kassa va buyurtmalar',
    label: 'Buyurtmani tahrirlash va oshxonaga yuborish',
    hint: 'Oflayn rejimda faqat Kassa panelidan.',
    permission: 'orders.edit',
    routes: [
      'PATCH /orders/:id',
      'POST /orders/:id/items',
      'PATCH /orders/:id/items/:itemId',
      'POST /orders/:id/place',
    ],
  }),
  f({
    key: 'orders.cancel',
    kind: 'button',
    group: 'Kassa va buyurtmalar',
    label: 'Buyurtmani bekor qilish',
    permission: 'orders.cancel',
    routes: [
      'POST /orders/:id/cancel',
      'POST /orders/:id/items/:itemId/cancel',
    ],
    offline: 'off',
  }),
  f({
    key: 'discounts.apply',
    kind: 'button',
    group: 'Kassa va buyurtmalar',
    label: 'Chegirma qo‘llash',
    permission: 'discounts.apply',
    routes: ['POST /orders/:id/discount'],
    offline: 'off',
    sensitive: true,
  }),
  f({
    key: 'payments.accept',
    kind: 'action',
    group: 'Kassa va buyurtmalar',
    label: 'To‘lov qabul qilish',
    permission: 'payments.accept',
    routes: ['POST /orders/:id/payments', 'POST /orders/:id/complete'],
  }),
  f({
    key: 'payments.refund',
    kind: 'button',
    group: 'Kassa va buyurtmalar',
    label: 'Pulni qaytarish',
    permission: 'payments.refund',
    routes: ['POST /orders/:id/refunds'],
    offline: 'off',
    sensitive: true,
  }),
  f({
    key: 'receipts.print',
    kind: 'button',
    group: 'Kassa va buyurtmalar',
    label: 'Chek chiqarish',
    routes: [
      'GET /orders/:id/receipt',
      'POST /orders/:id/receipt/print',
      'GET /receipt-printers',
    ],
  }),
  f({
    key: 'orders.approve',
    kind: 'action',
    group: 'Kassa va buyurtmalar',
    label: 'Onlayn buyurtmani tasdiqlash',
    permission: 'orders.approve',
    routes: ['POST /orders/:id/approve', 'POST /orders/:id/reject'],
    offline: 'never',
  }),
  f({
    key: 'shift.view',
    kind: 'action',
    group: 'Kassa smenasi',
    label: 'Smenani va smena hisobotini ko‘rish',
    menuPath: '/smena',
    routes: ['GET /shifts', 'GET /shifts/current', 'GET /shifts/:id/report'],
  }),
  f({
    key: 'shift.open',
    kind: 'action',
    group: 'Kassa smenasi',
    label: 'Smena ochish',
    permission: 'shifts.manage',
    routes: ['POST /shifts/open'],
  }),
  f({
    key: 'shift.close',
    kind: 'button',
    group: 'Kassa smenasi',
    label: 'Smenani yopish',
    routes: ['POST /shifts/:id/close'],
  }),
  f({
    key: 'cash.movements',
    kind: 'action',
    group: 'Kassa smenasi',
    label: 'Kassaga pul kiritish va chiqarish',
    routes: ['POST /shifts/current/movements'],
    offline: 'off',
    sensitive: true,
  }),
  // ---- Oshxona ----
  f({
    key: 'kitchen.board',
    kind: 'panel',
    group: 'Oshxona',
    label: 'Oshxona ekrani va navbat',
    permission: 'kitchen.access',
    menuPath: '/oshxona',
    routes: [
      'GET /kitchen/tickets',
      'POST /kitchen/items/:id/status',
      'POST /kitchen/items/:id/cancel-request',
      'POST /kitchen/orders/:id/bump',
      'POST /orders/:id/priority',
      'POST /orders/:id/serve',
      'GET /queue',
    ],
  }),
  f({
    key: 'kitchen.manage',
    kind: 'module',
    group: 'Oshxona',
    label: 'Oshxona bekatlari va shablonlari',
    routes: [
      'GET /kitchen/stations',
      'POST /kitchen/stations',
      'PATCH /kitchen/stations/:id',
      'PUT /kitchen/stations/:id/template',
      'POST /kitchen/stations/:id/test-print',
    ],
    offline: 'off',
  }),
  f({
    key: 'printing.manage',
    kind: 'module',
    group: 'Oshxona',
    label: 'Printerlar va chop etish navbati',
    menuPath: '/printerlar',
    routes: [
      '* /printers',
      '* /printers/*',
      '* /print-jobs',
      '* /print-jobs/*',
    ],
  }),
  f({
    key: 'receipts.design',
    kind: 'module',
    group: 'Oshxona',
    label: 'Chek dizayni va shablonlar (58/80 mm va boshqa kenglik)',
    hint: 'Shablonlarni printer, bo‘lim yoki chek turiga biriktirish va sinov chop etish.',
    menuPath: '/chek-dizayni',
    routes: [
      '* /receipt-templates',
      '* /receipt-templates/*',
      '* /settings/receipt',
    ],
  }),
  // ---- Ombor ----
  f({
    key: 'inventory.view',
    kind: 'panel',
    group: 'Ombor',
    label: 'Omborni ko‘rish',
    permission: 'inventory.view',
    menuPath: '/ombor',
    routes: [
      'GET /inventory/*',
      'GET /recipes/:variantId',
      'GET /suppliers',
      'GET /purchases',
      'GET /suppliers/:id/returns',
    ],
  }),
  f({
    key: 'inventory.adjust',
    kind: 'action',
    group: 'Ombor',
    label: 'Ombor tuzatishlari, inventarizatsiya, ko‘chirish',
    permission: 'inventory.manage',
    routes: [
      'POST /inventory/adjustments',
      'POST /inventory/stocktakes',
      'POST /inventory/transfers',
      'POST /inventory/items',
      'PATCH /inventory/items/:id',
      'POST /inventory/requests',
      'POST /inventory/requests/:id/decide',
      'POST /inventory/requests/from-alerts',
    ],
    offline: 'off',
  }),
  f({
    key: 'purchasing.manage',
    kind: 'module',
    group: 'Ombor',
    label: 'Xaridlar va yetkazib beruvchilar',
    permission: 'purchasing.manage',
    routes: [
      'POST /purchases',
      'PATCH /purchases/:id',
      'POST /purchases/:id/cancel',
      'POST /purchases/:id/receive',
      'POST /purchases/market',
      'POST /suppliers',
      'PATCH /suppliers/:id',
      'POST /suppliers/:id/returns',
    ],
    offline: 'off',
  }),
  f({
    key: 'finance.debts',
    kind: 'action',
    group: 'Ombor',
    label: 'Yetkazib beruvchi qarzlari va xodim qarzlari',
    routes: ['POST /suppliers/:id/payments', 'GET /payroll/loans'],
    offline: 'off',
    sensitive: true,
  }),
  f({
    key: 'recipes.manage',
    kind: 'action',
    group: 'Ombor',
    label: 'Retseptlarni o‘zgartirish',
    routes: ['PUT /recipes/:variantId'],
    offline: 'off',
  }),
  // ---- Menyu ----
  f({
    key: 'menu.view',
    kind: 'action',
    group: 'Menyu',
    label: 'Menyuni ko‘rish',
    permission: 'menu.view',
    routes: ['GET /menu'],
  }),
  f({
    key: 'menu.manage',
    kind: 'panel',
    group: 'Menyu',
    label: 'Menyuni boshqarish',
    permission: 'menu.manage',
    menuPath: '/menyu',
    routes: ['POST /menu/*', 'PATCH /menu/*', 'PUT /menu/*', 'DELETE /menu/*'],
    offline: 'off',
  }),
  // ---- Mijozlar ----
  f({
    key: 'customers.view',
    kind: 'panel',
    group: 'Mijozlar va sodiqlik',
    label: 'Mijozlar ro‘yxati',
    permission: 'customers.view',
    menuPath: '/mijozlar',
    routes: [
      'GET /customers',
      'GET /customers/:id',
      'GET /feedback',
      'GET /coupons',
    ],
  }),
  f({
    key: 'customers.manage',
    kind: 'action',
    group: 'Mijozlar va sodiqlik',
    label: 'Mijoz ma’lumotlari va buyurtmaga biriktirish',
    permission: 'customers.manage',
    routes: [
      'PATCH /customers/:id',
      'POST /customers/:id/card',
      'POST /customers/:id/referrer',
      'POST /orders/:id/customer',
      'POST /feedback/:id/resolve',
    ],
  }),
  f({
    key: 'loyalty.points',
    kind: 'action',
    group: 'Mijozlar va sodiqlik',
    label: 'Ballarni qo‘lda o‘zgartirish',
    routes: ['POST /customers/:id/points'],
    offline: 'off',
    sensitive: true,
  }),
  f({
    key: 'loyalty.coupons',
    kind: 'action',
    group: 'Mijozlar va sodiqlik',
    label: 'Promokodlar',
    routes: [
      'POST /coupons',
      'PATCH /coupons/:id',
      'POST /orders/:id/coupon',
      'DELETE /orders/:id/coupon',
    ],
    offline: 'off',
  }),
  f({
    key: 'customers.export',
    kind: 'button',
    group: 'Mijozlar va sodiqlik',
    label: 'Mijozlar ro‘yxatini yuklab olish',
    routes: ['GET /customers-export/*'],
    offline: 'off',
    sensitive: true,
  }),
  // ---- Yetkazib berish ----
  f({
    key: 'delivery.manage',
    kind: 'panel',
    group: 'Yetkazib berish',
    label: 'Yetkazib berish paneli',
    permission: 'delivery.manage',
    menuPath: '/yetkazish',
    routes: [
      '* /delivery/*',
      'POST /orders/:id/courier',
      'POST /orders/:id/delivery-location',
      'POST /orders/:id/delivery-zone',
    ],
  }),
  f({
    key: 'delivery.courier',
    kind: 'panel',
    group: 'Yetkazib berish',
    label: 'Kuryer paneli',
    permission: 'delivery.courier',
    menuPath: '/kuryer',
    routes: ['* /courier/*'],
  }),
  // ---- Xodimlar ----
  f({
    key: 'hr.attendance',
    kind: 'panel',
    group: 'Xodimlar va maosh',
    label: 'Ish vaqti va jadval',
    menuPath: '/ish-vaqti',
    routes: [
      '* /attendance',
      '* /attendance/*',
      '* /schedule',
      '* /schedule/*',
      'GET /hr/employees',
    ],
  }),
  f({
    key: 'hr.payroll',
    kind: 'panel',
    group: 'Xodimlar va maosh',
    label: 'Ish haqi hisobi',
    permission: 'hr.manage',
    menuPath: '/ish-haqi',
    routes: [
      'PUT /hr/employees/:userId',
      'POST /payroll/*',
      'GET /payroll/periods',
      'GET /payroll/periods/:id',
    ],
    offline: 'off',
    sensitive: true,
  }),
  // ---- Moliya ----
  f({
    key: 'finance.expenses',
    kind: 'panel',
    group: 'Moliya',
    label: 'Xarajatlar',
    permission: 'finance.manage',
    menuPath: '/moliya',
    routes: [
      '* /expenses',
      '* /expenses/*',
      '* /finance/attachments',
      '* /finance/attachments/*',
    ],
    offline: 'off',
    sensitive: true,
  }),
  f({
    key: 'finance.manage',
    kind: 'module',
    group: 'Moliya',
    label: 'Moliyaviy davrlarni yopish va sozlamalar',
    routes: [
      '* /finance/close',
      '* /finance/closed-periods',
      '* /finance/settings',
    ],
    offline: 'off',
    sensitive: true,
  }),
  // ---- Hisobotlar ----
  f({
    key: 'reports.sales',
    kind: 'panel',
    group: 'Hisobotlar',
    label: 'Kunlik savdo hisoboti',
    hint: 'Oflayn rejimda mahalliy kunlik hisobot.',
    permission: 'reports.view',
    menuPath: '/hisobotlar',
    routes: ['GET /reports/sales', 'GET /reports/kitchen'],
  }),
  f({
    key: 'reports.export',
    kind: 'button',
    group: 'Hisobotlar',
    label: 'Hisobotlarni faylga yuklab olish (CSV)',
    routes: [
      'GET /reports/sales.csv',
      'GET /reports/pnl.csv',
      'GET /payroll/periods/:id/export.csv',
      'GET /franchise/statements.csv',
      'GET /tenant/export',
    ],
    offline: 'off',
  }),
  f({
    key: 'reports.finance',
    kind: 'module',
    group: 'Hisobotlar',
    label: 'Foyda-zarar va filiallar bo‘yicha moliyaviy hisobotlar',
    routes: [
      'GET /reports/pnl',
      'GET /reports/branches',
      'GET /reports/fiscal',
      'GET /reports/brands',
      'GET /payments/reconciliation',
    ],
    offline: 'off',
    sensitive: true,
  }),
  f({
    key: 'insights.view',
    kind: 'panel',
    group: 'Hisobotlar',
    label: 'Tahlil va prognoz',
    menuPath: '/tahlil',
    routes: ['GET /reports/forecast', 'GET /reports/risk'],
    offline: 'off',
  }),
  // ---- Sozlamalar va boshqaruv ----
  f({
    key: 'settings.manage',
    kind: 'panel',
    group: 'Sozlamalar va boshqaruv',
    label: 'Restoran sozlamalari',
    permission: 'settings.manage',
    menuPath: '/sozlamalar',
    routes: ['* /settings', '* /settings/*'],
  }),
  f({
    key: 'settings.workflow',
    kind: 'module',
    group: 'Sozlamalar va boshqaruv',
    label: 'Buyurtma jarayoni qoidalari (tasdiqlash, bekor qilish, tahrirlash)',
    routes: ['* /settings/orders'],
  }),
  f({
    key: 'settings.fiscal',
    kind: 'module',
    group: 'Sozlamalar va boshqaruv',
    label: 'Fiskal (soliq) sozlamalari',
    sensitive: true,
    routes: ['* /settings/fiscal'],
  }),
  f({
    key: 'settings.loyalty',
    kind: 'module',
    group: 'Sozlamalar va boshqaruv',
    label: 'Sodiqlik qoidalari',
    routes: ['* /settings/loyalty-rules'],
  }),
  f({
    key: 'settings.qrpay',
    kind: 'module',
    group: 'Sozlamalar va boshqaruv',
    label: 'QR to‘lov sozlamalari',
    sensitive: true,
    routes: ['* /settings/qr-payment'],
  }),
  f({
    key: 'floor.view',
    kind: 'action',
    group: 'Sozlamalar va boshqaruv',
    label: 'Zal va stollarni ko‘rish',
    routes: ['GET /floor'],
  }),
  f({
    key: 'floor.manage',
    kind: 'panel',
    group: 'Sozlamalar va boshqaruv',
    label: 'Zallar va stollarni boshqarish',
    permission: 'tables.manage',
    menuPath: '/zallar',
    routes: [
      'POST /rooms',
      'PATCH /rooms/:id',
      'POST /tables',
      'PATCH /tables/:id',
      'POST /tables/:id/rotate-qr',
    ],
    offline: 'off',
  }),
  f({
    key: 'users.manage',
    kind: 'panel',
    group: 'Sozlamalar va boshqaruv',
    label: 'Xodimlar',
    permission: 'users.manage',
    menuPath: '/xodimlar',
    routes: ['* /users', '* /users/*'],
    offline: 'off',
  }),
  f({
    key: 'roles.manage',
    kind: 'panel',
    group: 'Sozlamalar va boshqaruv',
    label: 'Rollar va ruxsatlar',
    permission: 'roles.manage',
    menuPath: '/rollar',
    routes: ['* /roles', '* /roles/*'],
    offline: 'off',
  }),
  f({
    key: 'branches.manage',
    kind: 'panel',
    group: 'Sozlamalar va boshqaruv',
    label: 'Filiallar',
    permission: 'branches.manage',
    menuPath: '/filiallar',
    routes: ['* /branches', '* /branches/*'],
    offline: 'off',
  }),
  f({
    key: 'devices.manage',
    kind: 'panel',
    group: 'Sozlamalar va boshqaruv',
    label: 'Qurilmalarni ro‘yxatdan o‘tkazish',
    permission: 'devices.manage',
    menuPath: '/qurilmalar',
    routes: [
      'GET /devices',
      'POST /devices/register',
      'POST /devices/:id/revoke',
    ],
  }),
  f({
    key: 'audit.view',
    kind: 'panel',
    group: 'Sozlamalar va boshqaruv',
    label: 'Audit jurnali',
    permission: 'audit.view',
    menuPath: '/audit',
    routes: ['GET /audit-logs'],
  }),
  f({
    key: 'notifications.manage',
    kind: 'panel',
    group: 'Sozlamalar va boshqaruv',
    label: 'Bildirishnomalar (Telegram)',
    permission: 'notifications.manage',
    menuPath: '/bildirishnomalar',
    routes: ['* /notifications/*'],
    offline: 'never',
  }),
  // ---- Internet talab qiladigan xizmatlar ----
  f({
    key: 'online.ordering',
    kind: 'module',
    group: 'Internet xizmatlari',
    label: 'Onlayn buyurtma (sayt va Telegram)',
    routes: [
      '* /public/orders',
      '* /public/orders/*',
      '* /public/r/*',
      '* /public/t/*',
      'POST /webhooks/telegram/:tenantId',
    ],
    offline: 'never',
  }),
  f({
    key: 'online.payments',
    kind: 'module',
    group: 'Internet xizmatlari',
    label: 'Onlayn to‘lov (Click, Payme)',
    menuPath: '/tolovlar',
    routes: [
      '* /payments/providers',
      '* /payments/providers/*',
      '* /webhooks/click/*',
      '* /webhooks/payme/*',
    ],
    offline: 'never',
  }),
  f({
    key: 'developer.api',
    kind: 'panel',
    group: 'Internet xizmatlari',
    label: 'API kalitlari va webhooklar',
    permission: 'developer.manage',
    menuPath: '/integratsiyalar',
    routes: ['* /developer/*', 'GET /v1/*'],
    offline: 'never',
  }),
  // ---- Qo'shimcha modullar ----
  f({
    key: 'module.brands',
    kind: 'panel',
    group: 'Qo‘shimcha modullar',
    label: 'Brendlar',
    permission: 'brands.manage',
    menuPath: '/brendlar',
    routes: ['* /brands', '* /brands/*'],
    offline: 'off',
  }),
  f({
    key: 'module.franchise',
    kind: 'panel',
    group: 'Qo‘shimcha modullar',
    label: 'Franshiza',
    permission: 'franchise.manage',
    menuPath: '/franshiza',
    routes: [
      '* /franchise/*',
      '* /supplier-agreements',
      '* /supplier-agreements/*',
    ],
    offline: 'off',
  }),
  f({
    key: 'module.operations',
    kind: 'panel',
    group: 'Qo‘shimcha modullar',
    label: 'Operatsion nazorat (cheklist, harorat)',
    permission: 'operations.manage',
    menuPath: '/operatsiyalar',
    routes: ['* /operations/*'],
  }),
  f({
    key: 'module.assets',
    kind: 'panel',
    group: 'Qo‘shimcha modullar',
    label: 'Uskunalar va ta’mirlash',
    permission: 'assets.manage',
    menuPath: '/uskunalar',
    routes: [
      '* /assets',
      '* /assets/*',
      '* /maintenance-plans/*',
      '* /repair-tickets',
      '* /repair-tickets/*',
      '* /service-contracts',
      '* /service-contracts/*',
    ],
  }),
  f({
    key: 'module.training',
    kind: 'panel',
    group: 'Qo‘shimcha modullar',
    label: 'O‘qitish va sertifikatlar',
    permission: 'training.manage',
    menuPath: '/oqitish',
    routes: ['* /training/*'],
  }),
  f({
    key: 'module.approvals',
    kind: 'panel',
    group: 'Qo‘shimcha modullar',
    label: 'Tasdiqlash so‘rovlari',
    permission: 'approvals.decide',
    menuPath: '/tasdiqlar',
    routes: ['* /approvals', '* /approvals/*'],
  }),
  f({
    key: 'billing.view',
    kind: 'module',
    group: 'Qo‘shimcha modullar',
    label: 'Obuna va tarif (bulutli rejim)',
    menuPath: '/obuna',
    routes: ['* /billing', '* /billing/*', 'POST /tenant/close'],
    offline: 'never',
  }),
  // ---- Buyurtma qabul qilish, tahrirlash va ko‘rinish ----
  f({
    key: 'orders.type.dine_in',
    kind: 'button',
    group: 'Buyurtma qabul qilish',
    label: 'Zalda (stol bilan) buyurtma yaratish',
    hint: 'Rollar bo‘yicha alohida o‘chirish mumkin.',
  }),
  f({
    key: 'orders.type.takeaway',
    kind: 'button',
    group: 'Buyurtma qabul qilish',
    label: 'Olib ketish buyurtmasi yaratish',
  }),
  f({
    key: 'orders.type.delivery',
    kind: 'button',
    group: 'Buyurtma qabul qilish',
    label: 'Yetkazib berish buyurtmasi yaratish',
  }),
  f({
    key: 'orders.walkin',
    kind: 'button',
    group: 'Buyurtma qabul qilish',
    label: '«Mijoz» tugmasi: stol tanlanmagan buyurtma',
    hint: 'Kassir mijoz buyurtmasini stolsiz qabul qiladi; ofitsiant keyin stol belgilaydi.',
  }),
  f({
    key: 'orders.table.assign',
    kind: 'action',
    group: 'Buyurtma qabul qilish',
    label: 'Buyurtmaga stol belgilash va almashtirish',
    hint: 'To‘lov, taomlar va tarix saqlanadi; buyurtma qayta yaratilmaydi.',
    routes: ['POST /orders/:id/table'],
  }),
  f({
    key: 'orders.table.single',
    kind: 'module',
    group: 'Buyurtma qabul qilish',
    label: 'Bir stolga bitta faol buyurtma',
    hint: 'Yoqilgan: stol qayta ochilganda faol buyurtma tiklanadi va ikkinchi nusxa yaratilmaydi. O‘chirilgan: bir stolda bir nechta alohida hisob.',
  }),
  f({
    key: 'discounts.percent',
    kind: 'button',
    group: 'Chegirmalar',
    label: 'Foizli chegirma',
    hint: 'Chegirma qo‘llash huquqi ham kerak (Chegirma qo‘llash).',
    sensitive: true,
    offline: 'off',
    params: [
      {
        key: 'maxPercent',
        label: 'Eng ko‘p chegirma',
        type: 'int',
        min: 0,
        max: 100,
        unit: '%',
        default: 100,
        ownerCap: true,
      },
    ],
  }),
  f({
    key: 'discounts.fixed',
    kind: 'button',
    group: 'Chegirmalar',
    label: 'Aniq summali chegirma',
    sensitive: true,
    offline: 'off',
    params: [
      {
        key: 'maxFixed',
        label: 'Eng ko‘p chegirma summasi',
        type: 'int',
        min: 0,
        max: 100_000_000,
        unit: 'so‘m',
        default: 100_000_000,
        ownerCap: true,
      },
    ],
  }),
  f({
    key: 'orders.display',
    kind: 'module',
    group: 'Ko‘rinish va ekranlar',
    label: 'Buyurtmalar ko‘rinishi (Kassa va Ofitsiant)',
    hint: 'Yoqilgan: xodim rejimni o‘zgartira oladi. O‘chirilgan: faqat standart rejim.',
    params: [
      {
        key: 'defaultMode',
        label: 'Standart rejim',
        type: 'enum',
        options: [
          { value: 'compact', label: 'Ixcham (stol va chek raqami)' },
          { value: 'detailed', label: 'Batafsil (to‘liq ma’lumot)' },
          { value: 'grid', label: 'Moslashuvchan kartalar' },
        ],
        default: 'detailed',
      },
    ],
  }),
  f({
    key: 'tv.display',
    kind: 'module',
    group: 'Ko‘rinish va ekranlar',
    label: 'Mijozlar ekrani (TV)',
    menuPath: '/navbat',
    params: [
      {
        key: 'layout',
        label: 'Joylashuv',
        type: 'enum',
        options: [
          { value: 'split', label: 'Ikki ustun: tayyorlanmoqda | tayyor' },
          { value: 'single', label: 'Bitta ro‘yxat (tayyorlari tepada)' },
        ],
        default: 'split',
      },
      {
        key: 'showPreparing',
        label: '«Tayyorlanmoqda» holatini ko‘rsatish',
        type: 'bool',
        default: true,
      },
      {
        key: 'showReady',
        label: '«Tayyor» holatini ko‘rsatish',
        type: 'bool',
        default: true,
      },
    ],
  }),
  f({
    key: 'tv.voice',
    kind: 'action',
    group: 'Ko‘rinish va ekranlar',
    label: 'Mijozlar ekrani: o‘zbekcha ovozli e’lon',
    hint: 'Masalan: «Yettinchi buyurtma tayyor.»',
    offline: 'default',
    params: [
      {
        key: 'repeat',
        label: 'Takrorlash soni',
        type: 'int',
        min: 1,
        max: 3,
        default: 1,
      },
      {
        key: 'volume',
        label: 'Ovoz balandligi',
        type: 'int',
        min: 10,
        max: 100,
        unit: '%',
        default: 100,
      },
      {
        key: 'phrase',
        label: 'Gap shakli',
        type: 'enum',
        options: [
          { value: 'ordinal', label: 'Yettinchi buyurtma tayyor.' },
          { value: 'cardinal', label: 'Yetti raqamli buyurtma tayyor.' },
        ],
        default: 'ordinal',
      },
    ],
  }),
  f({
    key: 'waiter.notify',
    kind: 'action',
    group: 'Ko‘rinish va ekranlar',
    label: 'Ofitsiant planshetiga «yangi mijoz» bildirishnomasi',
    hint: 'Android ilovada ovozli xabar va bildirishnoma. Standart: faqat ofitsiantlar.',
    routes: ['GET /live/alerts'],
    offline: 'default',
    params: [
      {
        key: 'sound',
        label: 'Signal tovushi',
        type: 'bool',
        default: true,
      },
      {
        key: 'voice',
        label: 'O‘zbekcha ovozli e’lon',
        type: 'bool',
        default: true,
      },
      {
        key: 'volume',
        label: 'Ovoz balandligi',
        type: 'int',
        min: 10,
        max: 100,
        unit: '%',
        default: 100,
      },
      {
        key: 'repeat',
        label: 'Ovozni takrorlash',
        type: 'int',
        min: 1,
        max: 5,
        default: 1,
      },
      {
        key: 'reminderSeconds',
        label: 'Stol belgilanmaguncha eslatish (soniya, 0 = o‘chiq)',
        type: 'int',
        min: 0,
        max: 600,
        default: 0,
      },
    ],
  }),
  // ---- Moliyaviy ko'rinish (tannarx, marja, sof foyda) ----
  f({
    key: 'fin.cost',
    kind: 'financial',
    group: 'Moliyaviy ko‘rinish',
    label: 'Tannarx (barcha rollar uchun asosiy kalit)',
    hint: 'O‘chirilsa hech kim tannarxni ko‘rmaydi.',
    sensitive: true,
  }),
  f({
    key: 'fin.margin',
    kind: 'financial',
    group: 'Moliyaviy ko‘rinish',
    label: 'Marja va yalpi foyda (asosiy kalit)',
    sensitive: true,
  }),
  f({
    key: 'fin.profit',
    kind: 'financial',
    group: 'Moliyaviy ko‘rinish',
    label: 'Sof foyda (asosiy kalit)',
    sensitive: true,
  }),
  f({
    key: 'fin.cashier.cost',
    kind: 'financial',
    group: 'Moliyaviy ko‘rinish',
    label: 'Kassir tannarxni ko‘ra oladi',
    hint: 'Standart: yopiq. Faqat SUPER_OWNER yoqadi.',
    defaultMode: 'OFF',
    sensitive: true,
  }),
  f({
    key: 'fin.cashier.margin',
    kind: 'financial',
    group: 'Moliyaviy ko‘rinish',
    label: 'Kassir marjani ko‘ra oladi',
    hint: 'Standart: yopiq. Faqat SUPER_OWNER yoqadi.',
    defaultMode: 'OFF',
    sensitive: true,
  }),
  f({
    key: 'fin.cashier.profit',
    kind: 'financial',
    group: 'Moliyaviy ko‘rinish',
    label: 'Kassir sof foydani ko‘ra oladi',
    hint: 'Standart: yopiq. Faqat SUPER_OWNER yoqadi.',
    defaultMode: 'OFF',
    sensitive: true,
  }),
  f({
    key: 'field.report.cost',
    kind: 'report_field',
    group: 'Hisobot maydonlari',
    label: 'Hisobotlarda “Tannarx” ustuni',
    offline: 'default',
  }),
  f({
    key: 'field.report.margin',
    kind: 'report_field',
    group: 'Hisobot maydonlari',
    label: 'Hisobotlarda “Marja / yalpi foyda” ustuni',
  }),
  f({
    key: 'field.report.netProfit',
    kind: 'report_field',
    group: 'Hisobot maydonlari',
    label: 'Hisobotlarda “Sof foyda” ustuni',
  }),
];

export const catalogByKey = new Map(
  featureCatalog.map((def) => [def.key, def]),
);

/** Paths that always work (sign-in, health, licence entry, control channel). */
const openRoutes = [
  '* /auth/*',
  '* /pin/*',
  'GET /permissions',
  '* /license',
  '* /license/*',
  'POST /devices/heartbeat',
  '* /control/*',
  'GET /public/plans',
  'POST /public/register',
  'GET /metrics',
  'GET /health/*',
  // Platform administration of the cloud edition (not part of a restaurant).
  '* /platform/*',
  'GET /tenant/export',
];

type Matcher = { method: string; regex: RegExp; key: string | null };

function compile(pattern: string, key: string | null): Matcher {
  const space = pattern.indexOf(' ');
  const method = pattern.slice(0, space);
  const path = pattern.slice(space + 1);
  const source = path
    .split('/')
    .map((part) => {
      if (part === '*') return '.*';
      if (part.startsWith(':')) return '[^/]+';
      return part.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { method, regex: new RegExp(`^${source}/?$`), key };
}

// Exact (parameterized) patterns win over wildcards; open routes are checked first.
const matchers: Matcher[] = [
  ...openRoutes.map((pattern) => compile(pattern, null)),
  ...featureCatalog.flatMap((def) =>
    (def.routes ?? []).map((pattern) => compile(pattern, def.key)),
  ),
].sort(
  (a, b) =>
    Number(a.regex.source.includes('.*')) -
    Number(b.regex.source.includes('.*')),
);

export type RouteMatch =
  { kind: 'open' } | { kind: 'feature'; key: string } | { kind: 'unmapped' };

/** Which catalog feature guards `METHOD path` (path relative to /api, no query). */
export function matchRoute(method: string, path: string): RouteMatch {
  const upper = method.toUpperCase() === 'HEAD' ? 'GET' : method.toUpperCase();
  for (const matcher of matchers) {
    if (matcher.method !== '*' && matcher.method !== upper) continue;
    if (!matcher.regex.test(path)) continue;
    return matcher.key === null
      ? { kind: 'open' }
      : { kind: 'feature', key: matcher.key };
  }
  return { kind: 'unmapped' };
}

export function featuresForPermission(permission: string): FeatureDef[] {
  return featureCatalog.filter((def) => def.permission === permission);
}
