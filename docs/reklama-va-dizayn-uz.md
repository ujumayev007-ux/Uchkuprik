# Reklama va dizaynni masofadan boshqarish (Owner uchun)

Owner panelida ikkita yangi bo‘lim bor: **«Reklama boshqaruvi»** va **«Dizayn boshqaruvi»**. Ular
mavjud bo‘limlarni (Umumiy, Mijozlar, Qurilmalar, Yangilanishlar, Xavfsizlik, Audit) o‘zgartirmaydi.
Hech bir mijoz ma’lumoti, litsenziya, chek, printer yoki hisobot o‘zgarmaydi.

## Reklama boshqaruvi

**Yangi reklama** tugmasi orqali yaratiladi:

- **Turi:** matn, rasm/banner yoki video (rasm 3 MB gacha, video 20 MB gacha). Fayl turi nomiga
  qarab emas, **mazmuniga qarab** tekshiriladi; SVG, HTML va skriptlar qabul qilinmaydi.
- **Ko‘rinishi:** butun ekran, oyna (popup) yoki kichik banner.
- **Qaysi panellarda:** Admin, Kassa, Ofitsiant, Oshxona, Mijoz (bir nechtasini tanlash mumkin).
- **Kimga:** barcha restoranlarga yoki faqat tanlanganlarga.
- **Jadval:** boshlanish va tugash vaqti, ko‘rsatish davomiyligi, avtomatik yopilish, yopish tugmasi.
- **Takrorlash:** «har necha daqiqada» (0 = shu qurilmada faqat bir marta) va «kuniga ko‘pi bilan».
- **Darhol yuborish** yoki **qoralama** sifatida saqlash. Yoqish, to‘xtatish, tahrirlash va o‘chirish
  istalgan vaqtda mumkin (o‘chirish tasdiq so‘raydi).

### Reklama qanday yetib boradi

- Internet orqali ulangan (hosting) restoranlarda: ochiq ekranlarga **darrov** (Socket.io).
- Kassa kompyuteriga o‘rnatilgan restoranlarda: **bir daqiqa ichida** (imzolangan aloqa bilan),
  dasturni qayta ishga tushirish shart emas. Fayllar bir marta yuklab olinib, kompyuterda saqlanadi
  va internet uzilganda ham ko‘rsatiladi.
- Reklama kimgadir yuborilganmi, qancha ko‘rsatilgani va yopilgani «Statistika» tugmasida
  restoranlar bo‘yicha ko‘rinadi.

### Ishga xalaqit bermaslik qoidalari

- **To‘lov oynasi ochiq bo‘lsa**, **savatda taom bo‘lsa** (sotuv davom etayotganda), **chek chop
  etilayotganda** yoki boshqa oyna ochiq bo‘lsa — butun ekran va popup reklamalar chiqmaydi,
  chiqib turgani bo‘lsa darhol yopiladi.
- Ekran 5 soniya tinch turgandan keyingina chiqadi.
- **Oshxonada** faqat kichik banner ko‘rsatiladi (hech qachon butun ekran yoki popup emas).
- Restoran uchun reklamani butunlay o‘chirish: mijoz sozlamalarida «Dizayn va reklama» →
  «Reklama va e’lonlarni ko‘rsatish» ni o‘chiring.

## Dizayn boshqaruvi

Oltita uslub: **Klassik Fast Food** (hozirgi to‘q sariq-oq), **Premium qora** (qora-oltin),
**Zamonaviy ko‘k**, **Zumrad yashil**, **Minimal yorug‘**, **Hashamatli restoran** (bordo-oltin).
Hammasi telefon, planshet, 1024×600 POS va kompyuter ekranlariga moslashgan. Kirish usullari
(biznes kodi + login + parol, PIN) o‘zgarmaydi.

- **Barcha restoranlar uchun** yoki **alohida restoran uchun** uslub tanlang. Alohida restoranda faqat
  o‘zgartirgan joylaringiz saqlanadi, qolgani umumiy dizayndan olinadi.
- Har bir panel (Admin, Kassa, Ofitsiant, Oshxona, Mijoz) uchun **alohida** uslub va shu panel
  dasturida chiqadigan kirish ekrani uslubi.
- Kirish ekrani: fon rasmi, logotip, asosiy rang va xush kelibsiz xabari. Yuklanish (splash) ekrani:
  sarlavha, izoh va logotip.
- **Standart dizaynga qaytarish** — tanlangan qatlamni o‘chiradi (oldingi umumiy yoki klassik dizayn
  qaytadi); mijoz ma’lumotlari o‘zgarmaydi.
- O‘zgarish dasturni qayta o‘rnatmasdan kuchga kiradi, qurilma xotirasida saqlanadi va qayta
  ishga tushgandan keyin ham, internet bo‘lmaganda ham saqlanib qoladi.

### Restoran Admini uchun cheklangan ruxsat

Mijoz sozlamalarida «Dizayn va reklama» → **«Restoran Admini o‘z dizaynini sozlay oladi»** ni
yoqsangiz, Adminda «Dizayn» bo‘limi paydo bo‘ladi. U faqat kirish ekrani uslubi, logotip, xush
kelibsiz xabari, asosiy rang va panel uslublarini o‘zgartira oladi; fon rasmi va yuklanish ekrani
Ownerda qoladi. Admin o‘z tanlovini o‘chirsa, Owner belgilagan dizayn qaytadi. Ruxsatni o‘chirsangiz,
Adminning tanlovi to‘xtatiladi (saqlanadi, lekin qo‘llanmaydi).

## Xavfsizlik va audit

- Hamma narsa serverda tekshiriladi: reklama va dizaynni faqat SUPER_OWNER boshqaradi; restoranlar
  bir-birining dizayni va reklamasini ko‘rmaydi.
- Barcha o‘zgarishlar auditga eski va yangi qiymatlari bilan yoziladi (Owner auditida va, Admin
  o‘zgartirsa, restoranning o‘z auditida).
- Umumiy dizayn va reklamani o‘chirish parol va kod bilan qayta tasdiqlashni talab qiladi.

## Tekshirilgan va tekshirilmagan

**Avtomatik tekshirilgan (kompyuterda):** fayl turini tekshirish, reklama va dizayn qatlamlari,
maqsadli yuborish va restoranlar izolyatsiyasi, Admin ruxsati, hisoblagichlar, o‘rnatilgan
restoranga imzolangan yetkazish va oflayn nusxa, oltita uslub 4 ta ekran o‘lchamida, ochiq ekranda
jonli yangilanish, to‘lov/savat vaqtida reklama chiqmasligi, oshxonada faqat banner.

**Qurilmada tekshirilmagan:** Android'da reklama va uslublar ko‘rinishi, haqiqiy POS terminali
ekranlari, haqiqiy mijoz kompyuterida uzoq muddatli ishlash.
