# FastFood 1.2.0 → Server 1.14.7: xavfsiz o‘tish tekshiruvi (2026-10-21)

Bu hujjat mijozga o‘tishdan oldingi tekshiruv natijasi. Mijozning ishlayotgan o‘rnatishiga, bu kompyuterdagi ishchi serverga, Render'ga va `main` tarmog‘iga **tegilmadi**.

## 1. Qisqa xulosa

- **Migratsiya xavfsiz:** 1.2.0 zaxirasi ustida 1.14.7 ishga tushirilganda 27 ta migratsiya (hammasi qo‘shimcha: yangi ustun/jadval) qo‘llandi, **494 ta mavjud qatordan birortasi yo‘qolmadi yoki o‘zgarmadi**. Taxminan 5 soniya (70 MB baza).
- **Moslik:** 6396 ta eski qiymat (menyu, narxlar, buyurtmalar, to‘lovlar, xodimlar, PIN, litsenziya, sozlamalar, davomat, oylik) 1.2.0 va 1.14.7 da bir xil API orqali solishtirildi: faqat 2 ta tushunarli farq.
- **Sinxronlash:** haqiqiy Kassa, Oshxona, Ofitsiant va TV ilovalari bilan migratsiya qilingan ma’lumotda 28/28, API darajasida ish kuni oqimi 31/31.
- **Qaytarish (rollback):** faqat **o‘tishdan oldin olingan to‘liq `FastFood-Data` nusxasi** bilan ishonchli. 1.2.0 ni migratsiya qilingan ma’lumot ustiga qo‘yish (saqlangan `secrets.json`siz) **ishlamaydi**.
- **Muhim shart:** o‘tishdan oldin **kassa smenasini yoping** (3-bo‘lim, E).

## 2. Nima bilan sinaldi (halol eslatma)

Mijozning haqiqiy zaxira nusxasi bu kompyuterda yo‘q edi. Shu sababli 1.2.0 o‘rnatuvchisidan (`Desktop\FastFood-1.2.0\FastFood-Setup-1.2.0.exe`) fayllar **o‘rnatmasdan** ochib olindi va **haqiqiy 1.2.0 kodi** (`main.cjs` git `64e5ebb` bilan bir xil; faqat ikkita port raqami almashtirilgan) alohida sinov papkasida ishga tushirildi. U o‘zi `initdb`, `secrets.json`, 25 migratsiya va ma’lumotlar bazasini yaratdi; keyin uning API si orqali realistik restoran kiritildi:

- 1 restoran, filial, 2 xona, 8 stol, 8 toifa (Kirill va emoji nomlar bilan), 18 mahsulot (variant, modifikator), chek va QR sozlamalari;
- 6 xodim (egasi, admin, 2 kassir, oshpaz, ofitsiant), PIN, 3 ro‘yxatdan o‘tgan qurilma (Kassa, Oshxona, Ofitsiant);
- 34 buyurtma (yakunlangan 29, bekor 1, qoralama 1, jarayonda 3: navbatda / tayyorlanmoqda / tayyor), to‘lovlar (naqd, karta, QR), kupon, mijozlar, ombor, ochiq smena, davomat, oylik davri;
- litsenziya: **sinov kaliti** bilan (haqiqiy sotuvchi kaliti ishlatilmadi).

Bu **haqiqiy mijoz ma’lumoti emas**. Mijozning haqiqiy zaxirasi kelganda xuddi shu tekshiruv `scripts/verify/migration/` vositalari bilan (README) takrorlanadi; uning ustida, eng avvalo, 4-bo‘lim A–B va 5-bo‘lim.

## 3. Natijalar va topilmalar

