import { z } from 'zod';

/**
 * Restaurant workflow engine: ONE order pipeline, configured per restaurant and per
 * zone (dining hall, counter, VIP rooms, bar, delivery, QR tables, online). A zone flow
 * says who may create orders there, who approves them, when payment is due, how the
 * kitchen receives them and what staff may change. The 20 operating modes and the
 * restaurant templates are only presets of this configuration.
 *
 * The SUPER_OWNER activates a configuration (versioned, with history); the restaurant
 * server enforces it. Each order keeps a snapshot of its zone flow, so a later change
 * never alters orders already open. Without an active configuration (or for a zone it
 * does not cover) the restaurant keeps its existing behaviour.
 */

export const ZONES = [
  'HALL',
  'COUNTER',
  'VIP',
  'BAR',
  'DELIVERY',
  'QR',
  'ONLINE',
] as const;
export type Zone = (typeof ZONES)[number];

export const SOURCES = [
  'CASHIER',
  'WAITER',
  'QR',
  'TELEGRAM',
  'WEBSITE',
  'OPERATOR',
] as const;
export type Source = (typeof SOURCES)[number];

export const APPROVALS = ['AUTO', 'CASHIER', 'WAITER', 'ADMIN'] as const;
export type Approval = (typeof APPROVALS)[number];

export const PAYMENTS = [
  'PREPAY',
  'POSTPAY',
  'ADVANCE',
  'PARTIAL',
  'MIXED',
  'CREDIT',
] as const;
export type PaymentTiming = (typeof PAYMENTS)[number];

export const zoneFlowSchema = z.object({
  // Who may create orders in this zone.
  sources: z.array(z.enum(SOURCES)).min(1).max(SOURCES.length),
  // Who lets an order go to the kitchen.
  approval: z.enum(APPROVALS),
  // When money is due: PREPAY / ADVANCE gate the kitchen; the others never block it.
  payment: z.enum(PAYMENTS),
  advancePercent: z.number().int().min(1).max(100).default(30),
  // false: tickets count as accepted by the kitchen as soon as the order is placed.
  kitchenConfirm: z.boolean().default(true),
  // The order appears on the customers' queue TV.
  queueTv: z.boolean().default(true),
  // Delivery handoff and delivery confirmation with one-time codes.
  deliveryConfirm: z.boolean().default(false),
  // Changing items after the order went to the kitchen (staff without manager rights).
  edit: z.enum(['ANY', 'BEFORE_KITCHEN', 'NONE']).default('ANY'),
  // Cancelling sent items: staff allowed, or managers only.
  cancel: z.enum(['STAFF', 'MANAGER']).default('MANAGER'),
  discounts: z.enum(['ALLOW', 'MANAGER', 'NONE']).default('ALLOW'),
  // ON_PAYMENT: a served order is closed as soon as it is fully paid.
  tableClose: z.enum(['ON_PAYMENT', 'MANUAL']).default('MANUAL'),
  // AFTER_PAYMENT: kitchen tickets wait until the order is fully paid.
  kitchenPrint: z.enum(['ON_PLACE', 'AFTER_PAYMENT']).default('ON_PLACE'),
  // One kitchen station prepares every item of the zone (food court, VIP kitchen).
  stationId: z.uuid().nullable().default(null),
});
export type ZoneFlow = z.infer<typeof zoneFlowSchema>;

export const workflowConfigSchema = z.object({
  enabled: z.boolean(),
  // 1..20: the operating mode it started from (null: hand-made).
  preset: z.number().int().min(1).max(20).nullable().default(null),
  template: z.string().max(40).nullable().default(null),
  zones: z.partialRecord(z.enum(ZONES), zoneFlowSchema),
});
export type WorkflowConfig = z.infer<typeof workflowConfigSchema>;

/** What the restaurant keeps (and every order snapshots): the config and its version. */
export type ActiveWorkflow = { version: number; config: WorkflowConfig };
export type OrderWorkflow = ZoneFlow & { zone: Zone; version: number };

