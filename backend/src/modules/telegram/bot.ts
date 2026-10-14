import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Services } from '../../context.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { upsertCustomer } from '../crm/loyalty.js';
import { emitWebhook } from '../developer/webhooks.js';
import { notifyOnlineOrder } from '../notifications/hooks.js';
import { telegramTransport } from '../notifications/notify.js';
import { publicMenu } from '../online/online.routes.js';
import { issueOrderCode } from '../orders/codes.js';
import {
  addEvent,
  businessDate,
  computeTotals,
  itemCreateData,
  nextOrderNumber,
  priceItems,
} from '../orders/engine.js';

/**
 * Customer ordering through the restaurant's own Telegram bot. The conversation runs
 * inside Telegram (menu -> cart -> phone -> pickup/delivery -> confirm), so it works
 * with long polling on self-hosted installs that have no public HTTPS address.
 * Orders arrive as PENDING (channel TELEGRAM) and are accepted by staff exactly
 * like online orders; prices always come from the server.
 */

const MAX_CART_LINES = 20;
const MAX_QTY = 20;
const MAX_PENDING_PER_CHAT = 3;

type Cart = { v: string; q: number }[];
type ChatState = {
  step?: 'idle' | 'phone' | 'type' | 'address' | 'confirm';
  cart?: Cart;
  type?: 'TAKEAWAY' | 'DELIVERY';
  address?: string;
  // Idempotency key of the checkout in progress (double taps create one order).
  nonce?: string;
};

const updateSchema = z.object({
  update_id: z.number(),
  message: z
    .object({
      message_id: z.number().optional(),
      text: z.string().max(1000).optional(),
      chat: z.object({ id: z.union([z.number(), z.string()]) }),
      from: z
        .object({
          id: z.number(),
          first_name: z.string().max(200).optional(),
        })
        .optional(),
      contact: z
        .object({
          phone_number: z.string().max(30),
          user_id: z.number().optional(),
        })
        .optional(),
      location: z
        .object({ latitude: z.number(), longitude: z.number() })
        .optional(),
    })
    .optional(),
  callback_query: z
    .object({
      id: z.string(),
      data: z.string().max(64).optional(),
      from: z.object({ id: z.number(), first_name: z.string().optional() }),
      message: z
        .object({ chat: z.object({ id: z.union([z.number(), z.string()]) }) })
        .optional(),
    })
    .optional(),
});
export type TelegramUpdate = z.infer<typeof updateSchema>;

const money = (value: number) =>
  `${value.toLocaleString('en-US').replace(/,/g, ' ')} so‘m`;

const MAIN_KEYBOARD = {
  keyboard: [
    [{ text: '🍔 Menyu' }, { text: '🛒 Savat' }],
    [{ text: '📦 Buyurtmalarim' }],
  ],
  resize_keyboard: true,
};

type Button = { text: string; callback_data: string };
const rows = (buttons: Button[], perRow = 2) => {
  const out: Button[][] = [];
  for (let i = 0; i < buttons.length; i += perRow)
    out.push(buttons.slice(i, i + perRow));
  return out;
};

export async function telegramApi(
  services: Services,
  token: string,
  method: string,
  body: object,
) {
  const transport = services.telegram ?? telegramTransport;
  if (transport.api) return transport.api(token, method, body);
  if (method === 'sendMessage') {
    const payload = body as { chat_id: string; text: string };
    await transport.send(token, String(payload.chat_id), payload.text);
  }
  return null;
}

async function loadBot(services: Services, tenantId: string) {
  const config = await services.db.telegramConfig.findUnique({
    where: { tenantId },
  });
  if (!config || !config.isActive) return null;
  const tenant = await services.db.tenant.findUnique({
    where: { id: tenantId },
    select: { name: true },
  });
  const branchId =
    config.orderBranchId ??
    (
      await services.db.branch.findFirst({
        where: { tenantId, isActive: true, deletedAt: null },
        orderBy: { createdAt: 'asc' },
        select: { id: true },
      })
    )?.id ??
    null;
  return {
    config,
    token: services.secrets.decrypt(config.botTokenEnc),
    restaurant: tenant?.name ?? 'FastFood',
    branchId,
  };
}

