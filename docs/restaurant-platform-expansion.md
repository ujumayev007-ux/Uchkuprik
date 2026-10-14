# Restaurant platform expansion (1.6.0)

Additions on top of the existing order engine. Nothing was rebuilt; every feature
reuses the existing order, kitchen, printing, delivery, Telegram and licence modules.

## Order routing and printing

- Kitchen tickets are routed per station (department) to every active kitchen printer
  of that station; printers without a station receive everything.
- Tickets show waiter, version, time and notes; delivery orders get `! DOSTAVKA !`.
  Prices appear only when _Oshxona chekida narxlar_ is on.
- Changes after sending print `DIQQAT! CHEK YANGILANDI` with removed lines crossed out
  and new lines below, only to the affected stations. Printing is idempotent
  (`kitchenPrintedAt` / `cancelPrintedAt` set in the same transaction).
- A printer can have a fallback printer: after two failed attempts one copy is queued
  there (`print_jobs.fallbackFromId`).
- _Sozlamalar → Buyurtma jarayoni_: cashier confirmation of waiter orders (PENDING
  until a user with `payments.accept` approves), kitchen prices, waiter edits,
  staff cancellation, kitchen acknowledgement, delivery codes.

## Payments

Order status and payment status are independent; lists show both. "To‘lov qabul
qilish" becomes "To‘langan" after full payment. Payments stay idempotent and
immutable (database triggers).

## Kitchen display and customer TV

- KDS layout adapts (1 full screen, 2 side by side, 3–4 as 2×2, then grid); items
  are yellow while preparing and turn green with one tap; a ticket turns green when
  all its items are ready. Each station marks its own items.
- Customer TV: yellow "preparing" column with black numbers, green "ready" column,
  queued Uzbek announcements ("123-raqamli buyurtmangiz tayyor!").
- Voice settings are per device (female/male or exact system voice, volume,
  repeats, mute). Staff panels announce ready and updated orders.

## Editing and versions

- Quantity/note changes after sending replace the line (old line cancelled, new line
  added) so history stays immutable and the kitchen gets an update ticket.
- Cancelling or reducing sent items needs `orders.cancel` unless the restaurant
  enables staff cancellation. Items the kitchen is preparing need the cook's
  confirmation on the KDS or a manager override.
- `order.updated` realtime event: "N-sonli buyurtma yangilandi!".

## Delivery, Telegram and couriers

- Delivery orders carry a landmark; the courier handoff sheet (`/dostavka-varaqa/:id`)
  is the only printout with the customer's contact and address.
- Telegram bot ordering (menu, cart, own phone, pickup/delivery, confirm) works with
  webhooks (public HTTPS) or long polling (desktop). Orders arrive PENDING; only one
  employee can accept. Customers get stage messages and a one-time code.
- Two-stage verification: the courier shows a handoff code to the cashier; the
  customer gives the courier their private delivery code. Codes are 6 digits, stored
  as keyed HMACs, expire, allow 5 attempts and are single-use.
- Delivery statuses: Kuryer tayinlandi → Kuryerga topshirildi → Yo‘lda → Yetkazib
  berildi / Muammo / Qaytarildi (validated server-side). Cash on delivery is recorded
  separately and reconciled by the cashier; delivery never marks payment.

## Vendor (SUPER_OWNER) control

Per customer, from the vendor panel: features, menus, limits, blocking, locked order
settings (restaurant decides / forced on / forced off) and permissions switched off
for every user. Changes are signed into the licence and reach installs within
~10 minutes. Disabling never deletes data.

## Activity history

Audit rows now record the actor's session and roles; the audit page filters by
employee, order number, outcome and period. Audit logs, order events and payments are
append-only at database level.