const flow = (value: Partial<ZoneFlow> & Pick<ZoneFlow, 'sources' | 'approval' | 'payment'>): ZoneFlow =>
  zoneFlowSchema.parse(value);

// Building blocks shared by several presets.
const waiterHall = flow({
  sources: ['WAITER'],
  approval: 'AUTO',
  payment: 'POSTPAY',
  cancel: 'MANAGER',
  tableClose: 'MANUAL',
});
const counterPrepay = flow({
  sources: ['CASHIER'],
  approval: 'AUTO',
  payment: 'PREPAY',
  kitchenConfirm: false,
  kitchenPrint: 'AFTER_PAYMENT',
  queueTv: true,
  tableClose: 'ON_PAYMENT',
});
const delivery = flow({
  sources: ['OPERATOR', 'CASHIER', 'TELEGRAM', 'WEBSITE'],
  approval: 'CASHIER',
  payment: 'POSTPAY',
  deliveryConfirm: true,
  queueTv: false,
});
const qrTables = flow({
  sources: ['QR', 'WAITER'],
  approval: 'WAITER',
  payment: 'POSTPAY',
});
const online = flow({
  sources: ['TELEGRAM', 'WEBSITE'],
  approval: 'CASHIER',
  payment: 'POSTPAY',
  queueTv: true,
});

export type Preset = {
  id: number;
  name: string;
  steps: string;
  // A capability the restaurant server needs beyond the base engine.
  needs?: 'credit' | 'scheduled';
  config: () => WorkflowConfig;
};

const zones = (value: WorkflowConfig['zones'], preset: number): WorkflowConfig => ({
  enabled: true,
  preset,
  template: null,
  zones: value,
});

