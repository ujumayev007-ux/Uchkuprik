# 6 vazifa — ish jarayoni (2026-10-23)

Tarmoq: `feature/six-tasks-20261023` (asosi `b666a2f` = main).

| # | Vazifa | Holat |
|---|--------|-------|
| 1 | Alohida navbat TV EXE (login/PIN yo‘q) | bajarildi (commit pastda) |
| 2 | Admin kompyuteri o‘chiq bo‘lsa ham LAN ishlashi | bajarildi |
| 3 | Ombor / Bozorlik soddalashtirish | bajarildi |
| 4 | Owner EXE va Render 502 | bajarildi |
| 5 | Ombor eksporti (xlsx/docx/pdf) | bajarildi |
| 6 | Oshxona rejimlari | bajarildi |

## 1-vazifa natijasi
- `GET /queue/display`: ro‘yxatdan o‘tgan, tasdiqlangan DISPLAY qurilmasi faqat raqam va holatni oladi (sessiyasiz). LAN, litsenziya, bloklash qoidalari amal qiladi.
- TV ilovasi: PIN yo‘q; birinchi marta Admin ro‘yxatdan o‘tkazadi; har 3 s yangilanadi.
- Mavjud TV EXE 1.6.1 yetadi (qobiq o‘zgarmadi); faqat Server qayta yig‘iladi (oxirida, bir marta).
- Tekshiruv: backend test 2/2, haqiqiy TV ilovasi 4/4.

## 2-vazifa natijasi
- Bog‘liqlik: barcha terminallar «FastFood Admin» (server) o‘rnatilgan kompyuterdagi Postgres+API ga ulanadi. Admin oynasi yopiq bo‘lsa ham server fon rejimida ishlaydi (1.14.8 dan), lekin kompyuter o‘chsa server ham to‘xtaydi.
- Yechim: serverni doim yoqiq kompyuterga (masalan, Kassa) ko‘chirish. Menyu: FastFood → «Serverni boshqa kompyuterga ko‘chirish…» — serverni xavfsiz to‘xtatadi, paket (ma’lumot + kalitlar) yozadi, eski kompyuterdagi serverni o‘chiradi (ikki server ishlamasin). Yangi kompyuter kalitlarni o‘zi qayta shifrlaydi; parollar, PIN, litsenziya identifikatori va LAN kaliti saqlanadi; terminallar yangi IP’ni o‘zi topadi. Admin kompyuterida yengil Admin ilovasi ishlatiladi.
- Bulut/sinxronlash yo‘q: server qaysi kompyuterda bo‘lsa, ma’lumot o‘sha yerda.
- Tekshiruv: ko‘chirish 10/10 (parol, PIN, LAN kaliti, qayta shifrlash, eski server to‘xtashi). Menyu bandining o‘zi faqat haqiqiy EXE’da sinaladi.

## 3-vazifa natijasi
- Bozorlik allaqachon: bir nechta mahsulot, yangi mahsulot, birlik, summa (narx ko‘rsatiladi), to‘landi → yetkazib beruvchiga to‘lov (xarajat), ombor va tannarx yangilanadi.
- Qo‘shildi: har qatorga «Qayerdan» (boshqa joy) — bitta saqlashda har joy uchun alohida xarid va to‘lov (bitta tranzaksiya); gramm/millilitr mahsulotlar uchun kg/l doim mavjud.
- Tekshiruv: backend 11/11, UI (Bozorlik saqlash, yangi mahsulot, kg) o‘tdi.

## 4-vazifa natijasi
- Render hozir ishlaydi (live/ready 200, versiya b666a2f, Owner sahifasi 200). Kod xatosi topilmadi.
- Sabab: Render bepul tarifi 15 daqiqa harakatsizlikdan keyin uxlaydi, deploy paytida qayta ishga tushadi — shu vaqtda 502 qaytaradi. Owner EXE ochilishda kutardi, lekin konsol ochiq paytda yangilansa/qayta yuklansa Render’ning 502 sahifasi ko‘rinib qolardi (HTTP 5xx "did-fail-load" bermaydi).
- Tuzatish: Owner EXE asosiy sahifadagi 5xx javobni ko‘rsatmaydi, "uyg‘onmoqda" oynasida kutadi va konsolni o‘zi qayta ochadi (jurnalga yoziladi). Owner EXE 1.7.1.
- Render jurnallarini ko‘rib bo‘lmadi (Render API kaliti yo‘q). Doimiy yechim: Render pullik tarif (uxlamaydi).
- Tekshiruv: 2/2 (soxta 502 → o‘zi tiklandi).

