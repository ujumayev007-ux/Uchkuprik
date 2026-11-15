# Admin (Render) ↔ Kassa ikki tomonlama sinxronlash — tekshiruv va loyiha

Holat: **loyiha hujjati**. Kod yozilmagan, deploy qilinmagan. Sana: 2026-11-15.

## 1. Maqsad

- Admin EXE Render'dagi markaziy backendga ulanadi va Kassa kompyuteri o‘chiq bo‘lsa ham ishlaydi.
- Kassa o‘z bazasi bilan oflayn ishlaydi va Render bilan sinxronlanadi.
- Ofitsiant, Oshxona va TV avvalgidek Kassa serveriga LAN orqali ulanadi.
- Ikki tomonda bir xil buyurtmalar, ombor, Bozorlik, xodimlar, sozlamalar va hisobotlar bo‘ladi. Dublikat ham, yo‘qolgan ma'lumot ham bo‘lmasligi kerak.

## 2. Hozirgi arxitektura (tekshirildi)

| Qism | Holat |
|---|---|
| Kassa serveri (FastFood Server EXE) | O‘z ichki PostgreSQL bazasi (`%APPDATA%\FastFood-Data\pgdata`), `SELF_HOSTED=true`, LAN beacon 47870 |
| Render: `fastfood-control.onrender.com` | Ishlayapti (`/api/health/live` → versiya `e503ab5` = `origin/main`). `CONTROL_PLANE`: Owner, litsenziya, qurilmalar, workflow, masofaviy buyruqlar. **Hosted** tenantlarni ham yurita oladi (`control_customers.tenantId`) |
| Render: `uchkuprikfastfood.onrender.com` | 2026-11-15 da 90 soniyada javob bermadi (to‘xtatilgan yoki uxlab yotgan) |
| Kassa → markaz sinxroni | Faqat `sync_operations` outbox orqali `daily_summary`, `ad_stats`, `offline_event`, `audit_event`, `license_event`. Imzolangan qurilma kanali: `POST /control/device/sync` (Ed25519, `seq` replay himoyasi) |
| Biznes ma'lumotlari replikatsiyasi | **Yo‘q.** Buyurtma, ombor, Bozorlik, xodim va sozlamalar faqat Kassa bazasida |

Xulosa: hozirgi deploy Admin'ni "Kassa o‘chiq bo‘lsa ham shu restoran ma'lumotlari bilan" ishlata olmaydi. Admin Render'ga ulansa, u hosted tenant ma'lumotlarini ko‘radi, Kassa bazasini emas.

## 3. Tasdiqlangan to‘siqlar (kod bilan tekshirildi)

1. **PIN va shifrlash kalitlari serverga bog‘langan.**
   - `backend/src/lib/crypto.ts`: `pinKey = derive('fastfood/pin-pepper/v1')` va `encryptionKey` har bir serverning `APP_SECRET_KEY` kalitidan olinadi.
   - Foydalanuvchini nusxalash Render'da PIN bilan kirishni ishlatmaydi.
   - Shifrlangan maydonlar (`mfaSecretEnc`, to‘lov va Telegram sozlamalari) boshqa serverda ochilmaydi.
2. **BigInt autoincrement kalitlar.**
   - `stock_movements`, `order_events`, `audit_logs` va `loyalty_entries` jadvallarida ikkala server 1, 2, 3… yaratadi va ID'lar to‘qnashadi.
   - Ombor sinxroni uchun `stock_movements` asosiy jadval.
3. **Hisoblanadigan (agregat) jadvallar.**
   - `stock_balances` (miqdor va o‘rtacha tannarx harakatlardan kelib chiqadi), `order_counters` (kunlik buyurtma raqami), nasiya va ta'minotchi qoldiqlari.
   - "Oxirgi yozuv yutadi" qoidasi bilan ko‘chirilsa, bir tomonning o‘zgarishi yo‘qoladi.
4. **Render'da superuser yo‘q.**
   - `session_replication_role` orqali FK tekshiruvini o‘chirib bo‘lmaydi.
   - O‘zgarishlarni ota-bola tartibida qo‘llash kerak.
5. **Tenantsiz jadvallar.** 138 modeldan 33 tasida `tenantId` yo‘q (`order_counters`, `branding_*`, `control_*`…). Restoranlarni ajratish har bir jadval uchun alohida qoidani talab qiladi.
6. **Render'ga kirish.**
   - Bu sessiyada Render API/MCP avtorizatsiya qilinmagan.
   - Tarif, baza hajmi va zaxira nusxasini tekshirib bo‘lmadi.
   - Prod bazaga migratsiyadan oldin tasdiqlangan zaxira nusxa shart.

## 4. Taklif etilgan yechim