| №   | Tekshiruv                                                              | Natija                                                               |
| --- | ---------------------------------------------------------------------- | -------------------------------------------------------------------- |
| 1   | Zaxira nusxasi asl nusxa bilan (1809 fayl, 69 MB, SHA-256)             | bir xil; keyingi barcha sinovlardan keyin ham o‘zgarmagan            |
| 2   | Zaxira tiklanadimi (nusxada PostgreSQL ochilib, hamma jadval o‘qildi)  | ha: 94 jadval, 494 qator                                             |
| 3   | 1.14.7 ishga tushirildi (zaxira nusxasida)                             | 27 migratsiya, 36 yangi (bo‘sh) jadval, kodlash UTF8/C o‘zgarmadi    |
| 4   | Mavjud qatorlar                                                        | 494 tekshirildi: yo‘qolgan/o‘zgargan **0**                           |
| 5   | 1.14.7 ning o‘zi olgan avtomatik zaxira (`backups\…-before-1.14.7`)    | asl `pgdata` bilan bir xil (1804 fayl), lekin **maxfiy kalitlarsiz** |
| 6   | Eski kirish: egasi paroli, admin paroli                                | ishladi                                                              |
| 7   | Eski ro‘yxatdan o‘tgan qurilmalar + PIN (kassir, oshpaz, ofitsiant)    | ishladi; noto‘g‘ri PIN 401                                           |
| 8   | Litsenziya (sinov kaliti, installId)                                   | VALID, mijoz nomi/muddat/modul saqlangan                             |
| 9   | Menyu, narxlar, modifikatorlar, Kirill/emoji nomlar                    | bir xil                                                              |
| 10  | Buyurtmalar, to‘lovlar, kupon, mijozlar, smenalar, davomat, oylik      | bir xil                                                              |
| 11  | Hisobot eksporti eski ma’lumotdan (xlsx, docx, pdf)                    | ishladi                                                              |
| 12  | Yangi buyurtma raqami                                                  | davom etdi (34 → 35), takrorlanmadi                                  |
| 13  | Admin 2 bosqichli himoyasi (TOTP): 1.2.0 da yoqilgan, 1.14.7 da kirish | ishladi: eski kalit ochildi, noto‘g‘ri kod rad etildi                |

**A. Maxfiy kalitlar ko‘chirildi.** 1.2.0 kalitlarni oddiy `secrets.json` da saqlaydi. 1.14.x ularni Windows foydalanuvchisiga bog‘langan `secrets.enc` ga ko‘chiradi va **`secrets.json` ni o‘chiradi**. Ichki avtomatik zaxira esa faqat `pgdata` ni nusxalaydi (kalitlarsiz). Natija: o‘tishdan keyin 1.2.0 ni qaytarib o‘rnatsangiz u yangi tasodifiy kalit yaratadi va `password authentication failed for user "fastfood"` bilan ishga tushmaydi (1.8.0 hodisasi bilan bir xil).

**B. Eski qurilmalar.** 1.2.0 da ro‘yxatdan o‘tgan qurilmalarning turi `OTHER`; ularda barcha PIN xodimlar ko‘rinadi (cheklov yo‘q) va ishlaydi. Yangi ilovalar (Kassa/Oshxona/Ofitsiant) o‘zlarini yangi qurilma sifatida administrator bir marta ro‘yxatdan o‘tkazadi; unda faqat shu bo‘limga ruxsatli xodimlar ko‘rinadi.

**C. Chek eni.** `paperWidth: "80"` maydoni `widthMm: 80` ga almashdi (qiymat saqlangan).

**D. Oshxona «Qabul qilish».** 1.2.0 da boshlangan, hali tugamagan buyurtmalar 1.14.7 da «Qabul qilish» ni kutadi: qabul qilinmaguncha «Tayyorlanmoqda/Tayyor» bosilmaydi (409 `ACCEPT_REQUIRED`). Allaqachon «Tayyor» buyurtma qabul talab qilmaydi (ofitsiant topshiradi). TV navbati eski holatni to‘g‘ri ko‘rsatadi. Eski «Oshpaz» roli «Rad etish» ruxsatiga ega emas (Admin → Rollar da `kitchen.reject` yoqiladi); TV uchun `display` roli eski restoranlarda avtomatik yaratilmaydi (TV hisobi sifatida istalgan mavjud hisob yoki `queue.view` ruxsatli rol ishlaydi).

**E. Smena qurilmaga bog‘liq.** Kassa smenasi uni ochgan **kassa qurilmasi** (yoki qurilmasiz bo‘lsa — foydalanuvchi) bilan bog‘lanadi. Yangi Kassa ilovasi yangi qurilma bo‘lgani uchun eski ochiq smena unga ko‘rinmaydi: «Kassa smenasi yopiq — smenani oching» chiqadi va yangi smena ochiladi; eski smena ochiq qolib ketadi. Moliya ruxsati bor Admin uni API orqali yopa oladi (sinalgan), lekin Admin ekranida buning tugmasi yo‘q. **O‘tishdan oldin smenani yoping.**

**F. Hajm.** Avtomatik zaxira `pgdata` ning to‘liq nusxasi (oxirgi 5 ta saqlanadi): diskda baza hajmidan kamida bir necha baravar bo‘sh joy kerak.

## 4. Qaytarish (rollback) sinovlari

