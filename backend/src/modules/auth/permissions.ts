// Permission catalog. Keys are stable identifiers stored on roles; labels are Uzbek UI text.
// New modules add keys here; removing a key requires a data migration for existing roles.
export const permissionCatalog = {
  'branches.view': 'Filiallarni ko‘rish',
  'branches.manage': 'Filiallarni boshqarish',
  'users.view': 'Xodimlarni ko‘rish',
  'users.manage': 'Xodimlarni boshqarish',
  'roles.manage': 'Rollar va ruxsatlarni boshqarish',
  'devices.manage': 'Qurilmalarni ro‘yxatdan o‘tkazish',
  'audit.view': 'Audit jurnalini ko‘rish',
  'settings.manage': 'Restoran sozlamalarini boshqarish',
  'menu.view': 'Menyuni ko‘rish',
  'menu.manage': 'Menyuni boshqarish',
  'menu.cost.view': 'Tannarxni ko‘rish',
  'tables.manage': 'Zallar va stollarni boshqarish',
  'pos.access': 'Kassa oynasidan foydalanish',
  'orders.view': 'Buyurtmalarni ko‘rish',
  'orders.create': 'Buyurtma yaratish',
  'orders.edit': 'Buyurtmani tahrirlash',
  'orders.cancel': 'Buyurtmani bekor qilish',
  'orders.approve': 'Onlayn buyurtmani tasdiqlash',
  'discounts.apply': 'Chegirma qo‘llash',
  'payments.accept': 'To‘lov qabul qilish',
  'payments.refund': 'Pulni qaytarish',
  'shifts.manage': 'Kassa smenasini ochish va yopish',
  'reports.view': 'Hisobotlarni ko‘rish',
  'finance.view': 'Moliyaviy ma’lumotlarni ko‘rish',
  'kitchen.access': 'Oshxona ekranidan foydalanish',
  'kitchen.reject': 'Oshxonada buyurtmani rad etish',
  'inventory.view': 'Omborni ko‘rish',
  'inventory.manage': 'Ombor harakatlarini boshqarish',
  'purchasing.manage': 'Xaridlarni boshqarish',
  'delivery.manage': 'Yetkazib berishni boshqarish',
  'delivery.courier': 'Kuryer vazifalarini bajarish',
  'customers.view': 'Mijozlarni ko‘rish',
  'customers.manage': 'Mijozlarni boshqarish',
  'hr.manage': 'Ish vaqti va maoshni boshqarish',
  'finance.manage': 'Xarajatlar va moliyaviy davrlarni boshqarish',
  'notifications.manage': 'Bildirishnomalarni sozlash',
  'operations.manage': 'Operatsion nazoratni boshqarish',
  'operations.perform': 'Cheklist, harorat va vazifalarni bajarish',
  'assets.manage': 'Uskunalar va ta’mirni boshqarish',
  'training.manage': 'O‘qitish va sertifikatlarni boshqarish',
  'approvals.decide': 'So‘rovlarni tasdiqlash',
  'developer.manage': 'API kalitlari va webhooklarni boshqarish',
  'brands.manage': 'Brendlarni boshqarish',
  'franchise.manage': 'Franshiza va shartnomalarni boshqarish',
  'franchise.portal': 'Franchayzi portaliga kirish',
} as const;

export type Permission = keyof typeof permissionCatalog;
export const allPermissions = Object.keys(permissionCatalog) as Permission[];

/**
 * Permissions the vendor (SUPER_OWNER) switched off for this whole install through
 * the licence. They are removed from every user, owners included.
 */
let denied = new Set<string>();
export function setDeniedPermissions(keys: unknown) {
  denied = new Set(
    Array.isArray(keys) ? keys.filter((key) => typeof key === 'string') : [],
  );
}
export function isDenied(key: string) {
  return denied.has(key);
}
export function deniedPermissions() {
  return [...denied];
}

export function isPermission(value: string): value is Permission {
  return Object.hasOwn(permissionCatalog, value);
}

// Roles whose holders count as privileged for MFA policy and step-up checks.
export const privilegedPermissions: Permission[] = [
  'users.manage',
  'roles.manage',
  'devices.manage',
  'settings.manage',
  'finance.view',
  'payments.refund',
];

type SystemRole = {
  name: string;
  description: string;
  permissions: Permission[];
};

// Seeded per tenant. Owners keep every permission; others start least-privileged
// and can be customized by the owner.
export const systemRoles: Record<string, SystemRole> = {
  owner: {
    name: 'Egasi',
    description: 'Biznesning to‘liq boshqaruvi',
    permissions: allPermissions,
  },
  admin: {
    name: 'Administrator',
    description: 'Restoran ishini boshqarish',
    permissions: allPermissions.filter(
      (key) => !['roles.manage', 'finance.view'].includes(key),
    ),
  },
  cashier: {
    name: 'Kassir',
    description: 'Kassa va to‘lovlar',
    permissions: [
      'pos.access',
      'menu.view',
      'orders.view',
      'orders.create',
      'orders.edit',
      'orders.approve',
      'payments.accept',
      // Cashiers create and dispatch delivery orders ("Dostavka").
      'delivery.manage',
      'shifts.manage',
      'customers.view',
      'operations.perform',
    ],
  },
  waiter: {
    name: 'Ofitsiant',
    description: 'Stollar va buyurtmalar',
    permissions: [
      'menu.view',
      'orders.view',
      'orders.create',
      'orders.edit',
      'orders.approve',
      'operations.perform',
    ],
  },
  kitchen: {
    name: 'Oshxona xodimi',
    description: 'Taomlarni tayyorlash',
    // No orders.view: kitchen screens never receive prices or totals.
    permissions: ['kitchen.access', 'kitchen.reject', 'operations.perform'],
  },
  courier: {
    name: 'Kuryer',
    description: 'Buyurtmalarni yetkazib berish',
    permissions: ['delivery.courier'],
  },
  warehouse: {
    name: 'Omborchi',
    description: 'Ombor va xaridlar',
    permissions: [
      'inventory.view',
      'inventory.manage',
      'purchasing.manage',
      'menu.view',
      'operations.perform',
    ],
  },
  franchisee: {
    name: 'Franchayzi',
    description:
      'Franchayzi portali: o‘z filiallari, shartnoma va hisob-kitoblar',
    permissions: ['franchise.portal', 'reports.view', 'branches.view'],
  },
};
