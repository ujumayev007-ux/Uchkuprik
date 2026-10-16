import { useRef, useState } from 'react';
import { SKIN_NAMES, SKINS, mediaUrl, type Skin } from '../lib/branding';
import { t } from '../i18n';
import { Button, useToast } from './ui';

const d = t.design;

const SKIN_HINTS: Record<Skin, string> = {
  classic: 'To‘q sariq va oq (hozirgi dizayn)',
  premium: 'Qora va oltin',
  blue: 'Ko‘k va oq',
  emerald: 'Yashil va oq',
  minimal: 'Toza oq va kulrang',
  luxury: 'To‘q bordo va oltin',
};

/** Small preview of one skin: the sign-in card in that skin's colours. */
export function SkinPreview({ skin }: { skin: Skin }) {
  return (
    <div
      className="skin-preview"
      data-skin={skin === 'classic' ? undefined : skin}
    >
      <div className="skin-preview-card">
        <i />
        <i />
        <i />
        <b />
      </div>
    </div>
  );
}

/** The six skins as selectable cards. `value = null` means "inherit". */
export function SkinPicker({
  value,
  onChange,
  inheritLabel,
}: {
  value: Skin | null;
  onChange: (skin: Skin | null) => void;
  inheritLabel?: string;
}) {
  return (
    <div className="stack">
      <div className="skin-grid">
        {SKINS.map((skin) => (
          <button
            key={skin}
            type="button"
            className="skin-choice"
            aria-pressed={value === skin}
            onClick={() => onChange(skin)}
          >
            <SkinPreview skin={skin} />
            <span className="skin-choice-name">{SKIN_NAMES[skin]}</span>
            <span className="skin-choice-hint">{SKIN_HINTS[skin]}</span>
          </button>
        ))}
      </div>
      {inheritLabel && (
        <div>
          <Button
            size="sm"
            variant={value === null ? 'primary' : 'secondary'}
            onClick={() => onChange(null)}
          >
            {inheritLabel}
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * Picks or uploads a picture/video. The file goes to `uploadPath` as a raw body; the
 * server judges it by its bytes. Shows the current file and lets the user remove it.
 */
export function MediaPicker({
  label,
  value,
  onChange,
  uploadPath,
  accept = 'image/png,image/jpeg,image/webp,image/gif',
  kind = 'IMAGE',
}: {
  label: string;
  value: string | null | undefined;
  onChange: (id: string | null) => void;
  uploadPath: string;
  accept?: string;
  kind?: 'IMAGE' | 'VIDEO';
}) {
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const upload = async (file: File) => {
    setBusy(true);
    try {
      const response = await fetch(
        `${uploadPath}?name=${encodeURIComponent(file.name)}`,
        {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: file,
        },
      );
      const data = (await response.json().catch(() => ({}))) as {
        media?: { id: string };
        message?: string;
      };
      if (!response.ok || !data.media)
        throw new Error(data.message ?? t.common.errorTitle);
      onChange(data.media.id);
    } catch (error) {
      toast(
        error instanceof Error ? error.message : t.common.errorTitle,
        'error',
      );
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };
  return (
    <div className="stack compact">
      <span className="field-label">{label}</span>
      <div className="row" style={{ alignItems: 'center', gap: 12 }}>
        {value &&
          (kind === 'VIDEO' ? (
            <video
              src={mediaUrl(value)}
              muted
              style={{ maxHeight: 64, maxWidth: 120, borderRadius: 8 }}
            />
          ) : (
            <img
              src={mediaUrl(value)}
              alt=""
              style={{ maxHeight: 64, maxWidth: 120, borderRadius: 8 }}
            />
          ))}
        <input
          ref={input}
          type="file"
          accept={accept}
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void upload(file);
          }}
        />
        <Button size="sm" busy={busy} onClick={() => input.current?.click()}>
          {value ? d.replaceFile : d.uploadFile}
        </Button>
        {value && (
          <Button size="sm" variant="danger" onClick={() => onChange(null)}>
            {d.removeFile}
          </Button>
        )}
      </div>
    </div>
  );
}