/** The 20 operating modes (Owner → Mijozlar → Restoran → Ish rejimlari). */
export const PRESETS: Preset[] = [
  {
    id: 1,
    name: 'An’anaviy restoran',
    steps: 'Ofitsiant → Oshxona → Mijoz → Kassa',
    config: () => zones({ HALL: waiterHall, COUNTER: { ...counterPrepay, payment: 'POSTPAY', kitchenPrint: 'ON_PLACE' } }, 1),
  },
  {
    id: 2,
    name: 'Fast food',
    steps: 'Kassa → To‘lov → Oshxona → Mijoz',
    config: () => zones({ COUNTER: counterPrepay, HALL: counterPrepay }, 2),
  },
  {
    id: 3,
    name: 'Kassir tasdig‘i',
    steps: 'Ofitsiant → Kassir tasdig‘i → Oshxona',
    config: () => zones({ HALL: { ...waiterHall, sources: ['WAITER', 'CASHIER'], approval: 'CASHIER' } }, 3),
  },
  {
    id: 4,
    name: 'QR buyurtma',
    steps: 'Mijoz QR → Ofitsiant tasdig‘i → Oshxona',
    config: () => zones({ QR: qrTables, HALL: waiterHall }, 4),
  },
  {
    id: 5,
    name: 'Aralash buyurtma',
    steps: 'Ofitsiant / Kassa / QR → Oshxona',
    config: () =>
      zones(
        {
          HALL: { ...waiterHall, sources: ['WAITER', 'CASHIER'] },
          COUNTER: { ...counterPrepay, payment: 'MIXED', kitchenPrint: 'ON_PLACE' },
          QR: { ...qrTables, approval: 'AUTO' },
        },
        5,
      ),
  },
  {
    id: 6,
    name: 'O‘z-o‘ziga xizmat',
    steps: 'Mijoz → Kassa → Oshxona → Navbat TV',
    config: () => zones({ COUNTER: { ...counterPrepay, queueTv: true }, HALL: { ...counterPrepay, queueTv: true } }, 6),
  },
  {
    id: 7,
    name: 'Stol xizmati',
    steps: 'Ofitsiant → Oshxona → Stol → Kassa',
    config: () => zones({ HALL: { ...waiterHall, queueTv: false } }, 7),
  },
  {
    id: 8,
    name: 'Olib ketish',
    steps: 'Kassa → Oshxona → Tayyor → Mijoz',
    config: () => zones({ COUNTER: { ...counterPrepay, payment: 'PREPAY', queueTv: true } }, 8),
  },
  {
    id: 9,
    name: 'Yetkazib berish',
    steps: 'Operator → Oshxona → Kuryer → Mijoz',
    config: () => zones({ DELIVERY: delivery, ONLINE: online }, 9),
  },
  {
    id: 10,
    name: 'Telegram buyurtma',
    steps: 'Telegram → Tasdiq → Oshxona',
    config: () => zones({ ONLINE: { ...online, sources: ['TELEGRAM'] }, DELIVERY: { ...delivery, sources: ['TELEGRAM', 'OPERATOR'] } }, 10),
  },
  {
    id: 11,
    name: 'Rejalashtirilgan buyurtma',
    steps: 'Mijoz → Belgilangan vaqtda tayyorlash → Oshxona',
    needs: 'scheduled',
    config: () => zones({ ONLINE: { ...online, payment: 'ADVANCE' }, DELIVERY: { ...delivery, payment: 'ADVANCE' } }, 11),
  },
  {
    id: 12,
    name: 'Banket',
    steps: 'Admin → Bron / buyurtma → Oshxona → Hisob-kitob',
    config: () => zones({ HALL: { ...waiterHall, sources: ['CASHIER', 'WAITER'], approval: 'ADMIN', payment: 'ADVANCE', advancePercent: 30, discounts: 'MANAGER' } }, 12),
  },
  {
    id: 13,
    name: 'VIP xona',
    steps: 'Ofitsiant → Biriktirilgan oshxona → VIP xona hisobi',
    config: () => zones({ VIP: { ...waiterHall, queueTv: false, discounts: 'MANAGER' }, HALL: waiterHall }, 13),
  },
  {
    id: 14,
    name: 'Bir nechta oshxona bo‘limi',
    steps: 'Buyurtma → Osh / Kabob / Salat / Fast food bo‘limlari',
    config: () => zones({ HALL: waiterHall, COUNTER: { ...counterPrepay, kitchenConfirm: true } }, 14),
  },
  {
    id: 15,
    name: 'Bar xizmati',
    steps: 'Ofitsiant → Bar printeri → Kassa',
    config: () => zones({ BAR: { ...waiterHall, sources: ['WAITER', 'CASHIER'], kitchenConfirm: false, queueTv: false }, HALL: waiterHall }, 15),
  },
  {
    id: 16,
    name: 'Oldindan to‘lov',
    steps: 'Mijoz → Avans → Oshxona → Qolgan to‘lov',
    config: () => zones({ COUNTER: { ...counterPrepay, payment: 'ADVANCE', advancePercent: 50, kitchenPrint: 'ON_PLACE' }, HALL: { ...waiterHall, payment: 'ADVANCE', advancePercent: 50 } }, 16),
  },
  {
    id: 17,
    name: 'Mijoz qarzi (nasiya)',
    steps: 'Buyurtma → Oshxona → Mijoz qarz hisobi',
    needs: 'credit',
    config: () => zones({ HALL: { ...waiterHall, payment: 'CREDIT' }, COUNTER: { ...counterPrepay, payment: 'CREDIT', kitchenPrint: 'ON_PLACE' } }, 17),
  },
  {
    id: 18,
    name: 'Mehmonxona restorani',
    steps: 'Buyurtma → Oshxona → Mehmonxona xonasi hisobi',
    needs: 'credit',
    config: () => zones({ HALL: { ...waiterHall, payment: 'CREDIT' }, DELIVERY: { ...delivery, sources: ['OPERATOR', 'CASHIER'], payment: 'CREDIT', deliveryConfirm: false } }, 18),
  },
  {
    id: 19,
    name: 'Food court',
    steps: 'Kassa → Biriktirilgan oshxona → Umumiy navbat TV',
    config: () => zones({ COUNTER: { ...counterPrepay, queueTv: true }, HALL: { ...counterPrepay, queueTv: true } }, 19),
  },
  {
    id: 20,
    name: 'Stolga yetkazish',
    steps: 'Kassa → Oshxona → Ofitsiant stolga olib boradi',
    config: () => zones({ HALL: { ...counterPrepay, sources: ['CASHIER'], queueTv: false, tableClose: 'MANUAL' }, COUNTER: counterPrepay }, 20),
  },
];

