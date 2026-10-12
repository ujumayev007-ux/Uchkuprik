import { useSyncExternalStore } from 'react';

export const appVersion = __APP_VERSION__;

type InstallPrompt = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};

type State = {
  updateReady: boolean;
  installable: boolean;
};

let state: State = { updateReady: false, installable: false };
let waiting: ServiceWorker | null = null;
let installPrompt: InstallPrompt | null = null;
const listeners = new Set<() => void>();

function set(next: Partial<State>) {
  state = { ...state, ...next };
  listeners.forEach((listener) => listener());
}

/**
 * Registers the service worker in production builds. The script URL carries the
 * build version, so every deployment installs a new worker and offers an update.
 */
export function registerServiceWorker() {
  if (typeof window === 'undefined') return;
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    installPrompt = event as InstallPrompt;
    set({ installable: true });
  });
  window.addEventListener('appinstalled', () => {
    installPrompt = null;
    set({ installable: false });
  });
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register(`/sw.js?v=${encodeURIComponent(appVersion)}`)
      .then((registration) => {
        const track = (worker: ServiceWorker | null) => {
          if (!worker) return;
          worker.addEventListener('statechange', () => {
            // An installed worker while a page is already controlled = new version.
            if (
              worker.state === 'installed' &&
              navigator.serviceWorker.controller
            ) {
              waiting = worker;
              set({ updateReady: true });
            }
          });
        };
        if (registration.waiting && navigator.serviceWorker.controller) {
          waiting = registration.waiting;
          set({ updateReady: true });
        }
        registration.addEventListener('updatefound', () =>
          track(registration.installing),
        );
        // Long-running terminals check for new builds every 30 minutes.
        setInterval(
          () => void registration.update().catch(() => undefined),
          30 * 60_000,
        );
      })
      .catch(() => undefined);
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloading) return;
      reloading = true;
      window.location.reload();
    });
  });
}

export function applyUpdate() {
  waiting?.postMessage('SKIP_WAITING');
}

export async function promptInstall() {
  if (!installPrompt) return;
  await installPrompt.prompt();
  await installPrompt.userChoice.catch(() => undefined);
  installPrompt = null;
  set({ installable: false });
}

export function usePwa() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
  );
}

/** Kiosk mode for POS and kitchen terminals (browser fullscreen). */
export async function toggleFullscreen() {
  if (document.fullscreenElement) await document.exitFullscreen();
  else
    await document.documentElement.requestFullscreen().catch(() => undefined);
}
