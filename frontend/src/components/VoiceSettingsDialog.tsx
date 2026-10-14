import { useEffect, useState } from 'react';
import { t } from '../i18n';
import {
  availableVoices,
  pickVoice,
  speak,
  useVoiceSettings,
} from '../lib/voice';
import { Button, Checkbox, Dialog, SelectField, TextField } from './ui';

const v = t.voice;

/** Per-device voice settings: mute, voice gender or exact voice, volume, repeats. */
export function VoiceSettingsDialog({ onClose }: { onClose: () => void }) {
  const [settings, save] = useVoiceSettings();
  const [voices, setVoices] = useState(availableVoices);
  useEffect(() => {
    // Voice lists load asynchronously in most browsers.
    const update = () => setVoices(availableVoices());
    window.speechSynthesis?.addEventListener?.('voiceschanged', update);
    const timer = setTimeout(update, 500);
    return () => {
      clearTimeout(timer);
      window.speechSynthesis?.removeEventListener?.('voiceschanged', update);
    };
  }, []);
  const current = pickVoice(settings);
  const hasUzbek = voices.some((voice) =>
    voice.lang.toLowerCase().startsWith('uz'),
  );
  return (
    <Dialog open title={`🔊 ${v.title}`} onClose={onClose}>
      <div className="stack">
        <Checkbox
          label={v.enabled}
          checked={settings.enabled}
          onChange={(enabled) => save({ ...settings, enabled })}
        />
        <SelectField
          label={v.gender}
          value={settings.gender}
          onChange={(event) =>
            save({
              ...settings,
              gender: event.target.value as 'female' | 'male',
              voiceName: '',
            })
          }
        >
          <option value="female">{v.female}</option>
          <option value="male">{v.male}</option>
        </SelectField>
        <SelectField
          label={v.voice}
          value={settings.voiceName}
          onChange={(event) =>
            save({ ...settings, voiceName: event.target.value })
          }
        >
          <option value="">{v.auto}</option>
          {voices.map((voice) => (
            <option key={voice.name} value={voice.name}>
              {voice.name} ({voice.lang})
            </option>
          ))}
        </SelectField>
        <p className="muted small">
          {current ? v.using.replace('{voice}', current.name) : v.noVoice}
          {!hasUzbek && ` ${v.installHint}`}
        </p>
        <TextField
          label={`${v.volume}: ${Math.round(settings.volume * 100)}%`}
          type="range"
          min={0}
          max={100}
          value={Math.round(settings.volume * 100)}
          onChange={(event) =>
            save({ ...settings, volume: Number(event.target.value) / 100 })
          }
        />
        <SelectField
          label={v.repeat}
          value={String(settings.repeat)}
          onChange={(event) =>
            save({ ...settings, repeat: Number(event.target.value) })
          }
        >
          {[1, 2, 3].map((n) => (
            <option key={n} value={n}>
              {v.times.replace('{n}', String(n))}
            </option>
          ))}
        </SelectField>
        <div className="form-actions">
          <Button onClick={() => speak(t.queue.announce.replace('{n}', '123'))}>
            ▶ {v.test}
          </Button>
          <Button variant="primary" onClick={onClose}>
            {t.common.close}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
