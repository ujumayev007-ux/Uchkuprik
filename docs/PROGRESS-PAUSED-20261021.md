# FastFood: ish to'xtatildi (2026-10-21) — qayta davom ettirish uchun holat

Foydalanuvchi kompyuterni o'chirdi. «Davom et» deyilmaguncha yangi ish boshlanmaydi.
Hech narsa o'chirilmadi, qayta tiklanmadi va o'zgartirilmadi: baza, parol, PIN, litsenziya, sozlama joyida.
Bu fayl yangi yaratilgan; boshqa hujjatlar tegilmagan (`upgrade-progress.md` ham o'z holida).

## 1. Hozirgi holat (qisqa)

- **Server kompyuterda (bu PC) o'rnatilgan:** FastFood **1.14.5** (`%LOCALAPPDATA%\Programs\FastFood`). Ma'lumot: `%APPDATA%\FastFood-Data` (parol/kalit fayllari o'rnatishdan oldin va keyin bir xil ekani tekshirilgan).
- **Zaxiralar (tegilmagan):**
  - `Desktop\FastFood-Server-ZAXIRA-1.14.4-20261021` (1.14.5 o'rnatishdan oldingi to'liq nusxa: ma'lumot, dastur 1.14.4, `.fastfood` kalitlari; `nazorat-yigindilari-oldin.txt`)
  - `Desktop\FastFood-Server-ZAXIRA-1.8.0-20261020` (1.8.0 hodisasidan oldingi)
  - `Desktop\FastFood-Owner-ZAXIRA-1.6.0-20261020-1415`
- **Owner dasturi:** 1.7.0 o'zgarmagan (ish stolidagi «FastFood Owner»). Markaziy server (`fastfood-control.onrender.com`) `cc2e829` versiyada ishlayapti (yangi Owner bo'limlari bor). Undan keyingi kod o'zgarishlari hali **push qilinmagan** (pastga qarang).
- **Ishlayotgan jarayonlar (men to'xtatmadim):** haqiqiy FastFood serveri (1.14.5) va mening mahalliy sinov Postgres'im (port 5433, `C:\Users\PRESTIGE\pg-dev`). Windows o'chirilganda ular yopiladi. Server dasturi yopilganda bazani o'zi toza to'xtatadi: **o'chirishdan oldin FastFood oynasini oddiy yopib qo'ygan ma'qul.** Qayta yoqilganda sinov Postgres'i o'zi ishga tushmaydi (kerak bo'lsa pastdagi buyruq).

## 2. Bajarilgan ishlar (hammasi git'da commit qilingan)

1. LAN avtomatik ulanish (imzolangan topish, qayta ulanish, Ulandi/Ulanmoqda/Aloqa yo'q), Oshxona ilovasi, oshxonada Qabul qilish/Rad etish.
2. Hisobot eksporti (Excel/Word/PDF), ko'rinishni sozlash, ombor bo'limlari.
3. Ombor ogohlantirishlari (belgi, xabar, ovoz, eslatma).
4. TV ilovasi (HDMI ekran tanlash, faqat o'qish hisobi, eskirgan ma'lumot ogohlantirishi).
5. Faqat restoran tarmog'i qoidasi + Owner'ning muddatli istisnosi.
6. Markaziy ro'yxat: yangi o'rnatish hodisalari (Hodisalar), Ro'yxatdan o'tganlar, aniq 72 soatlik sinov, mijozga biriktirish.
7. Owner kirishi tuzatildi (ishonchli kompyuter, tiklash kaliti) — Owner 1.7.0.
8. 1.8.0 hodisasi hal qilindi (server 1.14.x ga qaytarildi, ma'lumot saqlandi).
9. Server **1.14.5** tuzatishi: http serverda `upgrade-insecure-requests`/HSTS olib tashlandi (LAN manzilida sahifa qotib qolish sababi). Haqiqiy serverda tekshirildi: LAN manzilida kirish oynasi chiqadi; haqiqiy Kassa 1.4.0 LAN manzil orqali kirish oynasigacha yetdi.
10. Testlar: backend 303/303, haqiqiy ilovalar bilan 45/45 (127.0.0.1 orqali), LAN topish 21/21.
11. Yig'ish papkasi: `Desktop\FastFood_Upgrade_1.14.5_20261021` (ichida server 1.14.5 va 5 ilova 1.4.0, hujjatlar, test dalillari, manifest).

## 3. Tugallanmagan ishlar

1. **Server 1.14.6 (kod tayyor, commit qilingan, lekin push qilinmagan):** Kassa sahifasi LAN manzilida (http) `crypto.randomUUID` yo'qligi sababli chizilmaydi (`PosPage` — `newKey()`). Tuzatish `frontend/src/lib/orders.ts` (+ `lib/clipboard.ts`, nusxa olish tugmalari). Sinov serveri 1.14.6 qurilgan (`desktop\release-test\win-unpacked`), lekin **LAN rejimidagi to'liq buyurtma sinovi hali ishga tushmagan** (foydalanuvchi to'xtatdi).
2. **Ishchi (production) 1.14.6 o'rnatuvchisi qurilmagan.** Hozir faqat 1.14.5 bor (u o'rnatilgan, lekin Kassa LAN manzilida ochilmaydi).
3. **1.14.6 ni bu kompyuterga o'rnatish** (avval yana zaxira olish kerak) — foydalanuvchi ruxsati bilan.
4. **Yig'ish papkasi** `FastFood_Upgrade_1.14.5_20261021` da server o'rnatuvchisi 1.14.5. U Kassa xatosini saqlaydi: **mijozlarga hozircha yubormang**; 1.14.6 bilan almashtirish va manifest/README/VERSIONS ni yangilash kerak.
5. **Tarmoqdagi ikkinchi server:** `WIN-TRHG52A5C5K` (`192.168.1.6`, FastFood **1.14.4**, kod `05CA-6E5C-B0F5`). Kassa/Oshxona kompyuteriga server o'rnatuvchisi o'rnatilgan bo'lishi mumkin; ilovalar shunga ulangan bo'lishi mumkin. To'g'ri server: `Gulnoraxon` (192.168.1.8, kod `6FB8-BC87-58F9`). Ilova noto'g'ri serverga juftlangan bo'lsa: menyu **Server manzili…** → `192.168.1.8` → saqlash (juftlikni tiklaydi).
6. **Push:** `git log origin/main..HEAD` — 1.14.5/1.14.6 tuzatish commit'lari hali markaziy repoga yuborilmagan (yuborish Render'ni qayta joylaydi; ruxsat bilan).
7. Sinalmaganlar: ikkita kompyuter orasidagi to'liq buyurtma ishi (Kassa → Oshxona → TV) **LAN manzili orqali**, haqiqiy HDMI monitor, Android.
8. Kutayotgan qarorlar: (a) Owner markaziy panelini FastFood ichiga menyu qilib qo'shish (A: o'z kaliti+tasdiq, B: mavjud Owner kalitini ishlatish) — vaqt ~1–1,5 soat; (b) Admin/Kassa/Oshxona/TV/Ofitsiant uchun alohida APK'lar (~2–3 soat, telefonda sinab bo'lmaydi).

## 4. Keyingi qadamlar (qayta yoqilganda, «davom et» deyilgach, shu tartibda)

1. `git status` (toza bo'lishi kerak) va `git log origin/main..HEAD`.
2. Sinov Postgres'ini ishga tushirish (faqat testlar uchun):
   `pg_ctl -D C:\Users\PRESTIGE\pg-dev\data -o "-p 5433 -c listen_addresses=127.0.0.1" -l C:\Users\PRESTIGE\pg-dev\pg.log start` (CIM orqali; `desktop\node_modules\@embedded-postgres\windows-x64\native\bin\pg_ctl.exe`).
3. LAN rejimidagi to'liq sinov (1.14.6 TEST server bilan):
   `set E2E_LAN=1` (PowerShell: `$env:E2E_LAN=1`), `ELECTRON_RUN_AS_NODE` ni olib tashlang, so'ng
   `node <scratchpad>\three-exe-e2e.mjs` (nusxasi repoda: `scripts/verify/real-apps-e2e.mjs`; eski `release-t4-*` / `release-t6-tv` papkalaridagi TEST ilovalar kerak).
4. Natija yaxshi bo'lsa: production server 1.14.6 ni quring (`CONTROL_URL=https://fastfood-control.onrender.com`, `CONTROL_PUBLIC_KEY` — `~\.fastfood\control-prod\control-public.json` dagi ochiq kalit; `node desktop\build.mjs`).
5. 1.14.6 ni o'rnatishdan **oldin**: FastFood'ni yopish, `pg_ctl stop` (o'rnatilgan postgres bilan), `FastFood-Data` + dastur nusxasini `Desktop` ga zaxiralash, nazorat yig'indilarini solishtirish, so'ng `/S` bilan o'rnatish va CIM orqali ishga tushirish (ELECTRON_RUN_AS_NODE bo'lmasin).
6. Yig'ish papkasini 1.14.6 bilan yangilash (eski 1.14.4/1.14.5 o'rnatuvchilarini olib tashlash), manifestni qayta hisoblash.
7. Foydalanuvchi bilan: ikkinchi server (192.168.1.6) masalasini hal qilish, so'ng haqiqiy Kassa va Oshxona bilan buyurtma sinovi.
8. Push (ruxsat bilan), Render versiyasini tekshirish (taxminan 1 soat ketishi mumkin: `https://fastfood-control.onrender.com/api/health/live`).

## 5. Muhim eslatmalar

- Mijozlarga **1.14.4 va 1.14.5 server o'rnatuvchilarini yubormang** (LAN xatolari).
- Owner (sotuvchi) dasturi va zaxira papkalari mijozga berilmaydi (maxfiy kalitlar).
- Eski versiyani yangisining ustiga o'rnatmang (1.8.0 hodisasi).
- Windows'da ilovalarni `Start-Process` bilan emas, CIM yoki yorliq orqali ishga tushiring (`ELECTRON_RUN_AS_NODE` muhitda bo'lsa Electron darrov chiqib ketadi).
- 360 Total Security `win-unpacked.tmp` almashtirishda xato berishi mumkin: qurishni yangi papkaga qaytaring.
- Batafsil texnik hujjatlar: `docs/upgrade-2026-10.md`, `docs/yangilanish-uz.md`, `docs/upgrade-progress.md`; xotira yozuvi: `lan-autoconnect-and-kitchen.md`.

> Tuzatish: `origin/main` allaqachon `3b33912` (1.14.5 tuzatishi shu yerda, Render'da jonli). Yuborilmaganlari faqat 1.14.6 commit'lari. Aniq holat: `PROGRESS-FINAL-1.14.6-20261021.md`.

## 6. Davom ettirilgandan keyingi yangilanish (2026-10-21, kechqurun)

Bajarildi:

- 1.14.6 sinov serveri bilan **LAN rejimida to'liq sinov: 45/45** (ilovalar serverga LAN manzili orqali ulangan).
- Ishchi server **1.14.6** qurildi va shu kompyuterga o'rnatildi. Zaxira: `Desktop\FastFood-Server-ZAXIRA-1.14.5-20261021`. Parol/kalit fayllari nazorat yig'indisi o'zgarmadi, server ishlayapti (`192.168.1.13:8787`, tarmoq: ruxsat etilgan).
- Haqiqiy Kassa 1.4.0 va Oshxona 1.4.0 -> haqiqiy server LAN manzili: kirish oynasi chiqdi.
- Yig'ish papkasi: `Desktop\FastFood_Upgrade_1.14.6_20261021` (server 1.14.6 + 5 ilova 1.4.0, manifest yangilangan). Eski `…1.14.5…` papka nomi o'zgartirilgan, 1.14.4/1.14.5 o'rnatuvchilari olib tashlangan.

Hali qolgan:

- `docs/PROGRESS-PAUSED-20261021.md` va 1.14.6 commit'lari **push qilinmagan** (ruxsat bilan).
- Ikkinchi server `WIN-TRHG52A5C5K` (192.168.1.6, 1.14.4) — bu kompyuterdan hozir ko'rinmayapti (o'chiq bo'lishi mumkin); Kassa/Oshxona kompyuterlarida tekshirish kerak.
- Haqiqiy Kassa/Oshxona kompyuterlarida buyurtma sinovi (foydalanuvchi bilan), haqiqiy HDMI, Android, Owner menyusini FastFood ichiga qo'shish (A/B qarori), alohida APK'lar.