/** Menu without products that need modifier choices (not offered in the bot). */
async function botMenu(services: Services, tenantId: string, branchId: string) {
  const menu = await publicMenu(services.db, tenantId, branchId);
  const required = new Set(
    menu.modifierGroups
      .filter((group) => group.minSelect > 0)
      .map((group) => group.id),
  );
  const products = menu.products.filter(
    (product) => !product.modifierGroupIds.some((id) => required.has(id)),
  );
  const variants = new Map<
    string,
    { productId: string; name: string; price: number }
  >();
  for (const product of products)
    for (const variant of product.variants)
      variants.set(variant.id, {
        productId: product.id,
        name:
          product.variants.length > 1
            ? `${product.name} (${variant.name})`
            : product.name,
        price: variant.price,
      });
  return {
    categories: menu.categories.filter((category) =>
      products.some((product) => product.categoryId === category.id),
    ),
    products,
    variants,
  };
}

/** Handles one update for a tenant's bot. Unknown input gets the main keyboard. */
export async function handleTelegramUpdate(
  services: Services,
  tenantId: string,
  raw: unknown,
) {
  const parsed = updateSchema.safeParse(raw);
  if (!parsed.success) return;
  const update = parsed.data;
  const bot = await loadBot(services, tenantId);
  if (!bot || !bot.config.ordersEnabled || !bot.branchId) return;
  const branchId = bot.branchId;
  const chatId = String(
    update.message?.chat.id ?? update.callback_query?.message?.chat.id ?? '',
  );
  if (!chatId) return;
  const db = services.db;
  const send = (text: string, reply_markup?: object) =>
    telegramApi(services, bot.token, 'sendMessage', {
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
      ...(reply_markup ? { reply_markup } : {}),
    });
  const chat = await db.telegramChat.upsert({
    where: { tenantId_chatId: { tenantId, chatId } },
    update: {},
    create: {
      tenantId,
      chatId,
      name:
        update.message?.from?.first_name?.slice(0, 80) ??
        update.callback_query?.from.first_name?.slice(0, 80) ??
        null,
    },
  });
  let state = (chat.state ?? {}) as ChatState;
  const save = async (
    next: ChatState,
    extra: Prisma.TelegramChatUpdateInput = {},
  ) => {
    state = next;
    await db.telegramChat.update({
      where: { id: chat.id },
      data: { state: next as Prisma.InputJsonValue, ...extra },
    });
  };
  const menu = await botMenu(services, tenantId, branchId);
  const cartLines = (cart: Cart = state.cart ?? []) =>
    cart
      .map((line) => ({ ...line, item: menu.variants.get(line.v) }))
      .filter((line) => line.item);
  const cartTotal = () =>
    cartLines().reduce((sum, line) => sum + line.item!.price * line.q, 0);

  const showCategories = () =>
    menu.categories.length
      ? send('🍔 Bo‘limni tanlang:', {
          inline_keyboard: rows(
            menu.categories.map((category) => ({
              text: category.name.slice(0, 40),
              callback_data: `c:${category.id}`,
            })),
          ),
        })
      : send('Hozircha menyu bo‘sh.');
  const showCart = async () => {
    const lines = cartLines();
    if (!lines.length)
      return send(
        '🛒 Savat bo‘sh. «🍔 Menyu» dan taom tanlang.',
        MAIN_KEYBOARD,
      );
    return send(
      `🛒 Savat:\n${lines
        .map(
          (line) =>
            `• ${line.item!.name} × ${line.q} = ${money(line.item!.price * line.q)}`,
        )
        .join('\n')}\n\nJami: ${money(cartTotal())}`,
      {
        inline_keyboard: [
          ...lines.map((line) => [
            {
              text: `➖ ${line.item!.name}`.slice(0, 40),
              callback_data: `r:${line.v}`,
            },
            { text: '➕', callback_data: `a:${line.v}` },
          ]),
          [
            { text: '🗑 Tozalash', callback_data: 'clear' },
            { text: '✅ Buyurtma berish', callback_data: 'checkout' },
          ],
        ],
      },
    );
  };
  const askType = () =>
    send('Buyurtmani qanday olasiz?', {
      inline_keyboard: [
        [
          { text: '🚚 Yetkazib berish', callback_data: 't:D' },
          { text: '🏃 Olib ketish', callback_data: 't:T' },
        ],
      ],
    });
  const askConfirm = async () => {
    const lines = cartLines();
    await save({ ...state, step: 'confirm' });
    return send(
      `Buyurtmangizni tekshiring:\n${lines
        .map((line) => `• ${line.item!.name} × ${line.q}`)
        .join('\n')}\nJami: ${money(cartTotal())}\n${
        state.type === 'DELIVERY'
          ? `🚚 Yetkazib berish: ${state.address}\n(yetkazish narxi alohida qo‘shilishi mumkin)`
          : '🏃 Olib ketish'
      }\n📞 ${chat.phone ?? ''}`,
      {
        inline_keyboard: [
          [
            { text: '✅ Tasdiqlash', callback_data: 'ok' },
            { text: '❌ Bekor qilish', callback_data: 'no' },
          ],
        ],
      },
    );
  };
  const nextAfterPhone = async () => {
    await save({ ...state, step: 'type' });
    return askType();
  };

  // ---------------------------------------------------------------- callbacks
  if (update.callback_query) {
    const query = update.callback_query;
    await telegramApi(services, bot.token, 'answerCallbackQuery', {
      callback_query_id: query.id,
    }).catch(() => undefined);
    const data = query.data ?? '';
    const [kind, value] = [
      data.split(':')[0],
      data.slice(data.indexOf(':') + 1),
    ];
    if (kind === 'c') {
      const products = menu.products.filter((p) => p.categoryId === value);
      return send('Taomni tanlang (har bosish savatga 1 dona qo‘shadi):', {
        inline_keyboard: [
          ...products.map((product) => [
            product.variants.length === 1
              ? {
                  text: `${product.name} — ${money(product.variants[0]!.price)}`.slice(
                    0,
                    60,
                  ),
                  callback_data: `a:${product.variants[0]!.id}`,
                }
              : {
                  text: `${product.name} ▸`.slice(0, 60),
                  callback_data: `p:${product.id}`,
                },
          ]),
          [{ text: '⬅ Bo‘limlar', callback_data: 'menu' }],
        ],
      });
    }
    if (kind === 'p') {
      const product = menu.products.find((p) => p.id === value);
      if (!product) return showCategories();
      return send(product.name, {
        inline_keyboard: product.variants.map((variant) => [
          {
            text: `${variant.name} — ${money(variant.price)}`.slice(0, 60),
            callback_data: `a:${variant.id}`,
          },
        ]),
      });
    }
    if (kind === 'menu') return showCategories();
    if (kind === 'a' || kind === 'r') {
      if (!menu.variants.has(value)) return send('Bu taom hozir mavjud emas.');
      const cart = [...(state.cart ?? [])];
      const line = cart.find((item) => item.v === value);
      if (kind === 'a') {
        if (line) line.q = Math.min(MAX_QTY, line.q + 1);
        else if (cart.length < MAX_CART_LINES) cart.push({ v: value, q: 1 });
      } else if (line) {
        line.q -= 1;
        if (line.q <= 0) cart.splice(cart.indexOf(line), 1);
      }
      await save({ ...state, cart, step: 'idle' });
      if (kind === 'r') return showCart();
      return send(
        `✅ ${menu.variants.get(value)!.name} savatga qo‘shildi.\nSavatda: ${cart.reduce((s, l) => s + l.q, 0)} ta, ${money(cartTotal())}`,
        {
          inline_keyboard: [
            [
              { text: '🍔 Yana tanlash', callback_data: 'menu' },
              { text: '🛒 Savat', callback_data: 'cart' },
            ],
          ],
        },
      );
    }
    if (kind === 'cart') return showCart();
    if (kind === 'clear') {
      await save({ step: 'idle', cart: [] });
      return send('🗑 Savat tozalandi.', MAIN_KEYBOARD);
    }
    if (kind === 'checkout') {
      if (!cartLines().length) return showCart();
      await save({ ...state, nonce: randomUUID() });
      if (!chat.phone) {
        await save({ ...state, step: 'phone' });
        return send('📞 Telefon raqamingizni yuboring (pastdagi tugma):', {
          keyboard: [[{ text: '📞 Raqamni yuborish', request_contact: true }]],
          resize_keyboard: true,
          one_time_keyboard: true,
        });
      }
      return nextAfterPhone();
    }
    if (kind === 't' && state.step === 'type') {
      if (value === 'D') {
        await save({ ...state, type: 'DELIVERY', step: 'address' });
        return send('📍 Manzilni yozing yoki lokatsiya yuboring:', {
          keyboard: [
            [{ text: '📍 Lokatsiyani yuborish', request_location: true }],
          ],
          resize_keyboard: true,
          one_time_keyboard: true,
        });
      }
      await save({ ...state, type: 'TAKEAWAY' });
      return askConfirm();
    }
    if (kind === 'no') {
      await save({ step: 'idle', cart: state.cart ?? [] });
      return send(
        'Buyurtma bekor qilindi. Savat saqlanib qoldi.',
        MAIN_KEYBOARD,
      );
    }
    if (kind === 'ok' && state.step === 'confirm') {
      return placeOrder();
    }
    return send('Davom etish uchun menyudan foydalaning.', MAIN_KEYBOARD);
  }

  // ----------------------------------------------------------------- messages
  const message = update.message;
  if (!message) return;
  const text = message.text?.trim() ?? '';
  if (message.contact && state.step === 'phone') {
    // Only the user's own number (Telegram marks it with their user id).
    if (message.contact.user_id && message.contact.user_id !== message.from?.id)
      return send('Iltimos, o‘zingizning raqamingizni yuboring.');
    const digits = message.contact.phone_number.replace(/\D/g, '');
    const phone = `+${digits.startsWith('998') ? digits : `998${digits.slice(-9)}`}`;
    await db.telegramChat.update({ where: { id: chat.id }, data: { phone } });
    chat.phone = phone;
    await send('Rahmat! ✅', MAIN_KEYBOARD);
    return nextAfterPhone();
  }
  if (state.step === 'address' && (message.location || text)) {
    const address = message.location
      ? `📍 https://maps.google.com/?q=${message.location.latitude},${message.location.longitude}`
      : text.slice(0, 300);
    if (address.length < 5) return send('Manzilni to‘liqroq yozing.');
    await save({ ...state, address });
    await send('Rahmat!', MAIN_KEYBOARD);
    return askConfirm();
  }
  // Staff notification subscribers link their chat with /start <code> (polling mode).
  const linkCode = text
    .match(/^\/start\s+([A-Z0-9]{6,12})$/i)?.[1]
    ?.toUpperCase();
  if (linkCode) {
    const subscriber = await db.notificationSubscriber.findFirst({
      where: { tenantId, linkCode },
    });
    if (subscriber) {
      await db.notificationSubscriber
        .update({
          where: { id: subscriber.id },
          data: { chatId, linkCode: null, linkedAt: new Date() },
        })
        .catch(() => undefined);
      return send('✅ Bildirishnomalar shu chatga ulandi.');
    }
  }
  if (text.startsWith('/start') || text === '🍔 Menyu') {
    if (text.startsWith('/start'))
      await send(
        `Assalomu alaykum! «${bot.restaurant}» botiga xush kelibsiz.\nBuyurtma berish uchun «🍔 Menyu» tugmasini bosing.`,
        MAIN_KEYBOARD,
      );
    return showCategories();
  }
  if (text === '🛒 Savat') return showCart();
  if (text === '📦 Buyurtmalarim') {
    const orders = await db.order.findMany({
      where: { tenantId, telegramChatId: chatId },
      orderBy: { createdAt: 'desc' },
      take: 5,
    });
    if (!orders.length) return send('Sizda hali buyurtma yo‘q.', MAIN_KEYBOARD);
    return send(
      orders
        .map(
          (order) =>
            `№${order.number} — ${statusText(order.status, order.deliveryStatus)} — ${money(order.total)}`,
        )
        .join('\n'),
      MAIN_KEYBOARD,
    );
  }
  return send('Menyudan foydalaning 👇', MAIN_KEYBOARD);

  async function placeOrder() {
    const lines = cartLines();
    if (!lines.length) return showCart();
    if (!chat.phone || !state.type) return askType();
    const pending = await db.order.count({
      where: { tenantId, telegramChatId: chatId, status: 'PENDING' },
    });
    if (pending >= MAX_PENDING_PER_CHAT)
      return send('Sizda tasdiqlanmagan buyurtmalar ko‘p. Iltimos, kuting.');
    const branch = await db.branch.findUniqueOrThrow({
      where: { id: branchId },
    });
    const idempotencyKey = `tg:${chatId}:${state.nonce ?? randomUUID()}`;
    const existing = await db.order.findUnique({
      where: { tenantId_idempotencyKey: { tenantId, idempotencyKey } },
    });
    if (existing) return;
    const now = services.now?.() ?? new Date();
    const order = await db.$transaction(async (tx) => {
      const priced = await priceItems(
        tx,
        tenantId,
        branchId,
        lines.map((line) => ({
          variantId: line.v,
          quantity: line.q,
          modifierOptionIds: [],
          note: null,
        })),
      );
      const date = businessDate(now, branch.timezone);
      const number = await nextOrderNumber(tx, branchId, date);
      const subtotal = priced.reduce((sum, item) => sum + item.lineTotal, 0);
      const customer = await upsertCustomer(
        tx,
        tenantId,
        chat.phone!,
        chat.name ?? 'Telegram',
      );
      const created = await tx.order.create({
        data: {
          tenantId,
          branchId,
          customerId: customer?.id ?? null,
          number,
          businessDate: date,
          type: state.type!,
          channel: 'TELEGRAM',
          status: 'PENDING',
          customerName: chat.name ?? null,
          customerPhone: chat.phone,
          deliveryAddress:
            state.type === 'DELIVERY' ? (state.address ?? null) : null,
          subtotal,
          ...computeTotals({
            subtotal,
            discountBp: 0,
            discountFixed: 0,
            serviceChargeBp: 0,
          }),
          idempotencyKey,
          telegramChatId: chatId,
        },
      });
      await tx.orderItem.createMany({
        data: priced.map((item) =>
          itemCreateData(tenantId, created.id, null, item),
        ),
      });
      await addEvent(tx, tenantId, created.id, null, 'created', {
        status: 'PENDING',
        channel: 'TELEGRAM',
        items: priced.length,
      });
      await emitWebhook(tx, tenantId, 'order.online_created', {
        id: created.id,
        number: created.number,
        branchId,
        total: created.total,
      });
      await notifyOnlineOrder(tx, {
        tenantId,
        branchId,
        number: created.number,
        total: created.total,
      });
      await tx.telegramChat.update({
        where: { id: chat.id },
        data: { state: { step: 'idle', cart: [] }, lastOrderAt: now },
      });
      return created;
    });
    services.events?.publish({
      type: 'order.changed',
      tenantId,
      branchId,
      orderId: order.id,
      number: order.number,
      status: order.status,
    });
    return send(
      `✅ Buyurtmangiz №${order.number} yuborildi (${money(order.total)}).\nRestoran tasdiqlagach, shu yerga xabar keladi.`,
      MAIN_KEYBOARD,
    );
  }
}

