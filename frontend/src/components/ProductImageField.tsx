import { useRef, useState } from 'react';
import { t } from '../i18n';
import { uploadEvidence } from '../lib/api';
import { Button, TextField } from './ui';

const TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
const MAX_SIDE = 1024;

const isLocal = (url: string) => url.startsWith('/api/menu/images/');

// Read as a data: URL: the page's security policy allows data: pictures, not blob:.
const dataUrlOf = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });

/** Reduces a photo (phone pictures are several MB) to at most 1024 px before upload. */
async function reduce(file: File): Promise<File> {
  const image = new Image();
  image.src = await dataUrlOf(file);
  await image.decode();
  const scale = Math.min(1, MAX_SIDE / Math.max(image.width, image.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(image.width * scale));
  canvas.height = Math.max(1, Math.round(image.height * scale));
  const context = canvas.getContext('2d');
  if (!context) return file;
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const encode = (type: string) =>
    new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, 0.82));
  // WebP where the browser can write it, JPEG otherwise (older Android WebViews).
  let blob = await encode('image/webp');
  if (!blob || blob.type !== 'image/webp') blob = await encode('image/jpeg');
  if (!blob || blob.size >= file.size) return file;
  return new File([blob], 'rasm', { type: blob.type });
}

/**
 * Product picture: upload from the computer or phone (reduced, stored on the restaurant
 * server) or an https link as before. The preview shows what will be saved.
 */
export function ProductImageField({
  value,
  onChange,
}: {
  value: string;
  onChange: (url: string) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pick = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    const typeOk =
      TYPES.includes(file.type) || /\.(jpe?g|png|webp)$/i.test(file.name);
    if (!typeOk) return setError(t.menu.imageType);
    if (file.size > MAX_SOURCE_BYTES) return setError(t.menu.imageTooBig);
    setBusy(true);
    try {
      const reduced = await reduce(file).catch(() => file);
      const id = await uploadEvidence(reduced, '/api/menu/product-images');
      onChange(`/api/menu/images/${id}`);
    } catch (caught) {
      setError(caught instanceof Error && caught.message ? caught.message : t.menu.imageFailed);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };

  return (
    <fieldset className="stack">
      <legend>{t.menu.image}</legend>
      <div className="product-image-field">
        {value ? (
          <img src={value} alt="" referrerPolicy="no-referrer" />
        ) : (
          <div className="product-placeholder" aria-hidden="true">
            🖼
          </div>
        )}
        <div className="stack" style={{ gap: 6 }}>
          <input
            ref={input}
            type="file"
            accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp"
            hidden
            onChange={(event) => void pick(event.target.files?.[0])}
          />
          <Button busy={busy} onClick={() => input.current?.click()}>
            📷 {value ? t.menu.imageReplace : t.menu.imageUpload}
          </Button>
          {value && (
            <Button variant="ghost" onClick={() => onChange('')}>
              ✕ {t.menu.imageRemove}
            </Button>
          )}
          {busy && <small className="muted">{t.menu.imageUploading}</small>}
          {error && (
            <small role="alert" style={{ color: 'var(--danger, #c0392b)' }}>
              {error}
            </small>
          )}
        </div>
      </div>
      <p className="muted small" style={{ margin: 0 }}>
        {t.menu.imageHint}
      </p>
      <TextField
        label={`${t.menu.imageUrl} (${t.common.optional})`}
        type="url"
        value={isLocal(value) ? '' : value}
        placeholder={isLocal(value) ? t.menu.imageUpload : 'https://'}
        onChange={(e) => onChange(e.target.value)}
      />
    </fieldset>
  );
}
