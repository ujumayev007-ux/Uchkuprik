import { useRef, useState } from 'react';
import { t } from '../i18n';
import { useRealtimeEvent } from '../lib/realtime';
import { speak } from '../lib/voice';
import { VoiceSettingsDialog } from './VoiceSettingsDialog';

/**
 * Voice notices for waiters, cashiers and admins: "123-raqamli buyurtma tayyor" when
 * the kitchen finishes an order and "123-sonli buyurtma yangilandi!" when an order
 * is changed by someone else. Each notice is spoken once per device.
 */
export function StaffAnnouncer() {
  const said = useRef(new Set<string>());
  useRealtimeEvent((event, payload) => {
    const number = payload.number;
    if (typeof number !== 'number') return;
    const key = `${event}:${String(payload.orderId)}:${String(payload.status)}:${String(payload.version ?? '')}`;
    if (said.current.has(key)) return;
    if (event === 'order.changed' && payload.status === 'READY') {
      said.current.add(key);
      speak(t.voice.staffReady.replace('{n}', String(number)));
    } else if (event === 'order.updated') {
      said.current.add(key);
      speak(t.voice.staffUpdated.replace('{n}', String(number)));
    }
    if (said.current.size > 500) said.current.clear();
  });
  return null;
}

/** Top-bar button opening this device's voice settings. */
export function VoiceButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        className="icon-button"
        aria-label={t.voice.title}
        title={t.voice.title}
        onClick={() => setOpen(true)}
      >
        🔊
      </button>
      {open && <VoiceSettingsDialog onClose={() => setOpen(false)} />}
    </>
  );
}
