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
} as const;

export type Permission = keyof typeof permissionCatalog;
export const allPermissions = Object.keys(permissionCatalog) as Permission[];

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
      'shifts.manage',
      'customers.view',
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
    ],
  },
  kitchen: {
    name: 'Oshxona xodimi',
    description: 'Taomlarni tayyorlash',
    // No orders.view: kitchen screens never receive prices or totals.
    permissions: ['kitchen.access'],
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
    ],
  },
};
