const dateTime = new Intl.DateTimeFormat('uz-UZ', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

export function formatDateTime(
  value: string | Date | null | undefined,
  fallback = '—',
) {
  if (!value) return fallback;
  return dateTime.format(typeof value === 'string' ? new Date(value) : value);
}

// UZS amounts are integers in so‘m; grouped with spaces as is customary in Uzbekistan.
export function formatMoney(amount: number, currency = 'UZS') {
  const grouped = Math.round(amount)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return currency === 'UZS' ? `${grouped} so‘m` : `${grouped} ${currency}`;
}
