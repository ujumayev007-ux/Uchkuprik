import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';

type Listener = (event: string, payload: Record<string, unknown>) => void;
const listeners = new Set<Listener>();

/** Subscribe a component to raw real-time events (e.g. to play a sound). */
export function useRealtimeEvent(listener: Listener) {
  const ref = useRef(listener);
  ref.current = listener;
  useEffect(() => {
    const wrapped: Listener = (event, payload) => ref.current(event, payload);
    listeners.add(wrapped);
    return () => {
      listeners.delete(wrapped);
    };
  }, []);
}

/**
 * Keeps one Socket.io connection per session/branch. Events only say what changed;
 * the affected queries are refetched over REST. After a reconnect everything live is
 * refetched, so missed events cannot leave screens stale.
 */
export function useRealtime(branchId: string | null | undefined) {
  const client = useQueryClient();
  const [online, setOnline] = useState(true);
  useEffect(() => {
    if (!branchId) return;
    const socket: Socket = io({
      path: '/api/realtime',
      withCredentials: true,
      transports: ['websocket', 'polling'],
    });
    let connectedOnce = false;
    const refreshLive = () => {
      for (const key of ['orders', 'kitchen', 'queue', 'shift'])
        void client.invalidateQueries({ queryKey: [key] });
    };
    socket.on('connect', () => {
      setOnline(true);
      if (connectedOnce) refreshLive();
      connectedOnce = true;
    });
    socket.on('disconnect', () => setOnline(false));
    socket.on('connect_error', () => setOnline(false));
    socket.on('order.changed', (payload: Record<string, unknown>) => {
      // New or changed orders also change kitchen tickets and the queue screen.
      for (const key of ['orders', 'kitchen', 'queue', 'shift'])
        void client.invalidateQueries({ queryKey: [key] });
      for (const listener of listeners) listener('order.changed', payload);
    });
    socket.on('kitchen.changed', (payload: Record<string, unknown>) => {
      void client.invalidateQueries({ queryKey: ['kitchen'] });
      void client.invalidateQueries({ queryKey: ['queue'] });
      for (const listener of listeners) listener('kitchen.changed', payload);
    });
    socket.on(
      'menu.changed',
      () => void client.invalidateQueries({ queryKey: ['menu'] }),
    );
    return () => {
      socket.close();
    };
  }, [branchId, client]);
  return online;
}

/** Short two-tone chime via Web Audio; silently ignored where audio is blocked. */
export function chime() {
  try {
    const context = new AudioContext();
    const now = context.currentTime;
    for (const [index, frequency] of [880, 1320].entries()) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, now + index * 0.18);
      gain.gain.exponentialRampToValueAtTime(0.3, now + index * 0.18 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + index * 0.18 + 0.35);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(now + index * 0.18);
      oscillator.stop(now + index * 0.18 + 0.4);
    }
    setTimeout(() => void context.close(), 1000);
  } catch {
    /* Audio unavailable. */
  }
}

/** Speaks Uzbek text with an uz-UZ voice when the device has one, otherwise chimes. */
export function announce(text: string) {
  chime();
  try {
    const voices = window.speechSynthesis?.getVoices() ?? [];
    const voice = voices.find((item) =>
      item.lang.toLowerCase().startsWith('uz'),
    );
    if (!voice) return;
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.voice = voice;
    utterance.lang = voice.lang;
    utterance.rate = 0.95;
    window.speechSynthesis.speak(utterance);
  } catch {
    /* Speech synthesis unavailable. */
  }
}
