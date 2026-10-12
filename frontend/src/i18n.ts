import { uz as uzCatalog } from './locales/uz';

// Extend the locale union and add complete catalogs when translations are approved.
export type SupportedLocale = 'uz';
export const defaultLocale: SupportedLocale = 'uz';
const uz = {
  brand: 'FAST FOOD',
  product: 'Restoran boshqaruv tizimi',
  statusLabel: 'Tizim holati',
  eyebrow: 'Barchasi ishonchli ulanishdan boshlanadi',
  title: 'Yangi ish kuniga',
  titleAccent: 'mustahkam poydevor.',
  description: 'Xizmatga ulanish holatini shu yerda tekshirishingiz mumkin.',
  loading: 'Ulanish tekshirilmoqda…',
  ready: 'Ulanish tayyor',
  unavailable: 'Ulanish vaqtincha mavjud emas',
  offline: 'Xizmat bilan bog‘lanib bo‘lmadi',
  readyDescription:
    'Xizmat bilan aloqa o‘rnatildi. Ma’lumotlar ulanishi ishlayapti.',
  unavailableDescription:
    'Xizmat hozircha tayyor emas. Birozdan keyin qayta tekshiring.',
  offlineDescription: 'Internet aloqasini tekshiring va qayta urinib ko‘ring.',
  loadingDescription: 'Iltimos, bir oz kuting.',
  retry: 'Qayta tekshirish',
  checkedAt: 'Oxirgi tekshiruv',
  phase: 'Boshlang‘ich sozlash',
  phaseDescription: 'Restoran funksiyalari bosqichma-bosqich qo‘shiladi.',
  lightTheme: 'Yorug‘ ko‘rinish',
  darkTheme: 'Tungi ko‘rinish',
  footer: 'Restoraningiz uchun yagona ish muhiti.',
} as const;
const catalogs = { uz };
export const text = catalogs[defaultLocale];

// Application catalog (see locales/). Future locales must satisfy the same shape.
type Widen<T> = { [K in keyof T]: T[K] extends string ? string : Widen<T[K]> };
export type Catalog = Widen<typeof uzCatalog>;
const appCatalogs: Record<SupportedLocale, Catalog> = { uz: uzCatalog };
export const t = appCatalogs[defaultLocale];