/** Ready-made restaurant configurations (Owner → Ish rejimlari → Shablonlar). */
export const TEMPLATES: { key: string; name: string; preset: number; config: () => WorkflowConfig }[] = [
  { key: 'traditional', name: 'An’anaviy restoran', preset: 1, config: () => PRESETS[0]!.config() },
  { key: 'fastfood', name: 'Fast food', preset: 2, config: () => PRESETS[1]!.config() },
  {
    key: 'choyxona',
    name: 'Choyxona',
    preset: 7,
    config: () => ({ ...zones({ HALL: waiterHall, VIP: { ...waiterHall, queueTv: false }, COUNTER: { ...counterPrepay, payment: 'POSTPAY', kitchenPrint: 'ON_PLACE' } }, 7), template: 'choyxona' }),
  },
  {
    key: 'cafe',
    name: 'Kafe',
    preset: 5,
    config: () => ({ ...PRESETS[4]!.config(), template: 'cafe' }),
  },
  { key: 'foodcourt', name: 'Food court', preset: 19, config: () => ({ ...PRESETS[18]!.config(), template: 'foodcourt' }) },
  { key: 'delivery', name: 'Yetkazib berish oshxonasi', preset: 9, config: () => ({ ...PRESETS[8]!.config(), template: 'delivery' }) },
  { key: 'vip', name: 'VIP restoran', preset: 13, config: () => ({ ...PRESETS[12]!.config(), template: 'vip' }) },
  {
    key: 'mixed',
    name: 'Aralash restoran',
    preset: 5,
    config: () => ({
      ...zones(
        {
          HALL: waiterHall,
          COUNTER: counterPrepay,
          VIP: { ...waiterHall, queueTv: false },
          DELIVERY: delivery,
          QR: qrTables,
          ONLINE: online,
        },
        5,
      ),
      template: 'mixed',
    }),
  },
];

/** Which zone an order belongs to. */
export function zoneOf(input: {
  type: 'DINE_IN' | 'TAKEAWAY' | 'DELIVERY';
  channel: 'POS' | 'WAITER' | 'QR' | 'WEB' | 'TELEGRAM';
  roomKind?: string | null;
  waiter: boolean;
}): Zone {
  if (input.channel === 'QR') return 'QR';
  if (input.channel === 'TELEGRAM' || input.channel === 'WEB')
    return input.type === 'DELIVERY' ? 'DELIVERY' : 'ONLINE';
  if (input.type === 'DELIVERY') return 'DELIVERY';
  if (input.type === 'TAKEAWAY') return 'COUNTER';
  if (input.roomKind === 'VIP') return 'VIP';
  if (input.roomKind === 'BAR') return 'BAR';
  return input.waiter || input.roomKind ? 'HALL' : 'COUNTER';
}

/** Where an order came from, for the zone's source rule. */
export function sourcesOf(input: {
  type: 'DINE_IN' | 'TAKEAWAY' | 'DELIVERY';
  channel: 'POS' | 'WAITER' | 'QR' | 'WEB' | 'TELEGRAM';
  waiter: boolean;
}): Source[] {
  if (input.channel === 'QR') return ['QR'];
  if (input.channel === 'TELEGRAM') return ['TELEGRAM'];
  if (input.channel === 'WEB') return ['WEBSITE'];
  if (input.waiter || input.channel === 'WAITER') return ['WAITER'];
  // A cashier taking a delivery order acts as the delivery operator.
  return input.type === 'DELIVERY' ? ['OPERATOR', 'CASHIER'] : ['CASHIER'];
}