**Topologiya: hub va spoke.**
- Render'dagi mavjud servis (`fastfood-control`, ikkinchi baza ham, yangi servis ham ochilmaydi) — restoranning **hub** nusxasi: `control_customers.tenantId` = Kassa tenantining o‘sha UUID'i.
- Kassa serveri — **spoke**: to‘liq lokal baza, oflayn ishlaydi.
- Ofitsiant, Oshxona va TV faqat Kassa'ga ulanadi.
- Admin Terminal Render'ga (`https://…`) ulanadi.

**O‘zgarishlarni yig‘ish.**
- Har bir replikatsiya qilinadigan jadvalda trigger o‘zgarishni `replication_changes` jadvaliga yozadi: `seq`, `tenantId`, jadval, kalit, amal (insert/update/delete), qator JSON, vaqt, manba.
- Boshqa tomondan kelgan o‘zgarish qo‘llanayotganda trigger yozmaydi (`ff.applying`), shuning uchun aks-sado bo‘lmaydi.

**Uzatish.**
- Mavjud imzolangan qurilma kanali yangi turga kengaytiriladi: `replicate` (push va pull bitta so‘rovda).
- Kassa navbatdagi o‘zgarishlarni yuboradi va o‘zidan keyingi hub o‘zgarishlarini oladi.
- Kursor faqat tasdiqdan keyin suriladi: internet uzilsa navbat saqlanadi, takror yuborish dublikat yaratmaydi.

**Qo‘llash qoidalari** (jadvallar sinflarga bo‘linadi):

| Sinf | Jadvallar (misol) | Qoida |
|---|---|---|
| Faqat qo‘shiladigan | buyurtma qatorlari, to‘lovlar, ombor harakatlari, xarid qatorlari, audit | Faqat insert; global UUID; to‘qnashuv yo‘q |
| O‘zgaruvchan | menyu, xodimlar, sozlamalar, ta'minotchilar, ombor mahsulotlari | Qator darajasida "oxirgi yozuv yutadi" (`replication_rows`: vaqt + manba); ikkala tomon bir xil natijaga keladi |
| Hisoblanadigan | `stock_balances`, nasiya qoldiqlari | Ko‘chirilmaydi; qo‘llangan harakatlardan ikkala tomonda qayta hisoblanadi |
| Raqamlash | `order_counters` | Buyurtma faqat Kassa'da raqamlanadi. Render'da yaratilgan buyurtma (onlayn) alohida prefiks oladi |
| Ko‘chirilmaydi | sessiyalar, `control_*`, `sync_operations`, keshlar | — |

**Xavfsizlik.**
- Hub har bir kelgan qatorda `tenantId === customer.tenantId` ekanini tekshiradi. Boshqa restoran qatori rad etiladi.
- Litsenziya to‘xtatilsa, sinxron ham to‘xtaydi.
- Qurilmani tasdiqlash avvalgidek ishlaydi.
- **Kalitlar:**
  - tenant uchun alohida "restoran kaliti" (PIN pepper + shifrlash) yaratiladi;
  - u Owner tasdig‘i bilan markaz orqali faqat shu restoran serverlariga shifrlangan holda tarqatiladi;
  - eski PIN'lar xodim keyingi marta kirganda yangi kalit bilan qayta hash qilinadi, PIN'ni hech kim bilmasdan.

## 5. Bosqichlar

| # | Ish | Prod ta'siri | Tasdiq kerak |
|---|---|---|---|
| 0 | Render kirish (MCP `/mcp` avtorizatsiya), tarif va baza hajmi, prod zaxira nusxa + tiklash sinovi | Yo‘q | Render kirish |
| 1 | `stock_movements`, `order_events`, `loyalty_entries` (+`audit_logs`) uchun global UUID ustuni. Faqat qo‘shiladigan migratsiya: eski ID saqlanadi | Additiv migratsiya | Ha |
| 2 | Restoran kaliti: PIN pepper va shifrlashni tenant kalitiga o‘tkazish (moslik rejimi bilan) | Additiv | Ha |
| 3 | Dvigatel: trigger, `replication_changes`/`rows`, `replicate` kanali, qo‘llash qoidalari, ikki bazali integratsiya testlari (Kassa o‘chiq; ikkalasi birga; oflayn navbat; dublikat; boshqa restoran rad etiladi) | Yo‘q (bayroq o‘chiq) | Yo‘q |
| 4 | Boshlang‘ich yuklash: Kassa bazasi → hub (bir martalik, bo‘laklab, tekshiruv summasi bilan) | Hub'ga yozadi | Ha |
| 5 | Admin Terminal → Render; sinov restoranida 1–2 hafta parallel ishlatish | — | Ha |
| 6 | Asosiy restoranda yoqish | — | Ha |

## 6. Hozir nima ishlaydi

- Kassa serveri va LAN terminallari 1.15.9 (`D:\FastFood\RELEASE-FIXED`), Bozorlik tuzatishlari bilan.
- Admin Terminal Kassa o‘chiq bo‘lganda **ishlamaydi**: bu 3–5-bosqichlarsiz mumkin emas.