## 5-vazifa natijasi
- Eksport avvaldan bor edi (ca705ae): Excel/Word/PDF, bo‘limlar, ustunlar, sana, qidiruv, holat, qiymat va jamilar, ruxsatlar.
- Qo‘shildi: aniq mahsulotlarni tanlash (qoldiq, kam qolgan, harakatlar) va «O‘rtacha narx» ustuni (faqat tannarxni ko‘rish ruxsati borlarga).
- Tekshiruv: eksport testlari 28/28 (test sanasi restoran vaqt zonasiga to‘g‘rilandi).

## 6-vazifa natijasi
- Markaziy katalogda «Oshxona ish rejimi» (kitchen.mode): Joriy / Barcha buyurtmalar / Avtomatik. Owner belgilaydi yoki Admin’ga topshiradi (Admin mavjud sozlamalar sahifasida tanlaydi).
- Joriy: o‘zgarmagan. Barcha buyurtmalar: oshxona ekranida toifa filtrisiz barcha faol buyurtmalar. Avtomatik: buyurtma o‘zi qabul qilinadi (tarixga yoziladi); «Tayyor» bosilganda to‘liq to‘langan buyurtma kassadagi «Berildi» (completeOrder) orqali yakunlanadi — ombordan yechish, fiskal, sodiqlik bir marta; to‘lanmagan buyurtma «Tayyor»da qoladi.
- Tekshiruv: 2/2 yangi, oshxona/boshqaruv regressiya 58/58.

## Yig‘ish (oxirida bir marta)
- Server 1.14.9 → yangi versiya (backend/frontend o‘zgardi).
- Owner EXE 1.7.1.

## Yig‘ildi (2026-10-23)
- Server 1.14.10: `Desktop\FastFood-TAYYOR\2-Server\FastFood-Admin-Setup-1.14.10.exe` (eski 1.14.9 zaxirada: `desktop/release/FastFood-Admin-Setup-1.14.9-oldingi-b666a2f.exe`)
- Owner 1.7.1: `Desktop\FastFood-TAYYOR\1-Owner\FastFood-Owner-Setup-1.7.1.exe`
- Kassa/Oshxona/TV/Ofitsiant 1.6.1 va APK 1.14.9 o‘zgarmadi (qayta yig‘ilmadi).

## Qolgan
- «Oshxona ish rejimi» Owner konsolida ko‘rinishi uchun markaz (Render) yangilanishi kerak (deploy qilinmadi). Hozircha rejim «Joriy».
- Render 502 butunlay yo‘qolishi uchun pullik tarif (uxlamaydi).
- Server ko‘chirish menyusi va 1.14.10 haqiqiy kompyuterda sinalmagan.

## Keyingi qadam
Hammasi bajarildi.

---

# Yangi 3 ta vazifa (Ketma-ket bajarildi)

| # | Vazifa | Holat | Commit |
|---|--------|-------|--------|
| 1 | Kassa Bozorlik (Cashier Market Purchase) | Bajarildi | `9ffcb16` |
| 2 | Professional Printer boshqaruvi (ESC/POS, LAN discovery, Ping) | Bajarildi | `04a0b6e` |
| 3 | Professional Chek Dizayneri (6 ta andoza, QR/shtrixkod, Fiskal) | Bajarildi | `36bafd8` |
| 4 | Kassa kompyuterini doimiy LAN server qilish (Permanent Cashier Host) | Bajarildi | `ea215d4` |
| 5 | Admin Stol boshqaruvi: stollarni o‘chirish, nofaol qilish va tiklash | Bajarildi | `0299c19` |

### 1-vazifa: Kassa Bozorlik
- Kassa oynasida (POS) `🛒 Bozorlik` tezkor tugmasi va `/bozorlik` marshruti qo‘shildi.
- Kassir faqat yangi xarid qo‘shishi va tarixini ko‘rishi mumkin (o‘chirish/tahrirlash huquqi yo‘q).
- Xarid turlari: Naqd, Karta va Nasiya (qarz). Naqd/karta tanlanganda kassa balansi va xarajatlar aniq hisoblanadi.
- Admin uchun xaridni xavfsiz tuzatish imkoniyati (`POST /purchases/:id/correct`). Tuzatishda eski va analytical ma'lumotlar, sababi va foydalanuvchi ma'lumoti o‘zgarmas `audit_logs` jadvaliga yoziladi.
- Testlar: `test/bozorlik-cashier.test.ts` (4/4 test o‘tdi).

