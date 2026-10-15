# Buyurtma sozlamalari — Owner uchun qo‘llanma

Barcha sozlamalar **Owner paneli → Mijozlar → (mijozni tanlang) → «Funksiyalar va oflayn siyosat»**
bo‘limida. Qidiruv maydoniga «chegirma», «mijoz», «TV», «ofitsiant» deb yozing — kerakli qator
topiladi. Qatordagi **▼ Qiymatlar va rollar** tugmasi rollar bo‘yicha qarorlar va
qiymatlarni ochadi.

## Qanday ishlaydi

- **Holat**: _Yoqilgan_ / _O‘chirilgan_ / _Admin hal qiladi_. «O‘chirilgan» — hech kimda
  ishlamaydi. «Admin hal qiladi» — restoran Admini Litsenziya sahifasida o‘zi
  tanlaydi (sonli chegaralarni faqat sizning qiymatingizdan **kamaytira** oladi).
- **Rollar bo‘yicha qaror**: «Umumiy qoida» / «Shu rolga yoqish» / «Shu rol uchun
  o‘chirish». Foydalanuvchida bir nechta rol bo‘lsa, ruxsat berilgan roli hisobga olinadi.
- Sozlamalar qurilma serverga ulangan zahoti (taxminan 1 daqiqa ichida) kuchga kiradi;
  ochiq ekranlar o‘zi yangilanadi. Aloqasiz qolgan qurilma oldingi ruxsatnomasini qayta
  ulanguncha saqlaydi.
- Barcha cheklovlar **serverda** tekshiriladi, ekrandagi tugmalarni yashirish yetarli emas.

## Sozlamalar ro‘yxati

| Guruh                 | Sozlama                               | Nima qiladi                                                                           |
| --------------------- | ------------------------------------- | ------------------------------------------------------------------------------------- |
| Buyurtma qabul qilish | Zalda / Olib ketish / Yetkazib berish | Buyurtma turlarini rollar bo‘yicha yoqadi yoki o‘chiradi                              |
| Buyurtma qabul qilish | «Mijoz» tugmasi                       | Kassir stolsiz buyurtma qabul qiladi («Stol belgilanmagan»)                           |
| Buyurtma qabul qilish | Stol belgilash va almashtirish        | Kassir va ofitsiant buyurtmani qayta yaratmasdan stol tanlaydi                        |
| Chegirmalar           | Foizli / Aniq summali                 | Chegirma turlari; **eng ko‘p foiz** va **eng ko‘p summa** rollar bo‘yicha             |
| Ko‘rinish va ekranlar | Buyurtmalar ko‘rinishi                | Standart rejim (ixcham / batafsil / kartalar); yoqilgan bo‘lsa xodim o‘zgartira oladi |
| Ko‘rinish va ekranlar | Mijozlar ekrani (TV)                  | Joylashuv, «tayyorlanmoqda» va «tayyor» ko‘rinishi                                    |
| Ko‘rinish va ekranlar | TV ovozli e’loni                      | Takrorlash, ovoz balandligi, gap shakli                                               |
| Ko‘rinish va ekranlar | Ofitsiant bildirishnomasi             | Signal, ovozli e’lon, balandlik, takrorlash, eslatma                                  |

## Android ilova (ofitsiant planshetlari)

1. APK ni o‘rnating va restoran kompyuteri manzilini kiriting.
2. Ofitsiant tizimga kirgach, ekranda «Ovozli xabarni yoqish» tugmasi chiqadi — bosib,
   Android so‘ragan bildirishnoma ruxsatiga **Ruxsat** bering.
3. Planshetda **quvvat tejash** rejimida ilovani cheklamang (Sozlamalar → Ilovalar →
   FastFood → Batareya → «Cheklovsiz»), aks holda ba’zi telefonlar ekran o‘chganda
   ulanishni to‘xtatadi.
4. Kassir «Mijoz» buyurtmasini yaratganda planshet signal beradi, «Yangi mijoz
   buyurtmasi. Stolni belgilang.» deb aytadi va bildirishnomada buyurtma raqami
   hamda «Stol belgilash» tugmasi chiqadi.

Planshetda o‘zbek ovozi (Google TTS → O‘zbek tili) o‘rnatilmagan bo‘lsa, ilova turk
ovozidan foydalanadi; ovoz umuman bo‘lmasa faqat signal va bildirishnoma ishlaydi.
