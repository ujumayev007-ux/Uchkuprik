# Bitta kassada sinov (pilot) — yangi imkoniyatlar va yangi server

Maqsad: hozirgi mijozlarga **tegmasdan**, bitta restoranning bitta kassasida yangi versiyani
va (keyinroq) yangi serverni sinab ko‘rish. Hozir hech bir mavjud mijoz ko‘chirilmaydi.

## Sinov paketlari (TEST kanali)

TEST paketlari ishlab turgan tizimdan **alohida**: o‘z ilova nomi, o‘z ma’lumotlar papkasi
(`FastFood-Test-Data`), o‘z portlari va **faqat sinov** markaziy serveriga
(`http://127.0.0.1:4100`) ulanadi. Ular haqiqiy litsenziya, Owner hisobi, kalit va bazaga
umuman ulanmaydi.

| Paket                                             | Fayl                                                             |
| ------------------------------------------------- | ---------------------------------------------------------------- |
| Umumiy kassa dasturi (Kassa+Ofitsiant+Oshxona)    | `desktop\release-test\FastFood-TEST-Setup-1.13.0.exe`            |
| Restoran Admin dasturi (sinov)                    | `admin-desktop\release-test\FastFood-Admin-TEST-Setup-1.1.0.exe` |
| Owner dasturi (sinov)                             | `owner-desktop\release-test\FastFood-Owner-TEST-Setup-1.5.0.exe` |
| Ofitsiant Android (sinov va ishchi uchun bir xil) | `android\release\FastFood-1.12.0.apk`                            |

**Sinov serverini ishga tushirish** (Owner dasturi shunga ulanadi; kompyuter qayta
yoqilsa, qayta ishga tushiring):

```
node scripts/test-control-plane.mjs setup     (faqat birinchi marta)
node scripts/test-control-plane.mjs start
node scripts/test-control-plane.mjs code      (Owner emaili, paroli va kirish kodi)
```

Server ishlamayotgan bo‘lsa, Owner dasturi «Markaziy serverga ulanib bo‘lmadi» sahifasini
ko‘rsatadi (Qayta urinish va Server manzili tugmalari bilan) va server yoqilgach o‘zi ulanadi.
Server uyg‘onayotgan paytda (hostingning sovuq ishga tushishi) Owner va Admin dasturlari
o‘zining «FAST FOOD» yuklanish ekranini ko‘rsatadi va server tayyor bo‘lgach o‘zi ochiladi;
hosting nomi yoki manzili oddiy ko‘rinishda chiqmaydi.

**Owner dasturida kirish.** Owner har doim pochta, parol va autentifikator kodini so‘raydi
(server buni talab qiladi). Qulaylik uchun dastur autentifikator kalitini **faqat shu
kompyuterda**, Windows himoyasi ostida eslab qolishi mumkin: kirish oynasidagi «Autentifikator
kaliti» maydoniga kalitni bir marta kiriting — keyingi kirishlarda kod o‘zi kiritiladi va faqat
parol yoziladi. Eslab qolishni oynadan o‘chirish mumkin.

**Reklama va dizayn.** Owner → «Reklama boshqaruvi» va «Dizayn boshqaruvi»: hujjat
`docs/reklama-va-dizayn-uz.md`.

Paketlar raqamli imzosiz: Windows birinchi ishga tushirishda «Noma’lum nashriyotchi»
ogohlantirishini ko‘rsatadi («Baribir ishga tushirish»). Fayl yaxlitligini SHA256 bilan
tekshirish mumkin (`Get-FileHash <fayl>`).

Sinov Owner hisobi va kalitlari faqat shu kompyuterdagi vaqtinchalik papkada, ishlab turgan
tizimdan butunlay alohida. Ularni ishlab turgan tizimga **ishlatmang** va hech qayerga
nusxalamang.

## Tartib

1. **Sinov serverini ishga tushiring** (sinov bazasi bilan) va Owner (sinov) dasturini
   o‘rnating. Sinov mijozi va litsenziyasini yarating.
