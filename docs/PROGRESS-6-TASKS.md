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
| 3 | Professional Chek Dizayneri (6 ta andoza, QR/shtrixkod, Fiskal) | Bajarildi | (joriy) |

### 1-vazifa: Kassa Bozorlik
- Kassa oynasida (POS) `🛒 Bozorlik` tezkor tugmasi va `/bozorlik` marshruti qo‘shildi.
- Kassir faqat yangi xarid qo‘shishi va tarixini ko‘rishi mumkin (o‘chirish/tahrirlash huquqi yo‘q).
- Xarid turlari: Naqd, Karta va Nasiya (qarz). Naqd/karta tanlanganda kassa balansi va xarajatlar aniq hisoblanadi.
- Admin uchun xaridni xavfsiz tuzatish imkoniyati (`POST /purchases/:id/correct`). Tuzatishda eski va yangi qiymatlar, sababi va foydalanuvchi ma'lumoti o‘zgarmas `audit_logs` jadvaliga yoziladi.
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

