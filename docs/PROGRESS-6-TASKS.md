# 6 vazifa — ish jarayoni (2026-10-23)

Tarmoq: `feature/six-tasks-20261023` (asosi `b666a2f` = main).

| # | Vazifa | Holat |
|---|--------|-------|
| 1 | Alohida navbat TV EXE (login/PIN yo‘q) | bajarildi (commit pastda) |
| 2 | Admin kompyuteri o‘chiq bo‘lsa ham LAN ishlashi | jarayonda |
| 3 | Ombor / Bozorlik soddalashtirish | kutilmoqda |
| 4 | Owner EXE va Render 502 | kutilmoqda |
| 5 | Ombor eksporti (xlsx/docx/pdf) | kutilmoqda |
| 6 | Oshxona rejimlari | kutilmoqda |

## 1-vazifa natijasi
- `GET /queue/display`: ro‘yxatdan o‘tgan, tasdiqlangan DISPLAY qurilmasi faqat raqam va holatni oladi (sessiyasiz). LAN, litsenziya, bloklash qoidalari amal qiladi.
- TV ilovasi: PIN yo‘q; birinchi marta Admin ro‘yxatdan o‘tkazadi; har 3 s yangilanadi.
- Mavjud TV EXE 1.6.1 yetadi (qobiq o‘zgarmadi); faqat Server qayta yig‘iladi (oxirida, bir marta).
- Tekshiruv: backend test 2/2, haqiqiy TV ilovasi 4/4.

## Yig‘ish (oxirida bir marta)
- Server 1.14.9 → yangi versiya (backend/frontend o‘zgardi).

## Keyingi qadam
2-vazifa: tashxis.
