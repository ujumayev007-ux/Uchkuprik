# Restoran ilovalari: qaysi fayl qayerga o‘rnatiladi

Bir restoranda bitta **server kompyuter** bo‘ladi: unda baza va hamma ma’lumot turadi. Qolgan
qurilmalar shu serverga Wi‑Fi yoki LAN orqali **o‘zi ulanadi** (manzil yozish shart emas).
Hamma ilova bitta serverga ulangani uchun buyurtmalar, to‘lovlar va oshxona holatlari darrov
hamma joyda bir xil ko‘rinadi.

| Fayl                                 | Qayerga                                    | Nima qiladi                                                                                |
| ------------------------------------ | ------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `FastFood-Setup-1.14.3.exe`          | **Server kompyuter** (odatda kassa)        | Server, baza, Kassa, Ofitsiant va Oshxona panellari. Litsenziya shu yerda kiritiladi.      |
| `FastFood-Admin-Setup-1.3.0.exe`     | Egasi/boshqaruvchi kompyuteri              | Boshqaruv paneli: xodimlar, menyu, printer, hisobot.                                       |
| `FastFood-Kassa-Setup-1.3.0.exe`     | Qo‘shimcha kassa kompyuterlari             | Faqat Kassa (sotuv, to‘lov, buyurtmalar). PIN bilan ochiladi.                              |
| `FastFood-Oshxona-Setup-1.3.0.exe`   | Oshxonadagi kompyuter/planshet             | Faqat Oshxona: buyurtmani qabul qilish, tayyorlash, tayyor deb belgilash, rad etish.       |
| `FastFood-Ofitsiant-Setup-1.3.0.exe` | Ofitsiant kompyuter/planshetlari (Windows) | Faqat Ofitsiant ekrani.                                                                    |
| `FastFood-1.13.0.apk`                | Ofitsiant telefonlari (Android)            | Ofitsiant ekrani va yangi buyurtma xabarlari (avtomatik topish hozircha faqat Windows’da). |

## Birinchi ishga tushirish

1. Server kompyuterga `FastFood-Setup` ni o‘rnating, litsenziya kalitini kiriting, restoran
   egasi va xodimlarni yarating. Birinchi ishga tushganda Windows **bir marta ruxsat** so‘raydi
   («Avtomatik ulanish»): «Ruxsat berish» va keyin «Ha» ni bosing. Windows xavfsizlik devori
   o‘chirilmaydi: faqat FastFood dasturi uchun va faqat shu Wi‑Fi/LAN ichida ikkita tor qoida
   qo‘shiladi.
2. Boshqa kompyuterlarda kerakli ilovani o‘rnating va oching. U **serverni o‘zi qidiradi**.
   Bitta server topilsa darrov ulanadi; bir nechta bo‘lsa, ro‘yxatdan o‘zingiznikini tanlaysiz.
   Qayta qidirish uchun: menyu → **Avtomatik ulanish** (yoki pastdagi holat tugmasi).
3. Kirish: biznes kodi, login va parol (birinchi marta). Keyin **Admin → Qurilmalar** bo‘limida
   qurilmani ro‘yxatdan o‘tkazing: shundan keyin Kassa, Ofitsiant va Oshxona ilovalari
   to‘g‘ridan-to‘g‘ri **4 xonali PIN** oynasini ochadi.

## Ulanish holati

Har bir ilovaning sarlavhasida va menyusida holat ko‘rinadi: **Ulandi**, **Ulanmoqda**,
**Aloqa yo‘q**. Aloqa uzilsa pastda kichik tugma chiqadi. Wi‑Fi o‘chib yonsa yoki server
kompyuterning IP manzili o‘zgarsa, ilova serverni **o‘zi qayta topadi** (har 5 soniyada tekshiradi).
Qayta topilganda sahifa yangi manzilda ochiladi, PIN/parol qayta so‘ralishi mumkin.

Xavfsizlik: server o‘zining kaliti bilan imzolangan javob beradi; ilova bir marta ulangach faqat
**shu serverni** qabul qiladi (boshqa kompyuter o‘zini server qilib ko‘rsata olmaydi). Topish
javobida parol, narx yoki mijoz ma’lumoti yo‘q. Kirish baribir login/PIN va qurilma ro‘yxati
orqali bo‘ladi. Server tomonda **Avtomatik ulanish** menyusi xavfsizlik kodini ko‘rsatadi
(masalan `02B1-E6AF-DB2A`): ulanishda ilova ham shu kodni ko‘rsatadi.

## Oshxona ilovasi

- Yangi buyurtma Kassa yoki Ofitsiantdan **o‘zi** keladi, ovoz chaladi va «Yangi» bo‘limida turadi.
  Qabul qilinmagan buyurtma har 20 soniyada ovoz bilan eslatadi.
- Chiptada buyurtma raqami, stol, taomlar, miqdor, izohlar va buyurtma vaqti bor.
- Har bir buyurtmada 4 tugma: **Qabul qilish**, **Tayyorlanmoqda**, **Tayyor**, **Rad etish**.
  Oshpaz avval «Qabul qilish» ni bosishi **shart**: shundan keyingina «Tayyorlanmoqda»/«Tayyor»
  ishlaydi. Ikki oshxona ekranida bir vaqtda bosilsa ham qabul bir marta yoziladi.
- «Rad etish» alohida ruxsat bilan (`kitchen.reject`, «Oshxonada buyurtmani rad etish»), sabab
  yoziladi. Rad etilgan buyurtma **yo‘qolmaydi**: kassir va ofitsiantda «Oshxona rad etdi: sabab»
  belgisi chiqadi, mijoz TV’sidagi navbatdan olinadi, kassir uni qayta yuborishi yoki bekor qilishi mumkin.
- Holat o‘zgarganda Kassa, Ofitsiant, Admin va mijoz TV’si darrov yangilanadi; ofitsiant va
  kassirga ovozli xabar beriladi («…-raqamli buyurtmani oshxona qabul qildi / rad etdi / tayyor»).
- Eski bazalar va buyurtmalar saqlanadi: yangi imkoniyat uchun faqat bo‘sh ustunlar qo‘shiladi.
  Mavjud «Oshxona» rolida «Rad etish» ruxsati o‘zi qo‘shilmaydi: **Admin → Rollar** da bering.

## Eslatmalar

- Ruxsatlar va cheklovlar (qaysi tugma, qaysi ekran, nechta xodim) Owner tomonidan serverda
  belgilanadi; ilova ularni faqat ko‘rsatadi.
- Barcha ilovalar raqamli imzosiz: Windows «Noma’lum nashriyotchi» desa «Baribir ishga tushirish»
  ni bosing; antivirus o‘chirib yuborsa, papkani ishonchli ro‘yxatga qo‘shing.
- Server o‘rniga ro‘yxat bo‘sh chiqsa: server kompyuter yoqilganini, FastFood ishlayotganini,
  bir xil Wi‑Fi’da ekanini va serverda **FastFood → Avtomatik ulanish** da «Tarmoq ruxsati:
  berilgan» ekanini tekshiring. Ba’zi Wi‑Fi’larda («mehmon» tarmog‘i) qurilmalar bir-birini
  ko‘rmaydi: bunday tarmoqda avtomatik ulanish ishlamaydi.
- Qo‘lda manzil kiritish ham saqlangan («Qo‘lda manzil kiritish» bo‘limi), masalan
  `https://restoran.misol.uz` kabi internet manzillari uchun.
