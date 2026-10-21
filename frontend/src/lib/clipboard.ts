/** Copies text; works on plain-http addresses too, where navigator.clipboard is missing. */
export function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText)
    return navigator.clipboard.writeText(text);
  return new Promise((resolve, reject) => {
    try {
      const field = document.createElement('textarea');
      field.value = text;
      field.setAttribute('readonly', '');
      field.style.position = 'fixed';
      field.style.opacity = '0';
      document.body.appendChild(field);
      field.select();
      const ok = document.execCommand('copy');
      field.remove();
      if (ok) resolve();
      else reject(new Error('copy failed'));
    } catch (error) {
      reject(error instanceof Error ? error : new Error('copy failed'));
    }
  });
}
