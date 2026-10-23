# Kassa all-in-one + parolsiz TV (2026-10-23)

Branch `feature/six-tasks-20261023`, commit 2a9f6a7. Push/deploy qilinmagan.

## Bajarildi
- **Kassa all-in-one**: `BUILD_EDITION=cashier node desktop/build.mjs` →
  `desktop/release-kassa/FastFood-Kassa-Server-Setup-<ver>.exe`. Ichida server + PostgreSQL +
  Kassa oynasi (`/kassa`, PIN, printerlar). Ma’lumotlar o‘sha `%APPDATA%\FastFood-Data`.
  Windows bilan yashirin ishga tushadi, oyna yopilsa server trayda ishlayveradi.
  Profil doimiy (`%APPDATA%\FastFood-Kassa-App`): yangilanishda Kassa qurilmasi qayta
  tasdiq so‘ramaydi. Birinchi ishga tushishda alohida «FastFood Kassa» ilovasining printer
  sozlamalari va chop etilgan oshxona cheklari ro‘yxati olinadi.
- **Owner control**: production build `CONTROL_URL`/`CONTROL_PUBLIC_KEY` siz endi qurilmaydi
  (`ALLOW_NO_CONTROL=1` faqat ataylab).
- **TV parolsiz**: `POST /devices/display/register` — faqat self-hosted, faqat restoran
  tarmog‘idan, doim PENDING (Owner tasdiqlaydi), kutayotgan TV lar ≤ 5. Navbat ekrani o‘zi
  ro‘yxatdan o‘tadi; bir nechta filial bo‘lsa filialni bir marta tanlaydi. TV EXE/APK qayta
  qurish shart emas (sahifa serverdan keladi).
- **Kassa savati** Bozorlikka o‘tib qaytganda saqlanadi (shu xodim + filial).
- **Printer xatolari**: printer topilmasa / offline bo‘lsa / chop etmasa aniq o‘zbekcha xabar.
  Printer kodi `desktop/printers.cjs` da umumiy (Kassa shell ham ishlatadi).

## O‘rnatish tartibi (Kassa kompyuteri)
1. Server shu kompyuterda bo‘lsa: tray «Chiqish», `%APPDATA%\FastFood-Data` ni to‘liq nusxalash.
   Server boshqa kompyuterda bo‘lsa: u yerda «Serverni boshqa kompyuterga ko‘chirish…» paketi.
2. `FastFood-Kassa-Server-Setup-1.14.11.exe` ni o‘rnatish (ma’lumotlar o‘sha papkada qoladi).
3. Tekshiruvdan so‘ng eski «FastFood Admin» server va alohida «FastFood Kassa» ilovasini
   o‘chirish (ma’lumotlar o‘chmaydi). Ikkalasi qolsa ham ikkinchi baza ochilmaydi (attach).
4. Kassa oynasi bir marta administrator paroli bilan ro‘yxatdan o‘tadi → Owner tasdiqlaydi.

## 1.14.12 tuzatish (commit 3270c71)
- Xato «Maxfiy kalitlarni ochib bo‘lmadi»: 1.14.11 Kassa o‘z Electron profilida
  (`%APPDATA%\FastFood-Kassa-App`) ishlagan; `secrets.enc` esa server profilidagi
  `%APPDATA%\FastFood\Local State` kaliti bilan shifrlangan. 1.14.12 server profilini ishlatadi.
- Oddiy nusxa (ko‘chirish paketi emas) uchun: eski kompyuterda `KALIT-OLISH.cmd`
  (faqat o‘qiydi) → `FastFood-Data\kochirish-kaliti.txt`. Kassa birinchi ishga tushishda
  kalitlarni ochadi, o‘z kaliti bilan qayta shifrlaydi, kalit faylini o‘chiradi; eski
  `*.enc` lar `*.enc.eski-<vaqt>` bo‘lib qoladi. Kalit to‘g‘ri kelmasa hech narsa o‘zgarmaydi.
- Kassa endi `Programs\FastFoodKassaServer` ga o‘rnatiladi (yengil Kassa ilovasi papkasiga emas).

## Qolgan
- Render (markaziy server) hali b666a2f: `kitchen.mode` Owner konsolida ko‘rinmaydi.
- Bu kompyuterdagi jonli server Owner ga bog‘lanmagan (litsenziya — foydalanuvchi o‘zi).