| Variant     | Qadamlar                                                                                                  | Natija                                                                                                               |
| ----------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 1 (tavsiya) | Dastur yopiladi → butun `FastFood-Data` o‘tishdan oldingi nusxadan tiklanadi → 1.2.0                      | **ishladi**, barcha qiymatlar asl bilan bir xil                                                                      |
| 2           | Ichki zaxira `backups\…-before-1.14.7` ni `pgdata` o‘rniga qo‘yish + **saqlangan** `secrets.json` + 1.2.0 | **ishladi** (6397 qiymat bir xil, farq faqat omborning lazy yaratiladigan id si)                                     |
| 3           | Migratsiya qilingan ma’lumot + saqlangan `secrets.json` + 1.2.0                                           | ishladi (6397 qiymat bir xil; migratsiyalar faqat qo‘shimcha); 1.14.7 da kiritilgan yangi ma’lumotni 1.2.0 ko‘rmaydi |
| 4           | Migratsiya qilingan ma’lumot ustiga 1.2.0, `secrets.json`siz                                              | **ishga tushmaydi** (`password authentication failed`)                                                               |

## 5. Mijozni o‘tkazish tartibi

1. **Kunni yoping:** barcha buyurtmalar yakunlansin yoki bekor qilinsin; **Kassa smenasini yoping**.
2. FastFood ni to‘liq yoping («Chiqish»), Windows'da `FastFood.exe` qolmaganini tekshiring.
3. **Butun `%APPDATA%\FastFood-Data` papkasini** (ichida `secrets.json`, `pgdata`, `backups`) tashqi diskka nusxalang va hajmini taqqoslang. Bu — yagona ishonchli qaytarish nuqtasi.
4. `FastFood-Setup-1.14.7.exe` ni o‘rnating (eski versiyani yangisining ustiga hech qachon o‘rnatmang). Birinchi ishga tushirish ~10–60 soniya: migratsiyalar.
5. «Avtomatik ulanish» uchun Windows ruxsatini bering (administrator so‘rovi: «Ruxsat berish»).
6. Tekshiring: egasi paroli bilan kirish, menyu va narxlar, xodimlar va PIN, litsenziya VALID.
7. Yangi ilovalar: har birini birinchi ochganda administrator parol bilan kiradi → «Bu ilovani sozlash» → filial va nom → keyin xodimlar PIN bilan. Oshpazlarga kerak bo‘lsa Admin → Rollar da «Oshxonada rad etish» ruxsatini bering.
8. Muammo bo‘lsa: 4-bo‘lim, 1-variant.

## 6. Owner ro‘yxatga olish bildirishnomalari — diagnostika

Zanjir **ishlaydi**: sinovda migratsiya qilingan eski o‘rnatish 15–40 soniyada markazga ro‘yxatdan o‘tdi (holat `PENDING`, «mahalliy litsenziya bor»), Owner uchun o‘qilmagan `registration.new` hodisasi yozildi. Shu bilan bog‘liq sabablar (ehtimoli bo‘yicha):

1. **Bildirishnoma kanali yo‘q.** Owner ilovasida hodisalar faqat «Hodisalar (N)» yorlig‘ida ko‘rinadi va u Owner konsolida kirgan va ochiq turgandagina har 30 soniyada yangilanadi. Windows bildirishnomasi, ovoz, vazifalar paneli belgisi, Telegram/e-pochta **yo‘q**. Ya’ni «o‘zi xabar bermaydi».
2. **Faqat bir marta.** Hodisa qurilma kaliti bo‘yicha bir marta yoziladi. O‘rnatish ilgari ro‘yxatdan o‘tgan bo‘lsa (masalan, 1.14.4 birinchi ishga tushganda), keyingi yangilanishlar yangi hodisa bermaydi; u eski, o‘qilmagan hodisa sifatida turadi.
3. **Birinchi urinish muvaffaqiyatsiz bo‘lsa, kechikish ~10 daqiqa.** Ro‘yxatga olish serverni ishga tushirgandan 15 soniyadan keyin, xato bo‘lsa har 10 daqiqada qayta uriniladi; so‘rov 15 soniyadan keyin to‘xtatiladi (Render uxlab yotgan bo‘lsa, ~30–60 soniya uyg‘onadi). Serverni 10 daqiqadan oldin yopsangiz ro‘yxatga olish bo‘lmaydi. O‘lchov (markaz birinchi urinishda yopiq edi): ro‘yxatga olish markaz ochilgandan 621 soniya (~10 daqiqa) keyin bo‘ldi.
4. **Jim xatolar (kod bo‘yicha, alohida sinalmagan).** Kompyuter soati 5 daqiqadan ortiq farq qilsa so‘rov rad etiladi (403), natija hech qayerga yozilmaydi va ko‘rsatilmaydi. Internet yo‘q/antivirus bloklasa ham ko‘rinmaydi.
5. **Yangi o‘rnatish emas.** Avtomatik 72 soatlik sinov faqat yangi o‘rnatishga beriladi (o‘rnatilganiga <24 soat). Eski mijoz (masalan 1.2.0 dan) `PENDING` bo‘lib Owner qaroriga kutadi, mahalliy litsenziya bilan ishlashda davom etadi.
6. Test yig‘ilmalari (TEST) markazga emas, sinov markaziga yuboradi.

