# 6 vazifa — ish jarayoni (2026-10-23)

Tarmoq: `feature/six-tasks-20261023` (asosi `b666a2f` = main).

| # | Vazifa | Holat |
|---|--------|-------|
| 1 | Alohida navbat TV EXE (login/PIN yo‘q) | bajarildi (commit pastda) |
| 2 | Admin kompyuteri o‘chiq bo‘lsa ham LAN ishlashi | bajarildi |
| 3 | Ombor / Bozorlik soddalashtirish | bajarildi |
| 4 | Owner EXE va Render 502 | bajarildi |
| 5 | Ombor eksporti (xlsx/docx/pdf) | jarayonda |
| 6 | Oshxona rejimlari | kutilmoqda |

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

## Yig‘ish (oxirida bir marta)
- Server 1.14.9 → yangi versiya (backend/frontend o‘zgardi).
- Owner EXE 1.7.1.

## Keyingi qadam
5-vazifa: tashxis.
