# Markaziy serverni joylashtirish — oddiy qadamlar (O‘zbekcha)

Bu ko‘rsatma **hali bajarilmagan** qadamlarni sanaydi. Hozirgi mijozlar eski
litsenziya usulida ishlashda davom etadi: yangi server tayyor va sinalmaguncha ularga
tegilmaydi.

## 0. Nimani bilish kerak

- **Markaziy server** — bir martalik, internetda doim yoqilgan xizmat (siz boshqarasiz).
- **Owner dasturi** — sizning kompyuteringizdagi EXE; serverga ulanadi.
- **Mijoz dasturi** — restoranlardagi kassa EXE; serverga litsenziya kaliti bilan ulanadi.
- Google Drive faqat fayl saqlash uchun; server vazifasini bajara olmaydi.

## 1. Server uchun joy tanlash

Loyihada allaqachon Render uchun sozlama bor (`render.yaml`). Tavsiya:

- **Alohida yangi** Web Service (mavjud `Uchkuprik` xizmatiga tegmang).
- **Alohida yangi** PostgreSQL baza.
- Haqiqiy ishlatish uchun **pullik tarif** oling: bepul xizmat uxlab qoladi va bepul
  baza muddati tugaydi — litsenziya nazorati uchun yaramaydi.

### Bepul Render tarifi bo‘yicha ogohlantirish

- Bepul Web Service 15 daqiqa so‘rovsiz qolsa uxlaydi; birinchi so‘rov sekin (taxminan
  yarim daqiqa). Mijoz dasturlari har 60 soniyada ulanadi, shuning uchun ish vaqtida
  uyg‘oq turadi; oflayn ruxsatnoma uzilishlarni qoplaydi.
- **Bepul Render bazasi cheklangan muddatli** (o‘chirilishi mumkin). Litsenziyalar bazasi
  yo‘qolsa barcha mijozlar qayta faollashtirilishi kerak. Shuning uchun bepul Render
  bazasini faqat sinov uchun ishlating. Doimiy variant: pullik Render bazasi yoki
  muddati tugamaydigan boshqa bepul PostgreSQL xizmati (`DATABASE_URL` ga qo‘yiladi).
- Google Drive server o‘rnini bosa olmaydi, lekin EXE o‘rnatuvchilarni tarqatish va
  zaxira fayllarini saqlash uchun yaroqli (zaxirani parol bilan arxivlang).

## 2. Kalitlarni yaratish (o‘z kompyuteringizda, bir marta)

```text
npm run control:keygen -w backend
```

- `CONTROL_SIGNING_KEY` — **maxfiy**. Faqat serverning sozlamalariga kiritiladi.
  Hech kimga yubormang, Google Drive’ga, GitHub’ga yoki chatga qo‘ymang.
- `CONTROL_PUBLIC_KEY` — ochiq kalit; dasturlarga kiritiladi.

## 3. Serverni sozlash (Render)

Yangi Web Service uchun:

| Maydon         | Qiymat                                  |
| -------------- | --------------------------------------- |
| Branch         | `main`                                  |
| Root Directory | bo‘sh                                   |
| Build Command  | `npm ci --include=dev && npm run build` |
| Start Command  | `npm start`                             |
| Health Check   | `/api/health/ready`                     |

Environment:

| Kalit                 | Qiymat                                                     |
| --------------------- | ---------------------------------------------------------- |
| `NODE_ENV`            | `production`                                               |
| `HOST`                | `0.0.0.0`                                                  |
| `APP_ORIGIN`          | yangi xizmatning HTTPS manzili (oxirida `/` siz)           |
| `DATABASE_URL`        | yangi bazaning _external_ manzili + `?sslmode=verify-full` |
| `APP_SECRET_KEY`      | 32 tasodifiy bayt (base64), bir marta yaratib saqlang      |
| `CONTROL_PLANE`       | `true`                                                     |
| `CONTROL_SIGNING_KEY` | 2-qadamdagi maxfiy kalit                                   |

Deploydan so‘ng tekshiring: `/api/health/ready` — 200, `/api/control/info` — `{"plane":true}`.

## 4. Birinchi Owner hisobi (Render Shell)

```text
OWNER_EMAIL=siz@pochta.uz OWNER_NAME="Ismingiz" OWNER_PASSWORD=<kuchli parol> npm run control:owner -w backend
```

Chiqqan `otpauth://...` manzilni autentifikator ilovasiga (Google Authenticator va h.k.)
**bir marta** qo‘shing. Parolni xavfsiz joyda saqlang.

## 5. EXE fayllarni haqiqiy sozlama bilan yig‘ish

```text
# Mijoz dasturi
CONTROL_URL=https://<server-manzili> CONTROL_PUBLIC_KEY=<ochiq kalit> node desktop/build.mjs
# Owner dasturi
OWNER_URL=https://<server-manzili> node owner-desktop/build.mjs
```

Fayllar: `desktop/release/` va `owner-desktop/release/`. Sinov (TEST) yig‘ish
`BUILD_CHANNEL=test` bilan alohida papkalarga tushadi va ishlab chiqarishga tegmaydi.

Windows’da “noma’lum nashriyotchi” ogohlantirishi chiqmasligi uchun kod imzolash
sertifikati (`.pfx`) kerak: `CSC_LINK` va `CSC_KEY_PASSWORD` o‘rnating. Sertifikatsiz
EXE faqat sinov uchun.

## 6. Birinchi kirish va sinov

1. Owner dasturini o‘rnating va oching → email, parol, autentifikator kodi bilan kiring.
   Birinchi qurilma avtomatik tasdiqlanadi; keyingi qurilmalar “Xavfsizlik” bo‘limida
   tasdiqlanadi.
2. “Mijozlar” → yangi mijoz → litsenziya bering (kalit **bir marta** ko‘rsatiladi).
3. **Bitta sinov kompyuterida** mijoz dasturini o‘rnating → Litsenziya sahifasi →
   “Markaziy server bilan aloqa” → kalitni kiriting.
4. Owner’da qurilma “Onlayn” bo‘lishini, funksiyalarni o‘chirib-yoqishni, internetni
   uzib oflayn rejimni tekshiring.

## 7. Mavjud mijozlarni o‘tkazish (faqat 6-qadam muvaffaqiyatli bo‘lgach)

- Yangi versiyani mijozga yangilash orqali yuboring (yangilanish sahifasi).
- Har bir mijoz uchun yangi litsenziya kaliti bering; mijoz egasi uni Litsenziya
  sahifasiga kiritadi. Shundan keyingina u markaziy nazoratga o‘tadi.
- Eski litsenziya (GitHub gist) qaytarib olinmaydi: mijoz ulanmaguncha avvalgidek ishlaydi.

## 8. Zaxira va xavfsizlik

- Render’da bazaning avtomatik zaxirasi yoqilganini tekshiring.
- Owner → Xavfsizlik → “Zaxira nusxa va tiklashni tekshirish”ni vaqti-vaqti bilan bosing.
- Maxfiy kalit yo‘qolsa, mijozlarni qayta faollashtirish kerak bo‘ladi — uni xavfsiz
  nusxada saqlang (parol menejeri).
