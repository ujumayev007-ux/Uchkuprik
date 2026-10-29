import type { Services } from '../../context.js';
import { AppError } from '../../http/errors.js';
import { randomToken } from '../../lib/crypto.js';
import { localDateTime } from '../../printing/receipt.js';
import { netPaid } from '../orders/engine.js';
import { methodLabels, receiptData } from '../orders/receipt-data.js';
import { telegramApi } from './bot.js';

/**
 * Elektron chek in Telegram: once an order is fully paid, the restaurant's bot sends the
 * receipt to the guest — the chat the order came from, or a chat whose phone Telegram
 * confirmed as that guest's own number. Off unless the restaurant switched it on; each
 * order's receipt is sent once (staff may send it again by hand).
 */
const money = (value: number) =>
  value.toLocaleString('en-US').replace(/,/g, ' ');

async function chatFor(
  services: Services,
  order: {
    tenantId: string;
    telegramChatId: string | null;
    customerPhone: string | null;
    customerId: string | null;
  },
) {
  if (order.telegramChatId) return order.telegramChatId;
  const phone =
    order.customerPhone ??
    (order.customerId
      ? ((
          await services.db.customer.findFirst({
            where: { id: order.customerId, tenantId: order.tenantId },
            select: { phone: true },
          })
        )?.phone ?? null)
      : null);
  if (!phone) return null;
  const chat = await services.db.telegramChat.findFirst({
    where: { tenantId: order.tenantId, phone, phoneVerified: true },
    orderBy: { updatedAt: 'desc' },
    select: { chatId: true },
  });
  return chat?.chatId ?? null;
}

export async function receiptText(
  services: Services,
  orderId: string,
  origin: string | null,
) {
  const order = await services.db.order.findUniqueOrThrow({
    where: { id: orderId },
    include: { items: true, payments: true, refunds: true, table: true },
  });
  let token = order.trackingToken;
  if (!token && origin) {
    token = randomToken(18);
    await services.db.order.updateMany({
      where: { id: order.id, trackingToken: null },
      data: { trackingToken: token },
    });
    token =
      (await services.db.order.findUniqueOrThrow({ where: { id: order.id } }))
        .trackingToken ?? token;
  }
  const receipt = await receiptData(services.db, order, {});
  const o = receipt.order;
  const lines = [
    `🧾 ${receipt.business.name} — elektron chek`,
    `Buyurtma №${o.number} · ${localDateTime(new Date(o.createdAt), receipt.branch.timezone)}`,
    '──────────',
    ...o.items.map(
      (item) =>
        `${item.quantity} × ${item.productName}${item.variantName === 'Standart' ? '' : ` (${item.variantName})`} — ${money(item.lineTotal)}`,
    ),
    '──────────',
    ...(o.discountTotal > 0 ? [`Chegirma: −${money(o.discountTotal)}`] : []),
    ...(o.serviceCharge > 0 ? [`Xizmat haqi: ${money(o.serviceCharge)}`] : []),
    `JAMI: ${money(o.total)} so‘m`,
    ...o.payments.map(
      (payment) =>
        `${methodLabels[payment.method] ?? payment.method}: ${money(payment.amount)}`,
    ),
    ...(receipt.credit
      ? [
          `Qarzga yozildi: ${money(receipt.credit.amount)} (${receipt.credit.account})`,
        ]
      : []),
    ...(receipt.fiscal.fiscalSign
      ? [`Fiskal belgi: ${receipt.fiscal.fiscalSign}`]
      : []),
    // Only an address a phone can open from anywhere.
    ...(token && origin?.startsWith('https://')
      ? [`🔗 ${origin}/buyurtma/${token}`]
      : []),
    receipt.business.footer ?? 'Xaridingiz uchun rahmat!',
  ];
  return lines.join('\n');
}

/**
 * After an order changed: its receipt, once, when it is paid and the restaurant turned
 * Telegram receipts on. `force` (staff, by hand) sends again and needs only the bot.
 */
