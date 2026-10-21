# Zaxira nusxasidan o‘tishni tekshirish vositalari

Maqsad: mijozning **haqiqiy zaxira nusxasi** ustida (asl papkaga tegmasdan) 1.14.x ga o‘tish ma’lumotni yo‘qotmasligini isbotlash. Natija va topilmalar: `docs/MIGRATION-1.2.0-TO-1.14.7-uz.md`.

| Fayl           | Vazifa                                                                                                                              |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `manifest.mjs` | Papkaning SHA-256 nazorat ro‘yxati; `verify` bilan o‘zgarmaganini tekshirish                                                        |
| `snap.mjs`     | `pgdata` nusxasida PostgreSQL ochib, har bir jadval va har bir qatorning barmoq izini yozish (`--ref` bilan eski ustunlar bo‘yicha) |
| `cmp-snap.mjs` | Ikki barmoq izini solishtirish: yo‘qolgan yoki o‘zgargan qator = MUAMMO                                                             |
| `treecmp.mjs`  | Ikki papka daraxtini solishtirish (masalan, ichki zaxira va asl `pgdata`)                                                           |

Tartib (hammasi nusxada):

1. `node manifest.mjs <zaxira>\FastFood-Data manifest.json`
2. `node snap.mjs <zaxira>\FastFood-Data before.json`
3. Zaxiraning **ikkinchi nusxasida** 1.14.x TEST nusxasini ishga tushiring: `FASTFOOD_DATA_DIR`, `FASTFOOD_PORT`, `FASTFOOD_PG_PORT` va `FASTFOOD_VENDOR_DIR` (bo‘sh papka) bering; tayyor bo‘lgach oynani yoping.
4. `node snap.mjs <nusxa>\FastFood-Data after.json --ref before.json`
5. `node cmp-snap.mjs before.json after.json --volatile sessions,audit_logs`
6. `node manifest.mjs verify <zaxira>\FastFood-Data manifest.json`: zaxira o‘zgarmagan bo‘lishi shart.

Ogohlantirish: ishlab chiqarish (CONTROL_URL o‘rnatilgan) nusxasini sinov nusxasida ishga tushirmang: u haqiqiy markazga ro‘yxatdan o‘tadi. TEST nusxasi ishlating.