function statusText(status: string, delivery: string | null) {
  if (delivery === 'DELIVERED') return 'Yetkazib berildi';
  if (delivery === 'ON_THE_WAY' || delivery === 'PICKED_UP') return 'Yo‘lda';
  return (
    (
      {
        PENDING: 'Tasdiqlash kutilmoqda',
        PLACED: 'Qabul qilindi',
        PREPARING: 'Tayyorlanmoqda',
        READY: 'Tayyor',
        SERVED: 'Berildi',
        COMPLETED: 'Yakunlandi',
        CANCELLED: 'Bekor qilindi',
      } as Record<string, string>
    )[status] ?? status
  );
}

/**
 * Tells a Telegram customer about their order's progress (once per stage). On
 * acceptance the customer receives a private one-time code: for delivery the courier
 * must ask for it; for pickup the cashier does. Called after every order change.
 */
export async function notifyTelegramCustomer(
  services: Services,
  orderId: string,
) {
  const db = services.db;
  const order = await db.order.findUnique({ where: { id: orderId } });
  if (!order?.telegramChatId) return;
  const stage =
    order.status === 'CANCELLED'
      ? 'cancelled'
      : order.deliveryStatus === 'DELIVERED'
        ? 'delivered'
        : order.deliveryStatus === 'ON_THE_WAY' ||
            order.deliveryStatus === 'PICKED_UP'
          ? 'on_the_way'
          : order.status === 'READY' && order.type !== 'DELIVERY'
            ? 'ready'
            : order.status === 'COMPLETED' && order.type !== 'DELIVERY'
              ? 'completed'
              : ['PLACED', 'PREPARING', 'READY', 'SERVED'].includes(
                    order.status,
                  )
                ? 'accepted'
                : null;
  if (!stage || stage === order.telegramNotified) return;
  // Claim the stage atomically so concurrent hooks send each message once.
  const claimed = await db.order.updateMany({
    where: {
      id: orderId,
      OR: [{ telegramNotified: null }, { telegramNotified: { not: stage } }],
    },
    data: { telegramNotified: stage },
  });
  if (claimed.count === 0) return;
  const bot = await loadBot(services, order.tenantId);
  if (!bot) return;
  let text = '';
  if (stage === 'accepted') {
    const purpose = order.type === 'DELIVERY' ? 'DELIVERY' : 'PICKUP';
    const { code } = await db.$transaction((tx) =>
      issueOrderCode(tx, services.secrets, {
        tenantId: order.tenantId,
        orderId,
        purpose,
        actorId: null,
        now: services.now?.() ?? new Date(),
      }),
    );
    text =
      order.type === 'DELIVERY'
        ? `✅ Buyurtmangiz №${order.number} qabul qilindi va tayyorlanmoqda.\n\n🔐 Tasdiq kodi: ${code}\nKodni faqat kuryer buyurtmani sizga topshirganda ayting. Hech kimga oldindan bermang.`
        : `✅ Buyurtmangiz №${order.number} qabul qilindi va tayyorlanmoqda.\n\n🔐 Olish kodi: ${code}\nBuyurtmani olishda kassirga shu kodni ayting.`;
  } else if (stage === 'ready')
    text = `🔔 ${order.number}-raqamli buyurtmangiz tayyor! Olib ketishingiz mumkin.`;
  else if (stage === 'on_the_way')
    text = `🚚 Buyurtmangiz №${order.number} yo‘lda. Kuryer yetib kelganda tasdiq kodini ayting.`;
  else if (stage === 'delivered')
    text = `✅ Buyurtmangiz №${order.number} yetkazib berildi. Yoqimli ishtaha!`;
  else if (stage === 'completed')
    text = `✅ Buyurtmangiz №${order.number} topshirildi. Yoqimli ishtaha!`;
  else if (stage === 'cancelled')
    text = `❌ Buyurtmangiz №${order.number} bekor qilindi.${order.cancelReason ? ` Sabab: ${order.cancelReason}` : ''}`;
  await telegramApi(services, bot.token, 'sendMessage', {
    chat_id: order.telegramChatId,
    text,
  }).catch(() => services.logger.warn('Telegram customer notice failed'));
}

