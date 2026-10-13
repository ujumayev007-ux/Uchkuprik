# EXE (Windows) va APK (Android)

## Qanday ishlaydi

- **FastFood-Setup-X.Y.Z.exe** restoran kompyuteriga o‘rnatiladi. Ichida server va PostgreSQL bazasi bor, internet shart emas.
- **Ma’lumotlar** `%APPDATA%\FastFood-Data` papkasida turadi (baza, kalitlar, jurnallar, zaxiralar). U o‘rnatish papkasidan tashqarida, shuning uchun versiyani o‘chirish yoki yangilash ma’lumotlarga tegmaydi.
- **Versiyalar yonma-yon**: har bir versiya o‘z papkasiga (`FastFood 1.0.0`, `FastFood 1.1.0` …) va o‘z yorlig‘i bilan o‘rnatiladi. Eski versiyani ham ochish mumkin; hammasi bitta umumiy bazadan foydalanadi. Bir vaqtning o‘zida bitta server ishlaydi: ikkinchi versiya ochilsa, u ishlab turgan serverga ulanadi.
- **Yangilashdan oldin zaxira**: yangi versiya baza tuzilishini o‘zgartirishi kerak bo‘lsa, avval bazaning to‘liq nusxasi `FastFood-Data\backups` ga olinadi (oxirgi 5 tasi saqlanadi).
- **APK** telefon/planshet uchun. Telefon kompyuter bilan bir Wi‑Fi’da bo‘lishi kerak. Birinchi ochilganda kompyuter manzili kiritiladi (kompyuterda: menyu **FastFood → Telefonlar uchun manzil**). Ekranlar kompyuterdan yuklanadi, shuning uchun EXE yangilansa telefonlardagi dastur ham yangilanadi. APK’ni telefonga kompyuterdan yuklab olish mumkin: `http://<kompyuter-manzili>:8787/downloads/FastFood.apk`.
- APK’ning har bir versiyasi ham telefonga alohida ilova sifatida o‘rnatiladi (`FastFood 1.0.0`, `FastFood 1.1.0`).

## Birinchi ishga tushirish

1. EXE’ni o‘rnating va oching. Windows “tarmoqqa ruxsat” so‘rasa — **Ruxsat berish** (telefonlar ulanishi uchun).
2. Kirish sahifasida **“Biznesingiz uchun hisob ochish”** — biznes nomi, identifikator, login va parol. Bu o‘rnatishda tarif va to‘lov yo‘q (cheklovsiz).
3. Xodimlar, menyu, stollarni kiriting. Telefonlarga APK o‘rnating va kompyuter manzilini kiriting.

## Yangi versiya chiqarish (dasturchi uchun)

1. `desktop/package.json` dagi `version` ni oshiring (masalan 1.1.0). EXE va APK shu raqamni oladi.
2. APK: `JAVA_HOME=<JDK 17+>` va `GRADLE_BIN=<gradle.bat>` bilan `node android/build-apk.mjs` → `android/release/FastFood-1.1.0.apk`. Imzo kaliti `%USERPROFILE%\.fastfood` da saqlanadi — uni yo‘qotmang.
3. EXE: `cd desktop && npm install && node build.mjs` → `desktop/release/FastFood-Setup-1.1.0.exe` (APK ichiga qo‘shiladi).
4. Baza o‘zgarishlari faqat qo‘shuvchi migratsiyalar bilan qilinadi; eski versiyalar yangi bazada ishlashda davom etadi.
