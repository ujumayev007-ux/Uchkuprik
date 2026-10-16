# Android ofitsiant ilovasi — qurilmada sinov ro‘yxati

Bu ilovaning bildirishnoma xizmati (AlertService) hali **haqiqiy qurilmada sinalmagan**:
rivojlantirish kompyuterida planshet ham, emulyator ham yo‘q. Quyidagi ro‘yxatni birinchi
planshetda bajaring va natijani belgilang. Hamma qadam o‘tmaguncha ilovani «tayyor» deb
hisoblamang.

Tayyorgarlik: restoran kompyuterida FastFood ishlayotgan bo‘lsin, planshet shu Wi‑Fi
tarmog‘ida, Kassir va Ofitsiant foydalanuvchilari mavjud, Owner'da «Ofitsiant
bildirishnomasi» yoqilgan.

| №   | Sinov                                                                                         | Kutilgan natija                                                                                                               | Natija |
| --- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------ |
| 1   | APK ni o‘rnating, manzilni kiriting, Ofitsiant sifatida kiring                                | Ekranda «Ovozli xabarni yoqish» chiqadi                                                                                       | ☐      |
| 2   | Tugmani bosing, bildirishnoma ruxsatiga «Ruxsat» bering                                       | Tugma yo‘qoladi; tepada «FastFood: mijoz xabarlari yoqilgan» doimiy xabari ko‘rinadi                                          | ☐      |
| 3   | Kassadan «Mijoz» buyurtmasini yarating (stolsiz)                                              | Planshet signal beradi, «Yangi mijoz buyurtmasi. Stolni belgilang.» deydi, bildirishnomada №raqam va «Stol belgilash» chiqadi | ☐      |
| 4   | Bildirishnomadagi «Stol belgilash» ni bosing                                                  | Ilova ochiladi, stol tanlash oynasi chiqadi                                                                                   | ☐      |
| 5   | Stolni tanlang                                                                                | Bildirishnoma yo‘qoladi; kassa ekranida buyurtma shu stol bilan ko‘rinadi                                                     | ☐      |
| 6   | **Ekranni o‘chiring** (quvvat tugmasi), 1 daqiqa kuting, kassadan yangi «Mijoz» yarating      | Ekran o‘chiq holatda ham signal va ovoz eshitiladi, bildirishnoma chiqadi                                                     | ☐      |
| 7   | Ilovani ro‘yxatdan o‘chirib yuboring (swipe), yangi «Mijoz» yarating                          | Xabar baribir keladi (xizmat ishlashda davom etadi)                                                                           | ☐      |
| 8   | **Planshetni qayta yoqing** (restart), ilovani ochmay 2 daqiqa kuting, yangi «Mijoz» yarating | Xabar keladi (BootReceiver xizmatni qayta ishga tushiradi). Kelmasa, ilovani bir marta oching va yana sinang                  | ☐      |
| 9   | Wi‑Fi'ni 30 soniyaga o‘chirib-yoqing; shu vaqtda kassadan «Mijoz» yarating                    | Wi‑Fi qaytgach xabar keladi (bir marta); oldingi xabarlar takrorlanmaydi                                                      | ☐      |
| 10  | Bildirishnoma ruxsatini Android sozlamalaridan o‘chiring                                      | Ilovada «Ovozli xabarni yoqish» yana chiqadi; ovoz baribir eshitiladi                                                         | ☐      |
| 11  | Owner'da ovoz balandligi 30%, takrorlash 3 qo‘ying, 1 daqiqa kuting, yangi «Mijoz» yarating   | Ovoz pastroq va 3 marta aytiladi                                                                                              | ☐      |
| 12  | Owner'da Ofitsiant roli uchun bildirishnomani o‘chiring, 1 daqiqa kuting                      | Doimiy xabar yo‘qoladi, yangi «Mijoz» uchun xabar kelmaydi                                                                    | ☐      |
| 13  | Planshetda o‘zbek ovozi bo‘lmasa (Sozlamalar → Til → Matnni ovozga)                           | Turk ovozi o‘qiydi yoki faqat signal; xato oynasi chiqmasligi kerak                                                           | ☐      |
| 14  | Chiqish (logout) tugmasini bosing, 1 daqiqa kuting, yangi «Mijoz» yarating                    | Xabar kelmaydi; doimiy xabar o‘chadi                                                                                          | ☐      |

Eslatma: ba'zi telefonlar (Xiaomi, Huawei, Samsung) fondagi ilovalarni tez o‘chiradi.
6‑ va 7‑sinov o‘tmasa: Sozlamalar → Ilovalar → FastFood → Batareya → «Cheklovsiz» qiling
va «Avtomatik ishga tushirish» (Autostart) ruxsatini bering.

## Kompyuterda avtomatik tekshirilganlar

Quyidagilar kompyuterda tekshirildi (qurilmasiz): xabarlar oqimining serveri
(`/api/live/alerts`), unda xabarni o‘qish va takroriy ulanishda bir buyurtmani ikki marta
e’lon qilmaslik mantig‘i (`SseReader` va `SeenOrders` sinflari oddiy Java'da `android/test`
orqali ishga tushirildi). Android'ning o‘zi (TTS, bildirishnoma, xizmat, qayta yoqish)
**tekshirilmagan**.