2. **Mijoz (sinov)** dasturini bitta kompyuterga o‘rnating, litsenziya kalitini kiriting.
   Owner'da qurilma «Onlayn» bo‘lishi kerak.
3. Quyidagilarni bir to‘liq kun davomida tekshiring:
   - Kassa ekrani butun ekranni egallaydi, «To‘lov qilish» doim ko‘rinadi.
   - «Mijoz» buyurtmasi → ofitsiant → stol belgilash; stolni qayta ochganda buyurtma tiklanadi.
   - Chek dizayni: 58/80/maxsus kenglik, sinov chop etish, printerga biriktirish.
   - Mijozlar ekrani (TV): raqamlar №001 ko‘rinishida, silliq o‘zgaradi, ovozli e’lon.
   - Owner'da rol bo‘yicha o‘chirish/yoqish va limitlar kassada darrov ta’sir qiladi.
   - Internet uzilib qaytganda: ruxsat etilgan amallar ishlaydi, navbat tiklanadi.
   - Owner → «Dizayn boshqaruvi»: kirish ekrani uslubini almashtiring (6 ta) — kassa, ofitsiant va
     oshxona ekranlarida dasturni qayta ishga tushirmasdan o‘zgaradi.
   - Owner → «Reklama boshqaruvi»: banner va popup yuboring — savatda taom yoki to‘lov oynasi
     ochiq turganda chiqmasligini, oshxonada faqat banner chiqishini tekshiring.
4. **Server ko‘chirish bo‘yicha pilot** (faqat tayyor bo‘lgach): `docs/server-kochirish-uz.md`,
   5‑bo‘lim — shu bitta kassada manzilni yangi serverga almashtiring va bir kun kuzating.
5. Hammasi joyida bo‘lsa — ishchi (production) paketlarini yig‘ing va **shu bitta kassaga**
   o‘rnating. Boshqa kassalar va restoranlar o‘z holicha qoladi.

## Ishchi paketlarni yig‘ish (pilotdan keyin)

```
set CONTROL_URL=https://<haqiqiy-domen>
set CONTROL_PUBLIC_KEY=<ochiq kalit — control-public.json dagi qiymat>
node desktop\build.mjs
set OWNER_URL=https://<haqiqiy-domen>
node owner-desktop\build.mjs
node admin-desktop\build.mjs
```

Admin dasturi uchun `ADMIN_URL` ixtiyoriy (https): bo‘sh qoldirilsa, dastur birinchi ishga
tushganda restoran serveri manzilini o‘zi so‘raydi.

(PowerShell'da `$env:CONTROL_URL = "…"`.) Maxfiy kalitlar bu buyruqlarga kerak emas.

## Sinov dasturlari ishlab turgan dasturga tegmaydi

Sinov (TEST) mijoz dasturi alohida papkaga (`%LOCALAPPDATA%\Programs\FastFoodTest`),
alohida ma’lumotlar papkasiga (`FastFood-Test-Data`) va 8788‑portga o‘rnatiladi. Ishchi
FastFood (`%LOCALAPPDATA%\Programs\FastFood`, 8787‑port, `FastFood-Data`) o‘zgarmaydi.

## Restoran Admin dasturi

Admin dasturi restoran serveriga (kassa kompyuteri) ulanadi. Birinchi ishga tushganda manzilni
so‘raydi (masalan `192.168.1.11`, sinovda `127.0.0.1`) va uni tekshirib saqlaydi; keyinroq
menyudan «Server manzili…» orqali o‘zgartirish mumkin. Oddiy `http` faqat mahalliy tarmoq
manzillari uchun qabul qilinadi. Server o‘chiq bo‘lsa, o‘zbekcha xato sahifasi chiqadi va u
o‘zi qayta ulanadi.

## Pilotni to‘xtatish

Sinov dasturini o‘chirib, oddiy dasturga qaytish mumkin: ma’lumotlar papkalari bo‘lingan.
Ishchi kassada muammo bo‘lsa: Litsenziya → Markaziy server manzili orqali oldingi manzilga
qaytaring; litsenziya va qurilma o‘zgarmaydi.
