# Restoran ilovalari: qaysi fayl qayerga o‘rnatiladi

Bir restoranda bitta **server kompyuter** bo‘ladi: unda baza va hamma ma’lumot turadi. Qolgan
qurilmalar shu serverga Wi‑Fi orqali ulanadi. Hamma ilova bitta serverga ulangani uchun
buyurtmalar, to‘lovlar va oshxona holatlari darrov hamma joyda bir xil ko‘rinadi.

| Fayl                                 | Qayerga                                    | Nima qiladi                                                                           |
| ------------------------------------ | ------------------------------------------ | ------------------------------------------------------------------------------------- |
| `FastFood-Setup-1.14.2.exe`          | **Server kompyuter** (odatda kassa)        | Server, baza, Kassa, Ofitsiant va Oshxona panellari. Litsenziya shu yerda kiritiladi. |
| `FastFood-Kassa-Setup-1.2.0.exe`     | Qo‘shimcha kassa kompyuterlari             | Faqat Kassa. Serverga ulanadi, PIN bilan ochiladi.                                    |
| `FastFood-Ofitsiant-Setup-1.2.0.exe` | Ofitsiant kompyuter/planshetlari (Windows) | Faqat Ofitsiant ekrani.                                                               |
| `FastFood-Admin-Setup-1.2.0.exe`     | Egasi/boshqaruvchi kompyuteri              | Boshqaruv paneli: xodimlar, menyu, printer, hisobot.                                  |
| `FastFood-1.13.0.apk`                | Ofitsiant telefonlari (Android)            | Ofitsiant ekrani va yangi buyurtma xabarlari.                                         |

## Birinchi ishga tushirish

1. Server kompyuterga `FastFood-Setup` ni o‘rnating, litsenziya kalitini kiriting, restoran
   egasi va xodimlarni yarating.
2. Server kompyuterning Wi‑Fi manzilini toping (`ipconfig` → IPv4, masalan `192.168.1.17`).
3. Qolgan qurilmalarda ilovani oching va shu manzilni bir marta yozing. Dastur tekshirib saqlaydi;
   keyin manzil qayta so‘ralmaydi. Manzilni keyinroq menyudan («Server manzili…») o‘zgartirish mumkin.
4. Kirish: biznes kodi, login va parol (birinchi marta). Keyin **Admin → Qurilmalar** bo‘limida
   qurilmani ro‘yxatdan o‘tkazing: shundan keyin Kassa va Ofitsiant ilovalari to‘g‘ridan-to‘g‘ri
   **4 xonali PIN** oynasini ochadi.

## Eslatmalar

- Ruxsatlar va cheklovlar (qaysi tugma, qaysi ekran, nechta xodim) Owner tomonidan serverda
  belgilanadi; ilova ularni faqat ko‘rsatadi.
- Barcha ilovalar raqamli imzosiz: Windows «Noma’lum nashriyotchi» desa «Baribir ishga tushirish»
  ni bosing; antivirus o‘chirib yuborsa, papkani ishonchli ro‘yxatga qo‘shing.
- Wi‑Fi'da serverni **avtomatik topish** hali yo‘q: manzil qo‘lda yoziladi.