/**
 * Long polling for installs without a public HTTPS address (desktop). Each tenant
 * bot with ordering enabled is polled; the offset is stored so updates are handled
 * once even across restarts.
 */
export function startTelegramPolling(services: Services, intervalMs = 2500) {
  let running = false;
  const cleared = new Set<string>();
  const tick = async () => {
    const configs = await services.db.telegramConfig.findMany({
      where: { isActive: true, ordersEnabled: true },
    });
    for (const config of configs) {
      const token = services.secrets.decrypt(config.botTokenEnc);
      if (!cleared.has(config.tenantId)) {
        // Polling and webhooks are exclusive in the Bot API.
        await telegramApi(services, token, 'deleteWebhook', {}).catch(
          () => undefined,
        );
        cleared.add(config.tenantId);
      }
      const updates = (await telegramApi(services, token, 'getUpdates', {
        offset: Number(config.updateOffset) + 1,
        timeout: 0,
        allowed_updates: ['message', 'callback_query'],
      })) as { update_id: number }[] | null;
      for (const update of updates ?? []) {
        await services.db.telegramConfig.update({
          where: { tenantId: config.tenantId },
          data: { updateOffset: BigInt(update.update_id) },
        });
        await handleTelegramUpdate(services, config.tenantId, update).catch(
          () => services.logger.warn('Telegram update failed'),
        );
      }
    }
  };
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    tick()
      .catch(() => services.logger.warn('Telegram polling failed'))
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
