// Uzbek (Latin) number words for voice announcements: «Yettinchi buyurtma tayyor.»
// Pure functions, no browser APIs, so they are unit-tested on the server side too.

const ONES = [
  'nol',
  'bir',
  'ikki',
  'uch',
  'to‘rt',
  'besh',
  'olti',
  'yetti',
  'sakkiz',
  'to‘qqiz',
];
const TENS = [
  '',
  'o‘n',
  'yigirma',
  'o‘ttiz',
  'qirq',
  'ellik',
  'oltmish',
  'yetmish',
  'sakson',
  'to‘qson',
];
const VOWELS = /[aeiou]$/i;

/** «123» → «bir yuz yigirma uch». Supports 0…999 999; larger numbers stay digits. */
export function uzbekCardinal(value: number): string {
  const n = Math.floor(Math.abs(value));
  if (!Number.isFinite(n) || n > 999_999) return String(n);
  if (n < 10) return ONES[n]!;
  if (n < 100) {
    const unit = n % 10;
    return unit ? `${TENS[Math.floor(n / 10)]} ${ONES[unit]}` : TENS[n / 10]!;
  }
  if (n < 1000) {
    const hundreds = Math.floor(n / 100);
    const head = hundreds === 1 ? 'yuz' : `${ONES[hundreds]} yuz`;
    const rest = n % 100;
    return rest ? `${head} ${uzbekCardinal(rest)}` : head;
  }
  const thousands = Math.floor(n / 1000);
  const head = thousands === 1 ? 'ming' : `${uzbekCardinal(thousands)} ming`;
  const rest = n % 1000;
  return rest ? `${head} ${uzbekCardinal(rest)}` : head;
}

/** «7» → «yettinchi», «20» → «yigirmanchi», «21» → «yigirma birinchi». */
export function uzbekOrdinal(value: number): string {
  const words = uzbekCardinal(value);
  if (/^\d+$/.test(words)) return `${words}-chi`;
  return `${words}${VOWELS.test(words) ? 'nchi' : 'inchi'}`;
}

export type AnnouncePhrase = 'ordinal' | 'cardinal';

const capitalize = (text: string) =>
  text.charAt(0).toUpperCase() + text.slice(1);

/** The sentence the customer TV speaks when an order becomes ready. */
export function readyAnnouncement(
  number: number,
  phrase: AnnouncePhrase = 'ordinal',
): string {
  return phrase === 'cardinal'
    ? `${capitalize(uzbekCardinal(number))} raqamli buyurtma tayyor.`
    : `${capitalize(uzbekOrdinal(number))} buyurtma tayyor.`;
}

/** Order number as shown on the TV and in compact lists: №001, №012, №123. */
export function formatOrderNo(number: number): string {
  return `№${String(number).padStart(3, '0')}`;
}

/** What the waiter tablet says for a guest who still needs a table. */
export const walkinAnnouncement = 'Yangi mijoz buyurtmasi. Stolni belgilang.';
