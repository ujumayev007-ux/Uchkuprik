# FastFood 1.14.6 — yakuniy holat (2026-10-21)

Ish to'xtatildi. Yangi imkoniyat, APK qurish yoki Render'ga joylash **boshlanmadi**.
Hech qanday mijoz ma'lumoti, baza, parol, PIN, litsenziya, sozlama yoki zaxira o'zgartirilmadi yoki o'chirilmadi.

## 1. Versiyalar

| Qism                                               | Versiya                                                            | Qayerda                                                                 |
| -------------------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| FastFood **Server**                                | **1.14.6** (o'rnatilgan, ishlayapti)                               | `%LOCALAPPDATA%\Programs\FastFood`, ma'lumot: `%APPDATA%\FastFood-Data` |
| Admin / Kassa / Oshxona / Ofitsiant / TV ilovalari | 1.4.0 (qurilgan, mijozlarga tayyor)                                | yig'ish papkasi (pastda)                                                |
| Owner dasturi                                      | 1.7.0 (o'zgarmagan)                                                | `%LOCALAPPDATA%\Programs\FastFoodOwner`, ish stolida «FastFood Owner»   |
| Android (ofitsiant APK)                            | 1.13.0 (o'zgarmagan)                                               | `Desktop\FastFood-RESTORANGA-YANGI\FastFood-1.13.0.apk`                 |
| Markaziy server (Render)                           | `3b33912` (jonli: 1.14.5 tuzatishi bor, **1.14.6 tuzatishi YO'Q**) | `https://fastfood-control.onrender.com`                                 |

## 2. Bajarilgan va tekshirilgan

- **Server 1.14.5 xatosi:** http serverda `upgrade-insecure-requests`/HSTS olib tashlandi (LAN manzilida sahifa qotib qolardi).
- **Server 1.14.6 xatosi:** Kassa LAN manzilida (http) `crypto.randomUUID` yo'qligidan chizilmasdi; tuzatildi, nusxa olish tugmalari ham.
- **Testlar (bugun, shu kompyuterda, mahalliy sinov bazasida):** backend **56 fayl / 305 test o'tdi**; backend va frontend tur tekshiruvi toza; migratsiyalar bazaga qo'llangan ("No pending migrations").
- **LAN sinovi (sinov serveri + Admin/Kassa/Oshxona/TV, hammasi LAN manzili bilan):** 45/45 o'tdi (kassadan buyurtma → oshxona Qabul qilish/Tayyorlanmoqda/Tayyor → TV va Admin yangilanishi → rad etish/qayta yuborish).
- **Haqiqiy server 1.14.6 bilan:** LAN manzilida kirish oynasi chiqadi; haqiqiy Kassa 1.4.0 va Oshxona 1.4.0 (vaqtinchalik profil bilan) kirish oynasigacha yetdi; tarmoq holati «ruxsat etilgan».
- **O'rnatish xavfsizligi:** o'rnatishdan oldin to'liq zaxira olingan; `secrets.enc` va `device-key.enc` nazorat yig'indilari oldin/keyin bir xil; `secrets.json` yo'q.

## 3. HALI SINALMAGAN (kutilmoqda)

**Haqiqiy Kassa va Oshxona bilan, haqiqiy bazada buyurtma ishi sinalmagan.** Men haqiqiy bazaga buyurtma kiritmadim. Egasi ofisga qaytgach quyidagini qiladi:

1. Kassa va Oshxona kompyuterlarida ilovani yopib qayta oching (qayta o'rnatish shart emas).
2. Biznes kodi + login + parol bilan kiring.
3. Kassada buyurtma bering → oshxonada paydo bo'lishi va ovoz → Qabul qilish → Tayyorlanmoqda → Tayyor → Admin/TV yangilanishi.
4. Oshxonada «Rad etish» (Admin → Rollar da `kitchen.reject` ruxsati kerak).
5. Wi‑Fi'ni 20–30 soniya o'chirib yoqing: «Aloqa yo'q» → «Ulandi».

Boshqa sinalmaganlar: ikkinchi server (`WIN-TRHG52A5C5K`, `192.168.1.6`, 1.14.4) masalasi; haqiqiy HDMI monitor; Android; ikkita kompyuter orasidagi Excel/Word/PDF'ni Office'da ochish.

## 4. Qolgan vazifalar (yangi ishlar — faqat «davom et» deyilgach)

1. Kassa/Oshxona haqiqiy sinovi natijasiga qarab tuzatishlar.
2. Ikkinchi serverni (192.168.1.6) o'chirish yoki ilovalarni to'g'ri serverga ulash (menyu **Server manzili…** → joriy server manzili).
3. 1.14.6 tuzatishini (3 ta commit, pastga qarang) `main` ga qo'shish va Render'ga joylash. Joylanish taxminan 1 soat. (Markaziy serverga 1.14.6 tuzatishi shart emas: u mijoz serveri uchun.)
4. Owner markaziy panelini FastFood ichiga menyu qilib qo'shish (A: o'z kaliti + bir marta tasdiq — tavsiya; B: mavjud Owner kalitini ishlatish), ~1–1,5 soat.
5. Alohida APK'lar: Admin, Kassa, Oshxona, TV, Ofitsiant (~2–3 soat, telefonda sinab bo'lmaydi).
6. Imzo sertifikati (hozir o'rnatuvchilar imzosiz).

## 5. Git holati va nima uchun `main` ga yuborilmagan

- `origin/main` = `3b33912` (1.14.5 tuzatishi **kechagi ishda allaqachon yuborilgan** va Render'da jonli). Mahalliy `main` undan **3 commit oldinda**: `859fd9d` (1.14.6 tuzatishi), `7c315df` va `470c9f0` (hujjatlar).
- Render xizmatlari **faqat `main`** ni kuzatadi (`docs/render-setup.md`, `render.yaml`) va `main` ga har push qilinganda avtomatik qayta joylanadi. Buni dashboard'dan o'chirib bo'lmaydi, shuning uchun `main` ga **yuborilmadi**.
- Saqlash uchun commit'lar alohida tarmoqqa yuborilgan: **`hold/1.14.6-no-deploy`** (`origin`). Render uni kuzatmaydi; GitHub Actions (CI) faqat test o'tkazadi, joylamaydi.
- Keyinroq joylamoqchi bo'lsangiz (ruxsat bilan): `git push origin main` — Render qayta joylanadi (taxminan 1 soat), avval Render dashboard'ida holatni kuzating.

## 6. Aniq fayl joylari

| Nima                                        | Qayerda                                                                                   |
| ------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Manba kodi                                  | `C:\Users\PRESTIGE\fastfood-app`                                                          |
| Yig'ish papkasi (mijozga yuboriladigan)     | `C:\Users\PRESTIGE\Desktop\FastFood_Upgrade_1.14.6_20261021` (`1-Mijoz-ilovalari` ichida) |
| Server o'rnatuvchisi 1.14.6                 | `…\1-Mijoz-ilovalari\FastFood-Setup-1.14.6.exe`                                           |
| Ilova o'rnatuvchilari 1.4.0                 | `…\1-Mijoz-ilovalari\FastFood-{Admin,Kassa,Oshxona,Ofitsiant,TV}-Setup-1.4.0.exe`         |
| Test dalillari, skriptlar                   | `…\4-Sinov-dalillari`, repoda `scripts/verify/`                                           |
| Zaxira: 1.14.6 dan oldin (1.14.5 holati)    | `Desktop\FastFood-Server-ZAXIRA-1.14.5-20261021`                                          |
| Zaxira: 1.14.5 dan oldin (1.14.4 holati)    | `Desktop\FastFood-Server-ZAXIRA-1.14.4-20261021`                                          |
| Zaxira: 1.8.0 hodisasidan oldin             | `Desktop\FastFood-Server-ZAXIRA-1.8.0-20261020`                                           |
| Zaxira: Owner 1.6.0                         | `Desktop\FastFood-Owner-ZAXIRA-1.6.0-20261020-1415`                                       |
| Kalitlar, litsenziyalar, Owner kirish fayli | `C:\Users\PRESTIGE\.fastfood` (**mijozga bermang**)                                       |
| Owner o'rnatuvchisi 1.7.0                   | `Desktop\FastFood-Owner-ISHCHI\FastFood-Owner-Setup-1.7.0.exe`                            |
| Hujjatlar                                   | `docs/upgrade-2026-10.md`, `docs/yangilanish-uz.md`, `docs/PROGRESS-PAUSED-20261021.md`   |

## 7. Ogohlantirishlar

- Mijozlarga **1.14.4 va 1.14.5** server o'rnatuvchilarini yubormang.
- Eski versiyani yangisining ustiga o'rnatmang (1.8.0 hodisasi).
- Owner dasturi va `.fastfood` papkasi mijozga berilmaydi.
- Ishlayotgan haqiqiy server (`1.14.6`) bu ishda o'zgartirilmadi va qayta ishga tushirilmadi.
