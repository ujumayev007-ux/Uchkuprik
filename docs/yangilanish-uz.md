# Yangilanish: oddiy qo‘llanma (2026-10)

Bu yo‘riqnoma sotuvchi (Owner) va restoran xodimlari uchun. Texnik tafsilotlar: `docs/upgrade-2026-10.md`.

## Qaysi faylni kimga yuborasiz

| Fayl                                 | Kimga                                               |
| ------------------------------------ | --------------------------------------------------- |
| `FastFood-Setup-1.14.4.exe`          | Restoranning server kompyuteriga (kassa)            |
| `FastFood-Admin-Setup-1.4.0.exe`     | Egasi/boshqaruvchi                                  |
| `FastFood-Kassa-Setup-1.4.0.exe`     | Qo‘shimcha kassalar                                 |
| `FastFood-Oshxona-Setup-1.4.0.exe`   | Oshxona                                             |
| `FastFood-Ofitsiant-Setup-1.4.0.exe` | Ofitsiant kompyuteri                                |
| `FastFood-TV-Setup-1.4.0.exe`        | Mijoz ekrani (TV/HDMI)                              |
| `FastFood-Owner-Setup-1.8.0.exe`     | **Faqat o‘zingizga** (sotuvchi) — mijozga yubormang |

Eslatma: avval **server** o‘rnatiladi, keyin boshqa ilovalar. Hamma ilova serverni o‘zi topadi.

## Yangi mijoz: birinchi ishga tushirish va sinov

1. Mijoz serverga `FastFood-Setup` ni o‘rnatadi va ochadi.
2. Dastur o‘zini markazga yozdiradi. Owner'da **Hodisalar** bo‘limida yangi qator va qizil raqam chiqadi
   («Yangi o‘rnatish: …»). Owner yopiq bo‘lsa ham hodisa saqlanadi, keyin ochganda ko‘rasiz.
3. **Yangi** o‘rnatishga **72 soatlik sinov** o‘zi beriladi. Sinov dastur markazga birinchi marta
   ulangan paytdan boshlanadi va aniq 72 soatdan keyin tugaydi. Qayta o‘rnatish, qayta yoqish, soatni
   orqaga surish sinovni yangilamaydi. Bitta restoranning barcha ilovalari bitta sinovni bo‘lishadi.
4. Sinovdan keyin ham **ma’lumotlar saqlanadi**; yangi buyurtma uchun litsenziya kerak. Hisobotlarni
   Excel/Word/PDF qilib olish mumkin.
5. Litsenziya berish: Owner → **Ro‘yxatdan o‘tganlar** → o‘rnatishni tanlang → **Mijozga biriktirish**
   → «Litsenziya (oy)». Sinovdan pullik litsenziyaga o‘tkazish ma’lumotni yo‘qotmaydi (Owner → Mijozlar →
   litsenziyani uzaytirish).
6. Eski (allaqachon litsenziyali) mijozlar yangilangach **sinovga o‘tmaydi**: ular «Kutilmoqda» ro‘yxatida
   ko‘rinadi, litsenziyasi o‘zgarmaydi. Xohlasangiz mijozga biriktirasiz.
7. Avtomatik sinovni o‘chirish yoki soatini o‘zgartirish: **Ro‘yxatdan o‘tganlar** → «Avtomatik sinov».

## Faqat restoran tarmog‘i

Ilovalar faqat restoranning o‘z Wi‑Fi/LAN tarmog‘ida ishlaydi. Boshqa Wi‑Fi yoki mobil internetdan kirishga
urinsa: «Bu qurilma restoranning ruxsat etilgan tarmog‘ida emas». Yechim: restoran tarmog‘iga ulaning.

**Istisno (faqat Owner):** Mijozlar → mijoz → **Siyosat** → «Tarmoq: faqat restoran tarmog‘i»: necha kun,
qaysi rollar va sabab yozing → «Istisno berish». Bu vaqtincha (1–90 kun), auditga yoziladi va **tizimga
kirish (login/PIN) baribir shart**. Bekor qilish: «Istisnoni bekor qilish». Internetsiz serverga bekor
qilish aloqa tiklangach yetadi; muddat tugashini server o‘zi tekshiradi. Restoran administratori buni
yoqa olmaydi.

Muhim cheklov: dastur Wi‑Fi nomini tekshirmaydi (u ishonchsiz). Himoya serverga **ulanish manzili** orqali.
To‘liq jismoniy ajratish uchun routerda «mehmon tarmog‘i» va port yo‘naltirish **o‘chiq** bo‘lishi kerak.

## Hisobotlar: Excel, Word, PDF

**Hisobotlar** sahifasi → «Hisobotni faylga yuklab olish». Sana oralig‘ini tanlang. Uchala fayl bir xil
ma’lumotdan tuziladi. «Hisobot ko‘rinishi» (administrator): qaysi bo‘lim va ustun ko‘rinishi, tartibi.
Bu faqat ko‘rinish: ruxsati yo‘q xodim baribir ko‘ra olmaydi. Ombor qoldiqlari va harakatlari ham bor.

## Ombor ogohlantirishlari

Qoldiq minimal darajadan pasaysa, yuqoridagi 📦 belgisida raqam, oynada xabar va qisqa ovoz chiqadi.
**Ko‘rdim** bosilsa, eslatma to‘xtaydi. Qoldiq ko‘paysa ogohlantirish o‘zi yopiladi. Sozlamalar (ovoz,
«juda kam» foizi, eslatma oralig‘i) shu oynada. Ovozni faqat shu kompyuterda o‘chirish mumkin.

## Mijoz ekrani (TV)

`FastFood-TV` ni kassa kompyuteriga o‘rnating, HDMI orqali ikkinchi ekranni ulang. Dastur navbatni
**ikkinchi ekranga** to‘liq ekranda chiqaradi, kassa asosiy monitorda ishlayveradi. Kirish uchun
**«Mijoz ekrani (TV)»** rolli xodim yarating (faqat navbatni ko‘radi). Ekranni almashtirish: menyu → **Ekran**.
Aloqa uzilsa, ekranda qizil ogohlantirish chiqadi.

## Muammo bo‘lsa

- Kassa/Admin serverni topmasa: serverda **FastFood → Avtomatik ulanish** da «Tarmoq ruxsati: berilgan» ekanini
  tekshiring.
- Eski versiyani **o‘rnatmang** (masalan 1.8.0 ustiga 1.14.x): kerak bo‘lsa yangi versiyani qayta o‘rnating,
  ma’lumot yo‘qolmaydi.
- Zaxira: `Desktop` dagi zaxira papkasi va dasturning o‘zi olgan `backups` papkasi. Ortga qaytarish uchun
  zaxira va dastur **bir vaqtdagi** bo‘lishi kerak.