export async function sendTelegramReceipt(
  services: Services,
  orderId: string,
  options: { force?: boolean; origin?: string | null } = {},
) {
  const { db } = services;
  const order = await db.order.findUnique({ where: { id: orderId } });
  if (!order) return false;
  const config = await db.telegramConfig.findUnique({
    where: { tenantId: order.tenantId },
  });
  if (!config?.isActive) {
    if (options.force) throw new AppError(409, 'TELEGRAM_OFF', 'telegramOff');
    return false;
  }
  if (!options.force) {
    if (!config.receiptsEnabled || order.telegramReceiptAt) return false;
    if (order.status === 'CANCELLED' || order.total <= 0) return false;
    if (netPaid(order) < order.total) return false;
  }
  const chatId = await chatFor(services, order);
  if (!chatId) {
    if (options.force)
      throw new AppError(409, 'TELEGRAM_NO_CHAT', 'telegramNoChat');
    return false;
  }
  // Claimed first: concurrent hooks send it once.
  if (!options.force) {
    const claimed = await db.order.updateMany({
      where: { id: order.id, telegramReceiptAt: null },
      data: { telegramReceiptAt: services.now?.() ?? new Date() },
    });
    if (claimed.count === 0) return false;
  }
  const text = await receiptText(services, order.id, options.origin ?? null);
  await telegramApi(
    services,
    services.secrets.decrypt(config.botTokenEnc),
    'sendMessage',
    {
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    },
  );
  if (options.force)
    await db.order.update({
      where: { id: order.id },
      data: { telegramReceiptAt: services.now?.() ?? new Date() },
    });
  return true;
}

/**
 * The bot when only receipts are on (no ordering): a guest shares their own number
 * once and gets every paid receipt here; /stop ends it.
 */
export async function handleReceiptChat(
  services: Services,
  tenantId: string,
  token: string,
  message: {
    chat: { id: number | string };
    from?: { id: number; first_name?: string | undefined } | undefined;
    text?: string | undefined;
    contact?:
      { phone_number: string; user_id?: number | undefined } | undefined;
  },
) {
  const chatId = String(message.chat.id);
  const send = (text: string, reply_markup?: object) =>
    telegramApi(services, token, 'sendMessage', {
      chat_id: chatId,
      text,
      ...(reply_markup ? { reply_markup } : {}),
    });
  const chat = await services.db.telegramChat.upsert({
    where: { tenantId_chatId: { tenantId, chatId } },
    update: {},
    create: {
      tenantId,
      chatId,
      name: message.from?.first_name?.slice(0, 80) ?? null,
    },
  });
  if (message.text?.trim() === '/stop') {
    await services.db.telegramChat.update({
      where: { id: chat.id },
      data: { phone: null, phoneVerified: false },
    });
    return send('Elektron cheklar endi yuborilmaydi.');
  }
  if (message.contact) {
    // Only the user's own number, as Telegram confirms it.
    if (
      !message.contact.user_id ||
      message.contact.user_id !== message.from?.id
    )
      return send('Iltimos, o‘zingizning raqamingizni tugma orqali yuboring.');
    const digits = message.contact.phone_number.replace(/\D/g, '');
    const phone = `+${digits.startsWith('998') ? digits : `998${digits.slice(-9)}`}`;
    await services.db.telegramChat.update({
      where: { id: chat.id },
      data: { phone, phoneVerified: true },
    });
    return send(
      '✅ Rahmat! Endi shu raqam bilan qilingan xaridlarning elektron cheki shu yerga keladi. To‘xtatish: /stop',
      { remove_keyboard: true },
    );
  }
  return send(
    chat.phoneVerified
      ? '✅ Elektron cheklaringiz shu yerga keladi. To‘xtatish: /stop'
      : '🧾 Elektron chekni Telegramda olish uchun raqamingizni yuboring:',
    chat.phoneVerified
      ? undefined
      : {
          keyboard: [[{ text: '📞 Raqamni yuborish', request_contact: true }]],
          resize_keyboard: true,
          one_time_keyboard: true,
        },
  );
}