Tavsiya: Owner ilovasida (a) yangi hodisada Windows bildirishnomasi va ovoz, (b) birinchi muvaffaqiyatsiz urinishdan keyin 30 s / 1 daq / 2 daq qayta urinish, (c) natijani jurnalga yozish. Hozircha Owner uchun amaliy tekshiruv: Owner → «Hodisalar» va «Ro‘yxat» da «Gulnoraxon» (shu kompyuter) bormi.

## 7. Avtomatik LAN topish — diagnostika

Bu kompyuterda ilovalarning o‘z `discover()` si 3 soniyada serverni topdi (Wi‑Fi `192.168.1.0/24`, tarmoq «Private», bitta adapter, Windows qoidalari bor: TCP 8787+47870, UDP 47870, faqat mahalliy tarmoq, dastur yo‘li bilan bog‘langan). `192.168.1.6` dagi ikkinchi server (`WIN-TRHG52A5C5K`, 1.14.4) hozir javob bermaydi.

Kod bo‘yicha cheklovlar (mijozda sabab bo‘lishi mumkin):

1. **Server kompyuterda ruxsat shart.** Boshqa kompyuterlar serverni faqat server tomonidagi ikkita Windows qoidasi bo‘lsa ko‘radi; ular **administrator so‘rovini «Ruxsat berish»** bilan tasdiqlagandan keyin yaratiladi (kuniga ko‘pi bilan bir marta so‘raladi). 1.2.0 dan o‘tgan mijozda bu qoidalar yo‘q. «Keyinroq» bosilsa — topilmaydi.
2. **Qoida nomi bo‘yicha tekshiriladi, dastur yo‘li bo‘yicha emas:** dastur boshqa papkaga ko‘chsa, eski yo‘lga bog‘langan qoida «bor» deb hisoblanadi va so‘ralmaydi, lekin to‘sadi.
3. **Faqat o‘z tarmog‘i (odatda /24).** Boshqa kichik tarmoqdagi (ikkinchi router, mehmon Wi‑Fi, AP izolyatsiyasi) server topilmaydi.
4. **Birinchi ulanish bir marta qidiradi.** Server hali yoqilmagan bo‘lsa «Topilmadi» chiqadi, tugmani qayta bosish kerak. Ulangandan keyin (juftlangan) IP o‘zgarsa o‘zi qayta topadi.
5. **Bir nechta server.** Birinchi ulanishda foydalanuvchi tanlaydi va tanlov saqlanadi: noto‘g‘ri server (masalan, bo‘sh bazali ikkinchisi) tanlansa menyu/buyurtma «yo‘q» bo‘lib ko‘rinadi — menyuda «Server manzili…» bilan tuzatiladi. PIN oynasida restoran va filial nomi ko‘rinadi.
6. **Android (APK) topmaydi:** manzil bir marta qo‘lda kiritiladi.
7. Ikkita kompyuter orasidagi haqiqiy topish bu yerda sinalmadi (bitta kompyuter).

## 8. Sinalmagan

- Mijozning haqiqiy bazasi (yo‘q edi); bir nechta oylik katta baza hajmi va vaqti.
- 1.2.0 o‘rnatuvchisining ustidan 1.14.7 o‘rnatuvchisini ishga tushirish (o‘rnatuvchi foydalanuvchining o‘z o‘rnatilgan dasturiga tegishi mumkin bo‘lgani uchun ishga tushirilmadi). Dalil: bu kompyuterda 1.2.0 → … → 1.14.7 shu usulda ketma-ket o‘rnatilgan, ma’lumot papkasi alohida va o‘zgarmagan.
- Android APK (qurilma yo‘q), haqiqiy HDMI/Android TV.
- Haqiqiy markaz (Render) va Owner ilovasi: faqat mahalliy sinov markazi.

## 9. Vositalar

`scripts/verify/migration/`: `manifest.mjs` (SHA‑256 nazorat), `snap.mjs` + `cmp-snap.mjs` (baza qatorlarini nusxada solishtirish), `treecmp.mjs`. Qolgan sinov skriptlari `Desktop\FastFood_Migration_Check_20261021\3-Vositalar`.
