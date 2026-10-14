// Keys form the localization boundary; add reviewed ru/en catalogs in a later increment.
export const messages = {
  live: 'Xizmat ishlayapti.',
  ready: 'Tizim ulanishi tayyor.',
  unavailable:
    'Tizimga ulanish vaqtincha mavjud emas. Keyinroq qayta urinib ko‘ring.',
  notFound: 'So‘ralgan manzil topilmadi.',
  forbiddenOrigin: 'Ushbu manbadan ulanishga ruxsat berilmagan.',
  rateLimited:
    'So‘rovlar soni oshib ketdi. Birozdan keyin qayta urinib ko‘ring.',
  internal: 'Kutilmagan xatolik yuz berdi. Qayta urinib ko‘ring.',
  validation: 'Kiritilgan ma’lumotlarni tekshiring.',
  invalidCredentials: 'Login yoki parol noto‘g‘ri.',
  invalidPin: 'PIN-kod noto‘g‘ri.',
  accountLocked:
    'Juda ko‘p noto‘g‘ri urinish. Hisob vaqtincha bloklandi, keyinroq urinib ko‘ring.',
  unauthenticated: 'Iltimos, tizimga kiring.',
  forbidden: 'Bu amal uchun ruxsatingiz yo‘q.',
  mfaRequired: 'Ikki bosqichli tasdiqlash kodi talab qilinadi.',
  mfaSetupRequired: 'Davom etish uchun ikki bosqichli himoyani yoqing.',
  mfaInvalid: 'Tasdiqlash kodi noto‘g‘ri yoki eskirgan.',
  reauthRequired: 'Bu amal uchun parolingizni qayta kiriting.',
  passwordChangeRequired: 'Davom etish uchun parolingizni almashtiring.',
  tenantSuspended:
    'Biznes hisobi to‘xtatilgan. Qo‘llab-quvvatlash xizmatiga murojaat qiling.',
  deviceRequired: 'Bu amal faqat ro‘yxatdan o‘tgan qurilmada bajariladi.',
  conflict: 'Bunday yozuv allaqachon mavjud.',
  weakPassword:
    'Parol kamida 10 ta belgidan iborat bo‘lishi va harf hamda raqamni o‘z ichiga olishi kerak.',
  lastOwner: 'Kamida bitta faol biznes egasi qolishi kerak.',
  branchRequired: 'Avval filialni tanlang.',
  categoryCycle: 'Kategoriya o‘zining ichki kategoriyasiga joylashtirilmaydi.',
  variantRequired:
    'Mahsulotda kamida bitta faol o‘lcham yoki variant bo‘lishi kerak.',
  inUse: 'Bu yozuv ishlatilmoqda va o‘chirib bo‘lmaydi.',
  invalidTransition: 'Buyurtma holatini bunday o‘zgartirib bo‘lmaydi.',
  itemUnavailable: 'Tanlangan taom hozir mavjud emas.',
  invalidModifiers: 'Qo‘shimchalar to‘g‘ri tanlanmagan.',
  overpaid:
    'Bu o‘zgarishdan keyin to‘langan summa buyurtma summasidan oshib ketadi. Avval pulni qaytaring.',
  shiftRequired: 'To‘lov qabul qilish uchun kassa smenasini oching.',
  shiftAlreadyOpen: 'Bu kassada smena allaqachon ochiq.',
  amountExceedsDue: 'To‘lov summasi qolgan qarzdan oshmasligi kerak.',
  insufficientCash: 'Berilgan naqd pul to‘lov summasidan kam.',
  notFullyPaid: 'Buyurtma to‘liq to‘lanmagan.',
  refundExceedsPayment: 'Qaytarish summasi to‘lov summasidan oshmasligi kerak.',
  paidOrderCancel:
    'To‘langan buyurtmani bekor qilishdan oldin pulni qaytaring.',
  providerNotConfigured: 'Bu to‘lov usuli hali ulanmagan.',
  orderClosed: 'Yopilgan buyurtmani o‘zgartirib bo‘lmaydi.',
  insufficientStock: 'Omborda mahsulot yetarli emas.',
  unknownUnit: 'O‘lchov birligi noto‘g‘ri.',
  purchaseClosed: 'Bu xarid allaqachon qabul qilingan yoki bekor qilingan.',
  sameWarehouse: 'Bir xil omborga ko‘chirib bo‘lmaydi.',
  insufficientPoints: 'Mijozda yetarli ball yo‘q.',
  customerRequired: 'Avval buyurtmaga mijozni biriktiring.',
  couponInvalid: 'Promokod yaroqsiz yoki muddati tugagan.',
  couponExhausted: 'Promokoddan foydalanish limiti tugagan.',
  couponMinOrder: 'Promokod uchun buyurtma summasi yetarli emas.',
  feedbackExists: 'Bu buyurtma uchun fikr allaqachon qoldirilgan.',
  zoneMinOrder: 'Bu hudud uchun buyurtma summasi yetarli emas.',
  orderNotReady: 'Buyurtma hali tayyor emas.',
  consentRequired: 'Avval joylashuvni ulashishga rozilik bering.',
  periodClosed: 'Bu oy moliyaviy jihatdan yopilgan. O‘zgartirib bo‘lmaydi.',
  alreadyClockedIn: 'Siz allaqachon ishga kelganingizni belgilagansiz.',
  notClockedIn: 'Avval ishga kelganingizni belgilang.',
  payrollLocked: 'Ish haqi davri tasdiqlangan, o‘zgartirib bo‘lmaydi.',
  featureNotInPlan:
    'Bu imkoniyat joriy tarifingizga kirmaydi. Tarifni yangilang.',
  planLimitReached:
    'Tarif limitiga yetildi. Ko‘proq qo‘shish uchun tarifni yangilang.',
  planUsageExceeds: 'Joriy foydalanish tanlangan tarif limitlaridan oshadi.',
  signupDisabled: 'Ro‘yxatdan o‘tish vaqtincha yopiq.',
  confirmMismatch: 'Tasdiqlash matni mos kelmadi.',
  branchFranchised: 'Filial allaqachon boshqa franchayziga biriktirilgan.',
  contractLocked: 'Faol yoki bekor qilingan shartnomani o‘zgartirib bo‘lmaydi.',
  territoryConflict: 'Bu hudud boshqa faol eksklyuziv shartnoma bilan band.',
  evidenceInvalid:
    'Rasm JPEG, PNG yoki WebP formatida va 2 MB dan oshmasligi kerak.',
  checklistClosed: 'Bu cheklist allaqachon yakunlangan.',
  checklistIncomplete:
    'Barcha bandlarni bajaring va kerakli rasmlarni yuklang.',
  selfApproval: 'O‘zingiz bajargan ishni o‘zingiz tasdiqlay olmaysiz.',
  capaRequired: 'Sabab va tuzatuvchi chorani kiriting.',
  incidentNotResolved:
    'Hodisani yopishdan oldin uni hal qilingan deb belgilang.',
  photoRequired: 'Bu vazifa uchun rasm talab qilinadi.',
  batchStatusInvalid: 'Partiya holatini bunday o‘zgartirib bo‘lmaydi.',
  telegramTokenInvalid: 'Telegram bot tokeni noto‘g‘ri yoki bot topilmadi.',
  apiKeyRequired: 'API kaliti talab qilinadi.',
  apiKeyInvalid: 'API kaliti noto‘g‘ri yoki bekor qilingan.',
  apiScopeMissing: 'API kalitida bu amal uchun ruxsat yo‘q.',
  webhookUrlInvalid: 'Webhook manzili ochiq HTTPS manzil bo‘lishi kerak.',
  licenseExpired:
    'Litsenziya muddati tugagan. Dastur egasi yangi kalit kiritishi kerak.',
  licenseBlocked:
    'Dastur sotuvchi tomonidan vaqtincha bloklangan. Iltimos, sotuvchiga murojaat qiling.',
  licenseInvalid:
    'Litsenziya kaliti noto‘g‘ri yoki boshqa kompyuter uchun berilgan.',
  approvalRequired: 'Bu xarajat uchun tasdiq kerak. So‘rov yuborildi.',
  monthNotFinished: 'Oy hali tugamagan. Hisobni oy tugagach chiqaring.',
  handoffRequired:
    'Buyurtmani olish uchun kassirga topshirish kodini ko‘rsating.',
  cashMismatch: 'Summa kuryer yig‘gan pulga mos emas.',
  deliveryOutOfRange: 'Manzil yetkazib berish masofasidan tashqarida.',
  codeMissing: 'Bu buyurtma uchun faol kod yo‘q. Yangi kod yarating.',
  codeExpired: 'Kodning muddati tugagan. Yangi kod yarating.',
  codeLocked:
    'Juda ko‘p noto‘g‘ri urinish. Kod bloklandi — yangi kod yarating.',
  codeInvalid: 'Kod noto‘g‘ri.',
  itemInPreparation:
    'Bu taom oshxonada tayyorlanmoqda. Avval uni bekor qilishni so‘rang — oshpaz tasdiqlaydi.',
} as const;

export type MessageKey = keyof typeof messages;
