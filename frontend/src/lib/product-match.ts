/** Lower-case, without apostrophes (o‘ / g‘ / ʻ / ’ / `), so "gosht" finds "go‘sht". */
export function normalizeName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[‘’ʻʼ`´']/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Products whose name contains every typed word, the ones starting with it first. */
export function matchProducts<T extends { name: string }>(
  items: T[],
  query: string,
  limit = 8,
): T[] {
  const words = normalizeName(query).split(' ').filter(Boolean);
  if (words.length === 0) return items.slice(0, limit);
  const first = words[0]!;
  return items
    .map((item) => ({ item, name: normalizeName(item.name) }))
    .filter(({ name }) => words.every((word) => name.includes(word)))
    .sort(
      (a, b) =>
        Number(!a.name.startsWith(first)) - Number(!b.name.startsWith(first)) ||
        a.name.localeCompare(b.name),
    )
    .slice(0, limit)
    .map(({ item }) => item);
}