### 2-vazifa: Professional Printer boshqaruvi
- Avtomatik topish: Windows/USB printerlar va mahalliy LAN subnet (masalan, `192.168.1.*` port 9100) printerlarini skanerlash (`POST /printers/discover-lan`).
- IP to‘qnashuvlarini oldini olish (bir xil IP uchun 409 DUPLICATE_PRINTER_IP ogohlantirishi).
- Jonli TCP ping diagnostikasi (`POST /printers/:id/ping` va `/printers/ping-host`).
- Bo‘limlarga marshrutlash: Kassa, Asosiy oshxona, Baliqxona, Kabobxona, Fastfud, Ichimliklar (`POST /printers/seed-departments`).
- Zaxira printer (backup printer) va kassa tortmasini avtomatik ochish (`cashDrawer(2)`).
- Testlar: `test/printing-pro.test.ts` (5/5 test o‘tdi).

### 3-vazifa: Professional Chek Dizayneri
- 6 ta professional andoza: `Klassik (Classic)`, `Premium`, `Minimal (58 mm)`, `Oshxona (Kitchen)`, `Yetkazib berish (Delivery)`, `Brendli (Branded)`.
- 1-klikda andozani qo‘llash va moslashtirish imkoniyati.
- Ajratuvchi chiziq uslublari: Uzuk-uzuk (`- - - -`), Yakka to‘g‘ri (`─────`), Qo‘shaloq (`═════`), Yulduzchalar (`* * * *`), Qalin (`━━━━━`).
- QR-kod va Shtrixkod (ESC/POS va brauzer preview uchun to‘liq qo‘llab-quvvatlandi).
- Fiskal OFD maʼlumotlari, Yetkazib berish maʼlumotlari va ijtimoiy tarmoqlar integratsiyasi.
- Jonli ko‘rinish (Live preview) va printerga sinov chop etish.
- Testlar: `test/receipt-templates-pro.test.ts` (6/6 test o‘tdi).

### 4-vazifa: Kassa kompyuterini doimiy LAN server qilish (Permanent Cashier Host)
- Kassa kompyuterida Server dasturi (`FastFood-Admin-Setup-1.14.10.exe`) fon rejimida oyna ochmasdan (`--hidden`), Windows bilan birga avtomatik ishga tushadi. Tray belgisi orqali boshqariladi.
- Admin kompyuterida yengil Admin mijozi (`FastFood-Admin-Setup-1.6.1.exe`) ishlatiladi. Admin kompyuteri o‘chsa ham restoran, kassa, oshxona va ofitsiantlar ishlashda davom etadi.
- Kassa kompyuterida esa kassir `FastFood-Kassa-Setup-1.6.1.exe` orqali kassa POS oynasidan foydalanadi.
- Oshxona, Ofitsiant va TV qurilmalari Kassa serveriga LAN (UDP beacon) orqali avtomatik ulanadi.
- Ikki server bir vaqtda bitta bazani ishlatmasligi uchun `moved.json` bloki mavjud.
- Ko‘chirish va ortga qaytarish (Rollback) jarayoni sinovdan o‘tdi (`test/server-migration.test.ts`, 2/2 test o‘tdi).
- Alohida xavfsiz portda (54399) 130 ta jadval to‘liq ma’lumotlar bilan tekshirib tiklandi (PASS).

### 5-vazifa: Admin Stol boshqaruvi (Table Deletion & Restoration)
- Admin panelida zallardagi stollarni yakka holda o‘chirish (`DELETE /tables/:id`) va tanlanganlarni guruhlab o‘chirish (`POST /tables/batch-delete`).
- Xavfsizlik: faol buyurtmasi (`DRAFT`, `PENDING`, `PLACED`, `PREPARING`, `READY`, `SERVED`) mavjud stolni o‘chirish qat’iy taqiqlanadi (409 TABLE_HAS_ACTIVE_ORDERS).
- Moliyaviy va hisobot butunligi: agar stolda avval buyurtmalar bo‘lgan bo‘lsa, u bazadan o‘chirilmaydi, balki xavfsiz nofaol holatga (`isActive: false`) o‘tkaziladi. Shu tariqa barcha o‘tgan cheklar, hisobotlar va auditlar 100% saqlanadi. Buyurtma bo‘lmagan stol to‘liq o‘chiriladi.
- Qayta tiklash: Admin nofaol stollarni ko‘rish (`showInactive`) va 1-klikda qayta tiklash (`POST /tables/:id/restore` va `POST /tables/batch-restore`) imkoniyatiga ega.
- Kassa, Ofitsiant va QR-menyu interfeyslaridan o‘chirilgan/nofaol stollar avtomatik yashiriladi va yangi buyurtma ochish bloklanadi.
- Testlar: `test/floor-tables.test.ts` (4/4 test o‘tdi).

