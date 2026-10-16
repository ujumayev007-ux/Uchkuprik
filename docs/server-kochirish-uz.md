# Serverni Render'dan boshqa joyga ko‘chirish — oddiy qadamlar

> **Muhim:** bu hujjat hozir hech narsani o‘zgartirmaydi. Hozirgi server, manzil va
> litsenziyalar o‘z holicha ishlayveradi. Batafsil texnik tavsif: `docs/server-migration.md`.

## Eng muhim ogohlantirish

Render'dagi **bepul baza 14‑noyabr 2026 da o‘chadi**. Ko‘chirish yoki pullik bazaga o‘tish
shu sanadan oldin tugashi kerak. Zaxira nusxani hoziroq oling (4‑bo‘lim).

## Ko‘chirishda nimani saqlab qolish kerak

1. **Baza** — hamma litsenziyalar, qurilmalar, siyosatlar, Owner hisobi, auditlar shu yerda.
2. **`APP_SECRET_KEY`** — bir xil bo‘lishi shart. Boshqa bo‘lsa, berilgan litsenziya
   kalitlari tanilmay qoladi.
3. **`CONTROL_SIGNING_KEY`** — bir xil bo‘lishi shart. Boshqa bo‘lsa, barcha o‘rnatilgan
   kassalar qaytadan faollashtirilishi kerak bo‘ladi.
4. **Manzil** — yaxshisi o‘z domeningiz (masalan `control.sizning-domen.uz`).

Kalitlarni **hech qachon** chatga, pochtaga yoki GitHub'ga yubormang. Faqat parollangan
arxivda, shaxsan yoki `scp` orqali ko‘chiring. Ko‘chirgach arxivni o‘chiring.

Yuklangan fayllar alohida papkada saqlanmaydi: chek rasmlari va dalillar bazaning ichida,
shuning uchun baza zaxirasi hammasini o‘z ichiga oladi.

## 1. Hozir (xavfsiz, hech narsa buzilmaydi)

1. O‘z domeningizni oling (yoki mavjudidan `control.` pastki domenini ajrating).
2. Render'da **Settings → Custom Domains** orqali shu domenni hozirgi servisga ulang.
   Shundan keyin yangi manzil ham ishlaydi, eski ham.
3. Bundan keyin barcha yangi o‘rnatishlarga **faqat yangi domen** manzilini bering.

## 2. Yangi server tayyorlash (VPS)

1. Ubuntu 24.04 VPS oling. O‘rnating: PostgreSQL 17, Node.js 24, Caddy, git.
2. Kodni oling: `git clone <repozitoriy manzili> /opt/fastfood`, so‘ng
   `npm ci --include=dev && npm run build`.
3. `deploy/vps/fastfood.env.example` faylini `/etc/fastfood/fastfood.env` ga nusxalang va
   qiymatlarni **serverning o‘zida** to‘ldiring (`APP_SECRET_KEY` va `CONTROL_SIGNING_KEY` —
   eski serverdagi bilan bir xil).
4. `deploy/vps/fastfood.service`, `Caddyfile` va zaxira fayllarini joyiga qo‘ying
   (`docs/server-migration.md` 5‑bo‘lim).

## 3. Sinov nusxa (ishlab turgan serverga tegmasdan)

1. Eski bazadan zaxira oling (4‑bo‘lim) va yangi serverdagi **bo‘sh** bazaga tiklang.
2. Tekshiring:
   `node scripts/verify-server.mjs https://yangi.manzil --compare https://eski.manzil`
3. Hamma qatorda `OK` bo‘lishi kerak. Ayniqsa **«Imzo kaliti bir xil»** va
   **«APP_SECRET_KEY bir xil»** qatorlari. `XATO` chiqsa — to‘xtang, kalitlarni tekshiring.

## 4. Zaxira va tiklash

```
npm run backup -w backend -- create zaxira.ndjson.gz      # yaratadi va o‘zi tekshiradi
npm run db:migrate                                          # yangi bo‘sh bazada
npm run backup -w backend -- restore zaxira.ndjson.gz       # tiklaydi
```

Yangi serverda kunlik zaxira: `deploy/vps/fastfood-backup.timer`. Zaxira papkasini
**boshqa kompyuterga ham** ko‘chirib turing. Oyiga bir marta tiklashni sinab ko‘ring.

## 5. Bitta kassada sinov (pilot) — hammasidan oldin

Barcha mijozlarni birdan ko‘chirmang.

1. Bitta restoran, **bitta kassa** tanlang.
2. Shu kassada yangi manzilni kiriting: **Litsenziya → Markaziy server manzili → Manzilni
   almashtirish** (dastur yangi manzilni tekshiradi). Yoki
   `%APPDATA%\FastFood-Data\control-server.json` fayliga
   `{"url":"https://control.sizning-domen.uz"}` yozing.
3. Bir to‘liq ish kuni kuzating: Owner'da kassa «Onlayn», siyosat o‘zgarishi yetib keladi,
   buyurtma va to‘lov ishlaydi, litsenziya muddati o‘zgarmagan, yangi faollashtirish
   paydo bo‘lmagan.
4. Hammasi joyida bo‘lsa — keyingi bosqichga o‘ting.

## 6. Hammasini ko‘chirish (tinch soatda)

1. Mijozlarga oldindan xabar bering.
2. Oxirgi zaxirani oling → yangi bazaga tiklang → `verify-server.mjs` ni qayta ishga tushiring.
3. DNS ni yangi serverga o‘tkazing.
4. To‘lov tizimlarida (Click, Payme, Uzum) callback manzillarini yangisiga almashtiring
   (**To‘lovlar** sahifasida ko‘rsatilgan).
5. **Eski** serverda `CONTROL_RELOCATE_URL=https://yangi.manzil` qo‘ying. Hali eski manzildagi
   kassalar bir daqiqa ichida yangi manzilga **o‘zi** o‘tadi.
6. Owner panelida hamma qurilma yangi serverda «Onlayn» ekaniga ishonch hosil qiling. Eski
   serverni darhol o‘chirmang — bir necha kun saqlang.

## 7. Owner dasturida manzilni o‘zgartirish (qayta yig‘masdan)

**Owner → Server manzili…** menyusi. Yangi `https://` manzilni kiriting; dastur uning
FastFood serveri ekanini tekshiradi, tasdiq so‘raydi va qayta ishga tushadi. Qurilma kaliti va
tasdiqlangan qurilma saqlanib qoladi.

## 8. Orqaga qaytish

- DNS ni o‘zgartirishdan oldin: yangi serverni to‘xtating — hech narsa buzilmaydi.
- DNS dan keyin: DNS ni eski serverga qaytaring (eski server va uning bazasi saqlangan bo‘lsin).
- Alohida kassani qaytarish: Litsenziya → Markaziy server manzili.
- Eski baza va kalitlarni yangi server bir to‘liq to‘lov davri ishlab, zaxiralari muvaffaqiyatli
  tiklangunicha **o‘chirmang**.

## Nima tekshirilmagan

`deploy/vps/` fayllari (Caddy, systemd, zaxira) shu repozitoriyda haqiqiy VPS'da ishga
tushirilmagan. VPS'da `caddy validate` va `systemd-analyze verify` ni ishga tushiring, so‘ng
pilotdan boshlang.