/** The flow an order follows, or null: no workflow (existing behaviour). */
export function orderWorkflow(
  active: ActiveWorkflow | null,
  zone: Zone,
): OrderWorkflow | null {
  if (!active?.config.enabled) return null;
  const zoneFlow = active.config.zones[zone];
  return zoneFlow ? { ...zoneFlow, zone, version: active.version } : null;
}

export function readOrderWorkflow(value: unknown): OrderWorkflow | null {
  if (!value || typeof value !== 'object') return null;
  const parsed = zoneFlowSchema
    .extend({ zone: z.enum(ZONES), version: z.number().int() })
    .safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Money that must be in before the kitchen gets the order (0: none). */
export function requiredBeforeKitchen(flowValue: OrderWorkflow, total: number) {
  if (flowValue.payment === 'PREPAY') return total;
  if (flowValue.payment === 'ADVANCE')
    return Math.ceil((total * flowValue.advancePercent) / 100);
  return 0;
}

/** Status for an order sent to the kitchen under its zone's approval rule. */
export function approvalStatus(
  flowValue: OrderWorkflow,
  permissions: Set<string>,
): 'PLACED' | 'PENDING' {
  switch (flowValue.approval) {
    case 'AUTO':
      return 'PLACED';
    case 'CASHIER':
      return permissions.has('payments.accept') ? 'PLACED' : 'PENDING';
    case 'ADMIN':
      return permissions.has('settings.manage') ? 'PLACED' : 'PENDING';
    case 'WAITER':
      // Staff placing the order themselves already are the approval.
      return permissions.has('orders.create') ? 'PLACED' : 'PENDING';
  }
}

/** Who may approve a waiting order of this flow. */
export function canApprove(
  flowValue: OrderWorkflow | null,
  permissions: Set<string>,
): boolean {
  if (permissions.has('settings.manage')) return true;
  if (!flowValue) return permissions.has('orders.approve');
  switch (flowValue.approval) {
    case 'ADMIN':
      return false;
    case 'WAITER':
      return permissions.has('orders.create') || permissions.has('orders.approve');
    case 'CASHIER':
      // The cashier: whoever takes payments (as before workflows).
      return permissions.has('payments.accept');
    default:
      return permissions.has('orders.approve');
  }
}

const SOURCE_LABEL: Record<Source, string> = {
  CASHIER: 'Kassa',
  WAITER: 'Ofitsiant',
  QR: 'QR',
  TELEGRAM: 'Telegram',
  WEBSITE: 'Sayt',
  OPERATOR: 'Operator',
};
const APPROVAL_LABEL: Record<Approval, string | null> = {
  AUTO: null,
  CASHIER: 'Kassir tasdig‘i',
  WAITER: 'Ofitsiant tasdig‘i',
  ADMIN: 'Admin tasdig‘i',
};
export const ZONE_LABEL: Record<Zone, string> = {
  HALL: 'Zal',
  COUNTER: 'Fast food kassa',
  VIP: 'VIP xonalar',
  BAR: 'Bar',
  DELIVERY: 'Yetkazib berish',
  QR: 'QR stollar',
  ONLINE: 'Onlayn (Telegram / sayt)',
};

/** Step-by-step order route of a zone, for the preview. */
export function describeZone(flowValue: ZoneFlow): string[] {
  const steps = [flowValue.sources.map((source) => SOURCE_LABEL[source]).join(' / ')];
  if (flowValue.payment === 'PREPAY') steps.push('To‘lov');
  if (flowValue.payment === 'ADVANCE') steps.push(`Avans ${flowValue.advancePercent}%`);
  const approval = APPROVAL_LABEL[flowValue.approval];
  if (approval) steps.push(approval);
  steps.push(flowValue.kitchenConfirm ? 'Oshxona (qabul qiladi)' : 'Oshxona');
  if (flowValue.queueTv) steps.push('Navbat TV');
  if (flowValue.deliveryConfirm) steps.push('Kuryer (kod bilan)');
  if (flowValue.payment === 'POSTPAY' || flowValue.payment === 'MIXED' || flowValue.payment === 'PARTIAL')
    steps.push('Kassa (to‘lov)');
  if (flowValue.payment === 'ADVANCE') steps.push('Qolgan to‘lov');
  if (flowValue.payment === 'CREDIT') steps.push('Qarz hisobi');
  return steps;
}

export type WorkflowIssue = { level: 'error' | 'warning'; zone?: Zone; text: string };

/** What the restaurant reported about itself, used to check a configuration. */
export type RestaurantFacts = {
  capabilities: string[];
  stations?: { id: string; name: string }[];
  printers?: { kitchen: number; receipt: number };
  staff?: { cashier: number; waiter: number; kitchen: number };
  tv?: number;
};

/** Settings check, conflicts and compatibility before activation. */
export function validateWorkflow(
  config: WorkflowConfig,
  facts: RestaurantFacts | null,
): WorkflowIssue[] {
  const issues: WorkflowIssue[] = [];
  const zoneKeys = Object.keys(config.zones) as Zone[];
  if (config.enabled && zoneKeys.length === 0)
    issues.push({ level: 'error', text: 'Hech bir zona uchun oqim belgilanmagan.' });
  if (!facts?.capabilities.includes('workflow'))
    issues.push({
      level: 'warning',
      text: 'Restoran serveri ish rejimlarini hali qo‘llay olmaydi (eski versiya yoki aloqa yo‘q). Rejim saqlanadi va server yangilangach qo‘llanadi; ungacha restoran avvalgidek ishlaydi.',
    });
  for (const zone of zoneKeys) {
    const value = config.zones[zone]!;
    if (value.payment === 'PREPAY' && !value.sources.some((s) => s === 'CASHIER' || s === 'OPERATOR'))
      issues.push({ level: 'error', zone, text: 'Oldindan to‘lov tanlangan, lekin bu zonada to‘lov oladigan kassa manbasi yo‘q.' });
    if (value.sources.includes('QR') && value.approval === 'AUTO')
      issues.push({ level: 'warning', zone, text: 'QR buyurtmalar tasdiqsiz oshxonaga ketadi (soxta buyurtma xavfi).' });
    if (value.payment === 'CREDIT' && !facts?.capabilities.includes('credit'))
      issues.push({ level: 'warning', zone, text: 'Qarz (nasiya) hisobi bu restoran serverida hali yo‘q: to‘lov kassada odatdagidek olinadi.' });
    if (value.queueTv && facts?.tv === 0)
      issues.push({ level: 'warning', zone, text: 'Navbat TV yoqilgan, lekin restoranda TV ulanmagan.' });
    if (value.stationId && facts?.stations && !facts.stations.some((s) => s.id === value.stationId))
      issues.push({ level: 'error', zone, text: 'Biriktirilgan oshxona bo‘limi restoranda topilmadi.' });
    if (value.approval === 'WAITER' && facts?.staff && facts.staff.waiter === 0)
      issues.push({ level: 'error', zone, text: 'Ofitsiant tasdig‘i tanlangan, lekin restoranda ofitsiant yo‘q.' });
    if ((value.approval === 'CASHIER' || value.payment === 'PREPAY') && facts?.staff && facts.staff.cashier === 0)
      issues.push({ level: 'error', zone, text: 'Kassir kerak, lekin restoranda kassir yo‘q.' });
    if (value.sources.includes('WAITER') && facts?.staff && facts.staff.waiter === 0)
      issues.push({ level: 'warning', zone, text: 'Manba “Ofitsiant”, lekin restoranda ofitsiant yo‘q.' });
    if (facts?.printers && facts.printers.kitchen === 0 && value.kitchenPrint === 'AFTER_PAYMENT')
      issues.push({ level: 'warning', zone, text: 'Oshxona printeri yo‘q: oshxona faqat ekrandan ko‘radi.' });
  }
  return issues;
}