### 6-vazifa: R01-R13 to‘liq tizim mukammallashtirish (2026-10-24)
- **R01 & R02 (TV Navbat Ekrani):** TV.apk va Windows TV ilovalari biznes kodi, login, parol yoki PIN talab qilmasdan, LAN tarmog‘idagi restoran serverini o‘zi topadi va to‘g‘ridan-to‘g‘ri to‘liq ekranli navbatni ko‘rsatadi (`/navbat`). Serverda TV qurilmasi faol DISPLAY sifatida avtomatik ro‘yxatga olinadi.
- **R03 (Admin yaratgan xodimlar PIN kodi):** Admin yaratgan barcha kassir, oshxona va ofitsiant PIN kodlari o‘z ilovalarida to‘liq ishlaydi. Nollar bilan boshlanuvchi PINlar (`0042`) satr sifatida saqlanishi va tuzilishi ta’minlandi. Yangi terminallar PENDING holatda qotib qolmasdan darhol ACTIVE rejimga o‘tadi.
- **R05 (Kirim qo‘shish, o‘rtacha tannarx, retsept birliklari):** Mavjud xomashyolarga dublikat yaratmasdan yangi kirim qo‘shish (`POST /inventory/items/:id/receipt`), og‘irlikli o‘rtacha tannarx hisob-kitobi (`avgCost`), kg–g va l–ml o‘rtasidagi 1000 koeffitsientli avtomatik konvertatsiya (15 kg guruchdan 150 g yechilganda 14.85 kg qolishi) to‘liq sinovdan o‘tdi (`test/inventory-receipt.test.ts`, 4/4 test).
- **R06 (Admin menyular ko‘rinishi):** Admin panelida istalgan ixtiyoriy menyularni (franshiza, o‘qitish, uskunalar va h.k.) yashirish yoki ko‘rsatish imkoniyati (`MenuVisibilityCard`, `GET/PUT /admin/menu-visibility`). Xavfsizlik maqsadida Boshqaruv paneli, Sozlamalar va Litsenziya sahifalarini yashirish bloklangan. 1-klikda barchasini tiklash tugmasi mavjud.
- **R08 & R10 (Printerlar va kassa tortmasi):** Kassir va oshxona foydalanuvchilariga printerlar ro‘yxatini ko‘rish, ping tekshirish, tarmoqdagi printerlarni avtomatik skanerlash (`discover-lan`) va sinov cheki chiqarish ruxsati berildi. Kassa chekida kassa tortmasini ochish impulsi (`cashDrawer(2)`) ishlaydi.
- **R11 & R12 (Kassa Bozorlik, Chiqimlar va 5 ta qat’iy menyu):** Kassa ilovasida (`shellKind() === 'cashier'` yoki kassa foydalanuvchisi) yon panelda qat’iy 5 ta asosiy bo‘lim o‘rnatildi: 1) Kassa, 2) Buyurtmalar tarixi, 3) Printer sozlamalari, 4) Bozorlik, 5) Chiqimlar. Yangi `/chiqimlar` sahifasi orqali kassa g‘aznasidan chiqimlarni to‘g‘ridan-to‘g‘ri kiritish va kassa smenasi balansida aks ettirish ta’minlandi.
- **Yig‘ilgan o‘rnatuvchilar:** Yangilangan server dasturi `FastFood-Kassa-Server-Setup-1.14.12.exe` yig‘ildi va `C:\Users\PRESTIGE\Desktop\FastFood-TAYYOR\0-Kassa-AllInOne\` papkasiga joylashtirildi.
- **Test natijalari:** Backend bo‘yicha barcha 15 ta test to‘plami (99 ta test) 100% muvaffaqiyatli o‘tdi. Frontend TypeScript va Vite yig‘ilishi xatosiz yakunlandi.




