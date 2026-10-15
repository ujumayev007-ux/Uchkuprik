import { useEffect, useState } from 'react';
import { chime } from './realtime';

/**
 * Voice announcements ("123-raqamli buyurtmangiz tayyor!") for the customer TV and
 * staff panels. Settings are per device (each TV/tablet has its own speakers) and
 * announcements are queued so simultaneous orders never talk over each other.
 */
export type VoiceSettings = {
  enabled: boolean;
  gender: 'female' | 'male';
  // Exact system voice; empty picks the best Uzbek voice of the chosen gender.
  voiceName: string;
  volume: number;
  repeat: number;
  rate: number;
};

const KEY = 'ff-voice';
const defaults: VoiceSettings = {
  enabled: true,
  gender: 'female',
  voiceName: '',
  volume: 1,
  repeat: 1,
  rate: 0.95,
};

export function loadVoiceSettings(): VoiceSettings {
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') };
  } catch {
    return defaults;
  }
}

export function saveVoiceSettings(settings: VoiceSettings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    /* Storage blocked: settings last for this page only. */
  }
  window.dispatchEvent(new Event('ff-voice'));
}

export function useVoiceSettings() {
  const [settings, setSettings] = useState(loadVoiceSettings);
  useEffect(() => {
    const update = () => setSettings(loadVoiceSettings());
    window.addEventListener('ff-voice', update);
    return () => window.removeEventListener('ff-voice', update);
  }, []);
  return [settings, saveVoiceSettings] as const;
}

// Names of common female/male system voices (Windows, Android, macOS).
const FEMALE =
  /madina|female|ayol|zira|aru|svetlana|irina|milena|katya|dariya|google/i;
const MALE = /sardor|male|erkak|david|pavel|dmitry|yuri|maxim/i;

export function availableVoices(): SpeechSynthesisVoice[] {
  try {
    const voices = window.speechSynthesis?.getVoices() ?? [];
    const rank = (voice: SpeechSynthesisVoice) => {
      const lang = voice.lang.toLowerCase();
      return lang.startsWith('uz')
        ? 0
        : lang.startsWith('tr')
          ? 1
          : lang.startsWith('ru')
            ? 2
            : 3;
    };
    return [...voices].sort((a, b) => rank(a) - rank(b));
  } catch {
    return [];
  }
}

/** Turkish reads Uzbek Latin text well when the device has no Uzbek voice. */
function fallbackVoice(): SpeechSynthesisVoice | null {
  const voices = availableVoices();
  return (
    voices.find((voice) => voice.lang.toLowerCase().startsWith('tr')) ?? null
  );
}

export function pickVoice(settings: VoiceSettings) {
  const voices = availableVoices();
  if (settings.voiceName) {
    const exact = voices.find((voice) => voice.name === settings.voiceName);
    if (exact) return exact;
  }
  const uzbek = voices.filter((voice) =>
    voice.lang.toLowerCase().startsWith('uz'),
  );
  const pool = uzbek.length ? uzbek : [];
  const pattern = settings.gender === 'male' ? MALE : FEMALE;
  return pool.find((voice) => pattern.test(voice.name)) ?? pool[0] ?? null;
}

export type SpeakOptions = {
  // Overrides this device's repeat count and scales its volume (central settings).
  repeat?: number;
  volume?: number;
  // Speak even when the device voice is muted: used for Owner-controlled alerts.
  force?: boolean;
  // Play only the signal tone, no words.
  chimeOnly?: boolean;
};
type Queued = { text: string; options: SpeakOptions };
const queue: Queued[] = [];
let speaking = false;

function speakOnce(text: string, settings: VoiceSettings) {
  return new Promise<void>((resolve) => {
    const voice = pickVoice(settings) ?? fallbackVoice();
    if (!voice || !window.speechSynthesis) {
      setTimeout(resolve, 900);
      return;
    }
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.voice = voice;
    utterance.lang = voice.lang;
    utterance.rate = settings.rate;
    utterance.volume = Math.max(0, Math.min(1, settings.volume));
    utterance.onend = () => resolve();
    utterance.onerror = () => resolve();
    // Safety net: some engines never fire onend.
    setTimeout(resolve, 8000);
    window.speechSynthesis.speak(utterance);
  });
}

async function drain() {
  if (speaking) return;
  speaking = true;
  try {
    while (queue.length) {
      const { text, options } = queue.shift()!;
      const stored = loadVoiceSettings();
      if (!stored.enabled && !options.force) continue;
      const settings: VoiceSettings = {
        ...stored,
        enabled: true,
        volume: Math.max(
          0,
          Math.min(1, stored.volume * ((options.volume ?? 100) / 100)),
        ),
      };
      chime();
      await new Promise((resolve) => setTimeout(resolve, 600));
      const times = options.repeat ?? settings.repeat;
      if (!options.chimeOnly)
        for (let i = 0; i < Math.max(1, Math.min(5, times)); i++)
          await speakOnce(text, settings);
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  } finally {
    speaking = false;
  }
}

/** Queues an announcement; respects this device's mute, voice, volume and repeats. */
export function speak(text: string, options: SpeakOptions = {}) {
  if (!loadVoiceSettings().enabled && !options.force) return;
  if (queue.length > 20) queue.shift();
  queue.push({ text, options });
  void drain();
}
