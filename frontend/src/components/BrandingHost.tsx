import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useParams } from 'react-router';
import { t } from '../i18n';
import { api } from '../lib/api';
import {
  adPanelOf,
  applySkin,
  mediaUrl,
  panelOfPath,
  useBranding,
  type AdDef,
  type AdPanel,
  type LoginBranding,
  type PanelKey,
} from '../lib/branding';
import { isBusy, useBusySignal } from '../lib/busy';

// ---- frequency memory (per device, per campaign) --------------------------------------
type Memory = { last: number; day: string; today: number; total: number };
const memoryKey = (id: string) => `ff-ad:${id}`;
const dayOf = (at: number) => new Date(at).toISOString().slice(0, 10);

function readMemory(id: string): Memory {
  try {
    const raw = localStorage.getItem(memoryKey(id));
    if (raw) return JSON.parse(raw) as Memory;
  } catch {
    /* ignore */
  }
  return { last: 0, day: '', today: 0, total: 0 };
}
function writeMemory(id: string, value: Memory) {
  try {
    localStorage.setItem(memoryKey(id), JSON.stringify(value));
  } catch {
    /* Frequency limits are then per session only. */
  }
}

/** Whether the campaign may be shown now (dates, daily cap, minimum gap). */
export function adEligible(ad: AdDef, now: number): boolean {
  if (ad.startsAt && now < Date.parse(ad.startsAt)) return false;
  if (ad.endsAt && now > Date.parse(ad.endsAt)) return false;
  const memory = readMemory(ad.id);
  const today = dayOf(now);
  const todayCount = memory.day === today ? memory.today : 0;
  if (ad.maxPerDay !== null && todayCount >= ad.maxPerDay) return false;
  // "Every 0 minutes" means: show once on this device.
  if (ad.everyMinutes === 0) return memory.total === 0;
  return now - memory.last >= ad.everyMinutes * 60_000;
}

function remember(ad: AdDef, now: number) {
  const memory = readMemory(ad.id);
  const today = dayOf(now);
  writeMemory(ad.id, {
    last: now,
    day: today,
    today: (memory.day === today ? memory.today : 0) + 1,
    total: memory.total + 1,
  });
}

const IDLE_MS = 5_000;

function report(adId: string, event: 'shown' | 'closed', panel: AdPanel) {
  void api(`/branding/ads/${adId}/event`, {
    method: 'POST',
    body: { event, panel },
  }).catch(() => undefined);
}

/**
 * Shows the Owner's advertisements without ever getting in the way: banners are small
 * and never block; popups and fullscreen advertisements wait until the screen is idle,
 * no dialog is open and nothing registered itself as busy (payment, a sale in
 * progress, printing, the kitchen), and are dismissed at once when work starts.
 */
export function AdHost({
  ads,
  panel,
  serverTime,
}: {
  ads: AdDef[];
  panel: AdPanel;
  serverTime?: string | undefined;
}) {
  const [current, setCurrent] = useState<AdDef | null>(null);
  const busySignal = useBusySignal();
  const lastActivity = useRef(Date.now());
  // The server's clock decides dates; the device's clock may be off.
  const offset = useRef(0);
  useEffect(() => {
    if (serverTime) offset.current = Date.parse(serverTime) - Date.now();
  }, [serverTime]);
  const clock = useCallback(() => Date.now() + offset.current, []);

  useEffect(() => {
    const touch = () => {
      lastActivity.current = Date.now();
    };
    for (const name of ['pointerdown', 'keydown', 'touchstart'])
      window.addEventListener(name, touch, { passive: true });
    return () => {
      for (const name of ['pointerdown', 'keydown', 'touchstart'])
        window.removeEventListener(name, touch);
    };
  }, []);

  const pick = useCallback(() => {
    if (current) return;
    const now = clock();
    const quiet =
      !isBusy() &&
      !document.querySelector('dialog[open]') &&
      Date.now() - lastActivity.current >= IDLE_MS;
    const candidate = ads
      .filter((ad) => ad.panels.includes(panel))
      .filter((ad) => {
        // The kitchen only ever gets small banners.
        if (panel === 'KITCHEN' && ad.format !== 'BANNER') return false;
        if (ad.format !== 'BANNER' && !quiet) return false;
        return adEligible(ad, now);
      })
      .sort((a, b) => b.priority - a.priority)[0];
    if (!candidate) return;
    remember(candidate, now);
    report(candidate.id, 'shown', panel);
    setCurrent(candidate);
  }, [ads, panel, current, clock]);

  // Look for something to show soon after the list or the screen state changes, and
  // then every few seconds (no network traffic: the list is already here).
  useEffect(() => {
    const first = setTimeout(pick, 1500);
    const timer = setInterval(pick, 5_000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [pick, busySignal]);

  // Campaigns removed or paused remotely disappear immediately.
  useEffect(() => {
    if (current && !ads.some((ad) => ad.id === current.id)) setCurrent(null);
  }, [ads, current]);

  // Work started while a covering advertisement is up: get out of the way.
  useEffect(() => {
    if (current && current.format !== 'BANNER' && isBusy()) setCurrent(null);
  }, [busySignal, current]);

  // Automatic dismissal.
  useEffect(() => {
    if (!current) return;
    const seconds = current.autoCloseSec ?? current.durationSec;
    const timer = setTimeout(() => setCurrent(null), seconds * 1000);
    return () => clearTimeout(timer);
  }, [current]);

  if (!current) return null;
  const seconds = current.autoCloseSec ?? current.durationSec;
  const close = () => {
    report(current.id, 'closed', panel);
    setCurrent(null);
  };
  const media =
    current.mediaId && current.kind === 'IMAGE' ? (
      <img src={mediaUrl(current.mediaId)} alt="" />
    ) : current.mediaId && current.kind === 'VIDEO' ? (
      <video src={mediaUrl(current.mediaId)} autoPlay muted loop playsInline />
    ) : null;
  const text = current.text ? (
    <div className={current.format === 'BANNER' ? 'ad-banner-text' : 'ad-text'}>
      {current.text}
    </div>
  ) : null;
  const closeButton = current.closable ? (
    <button
      className="ad-close"
      type="button"
      aria-label={t.ads.close}
      onClick={close}
    >
      ×
    </button>
  ) : null;
  if (current.format === 'BANNER')
    return (
      <aside
        className="ad-banner"
        role="status"
        aria-label={t.ads.label}
        style={{ ['--ad-time' as string]: `${seconds}s` }}
      >
        {media}
        {text}
        {current.closable && (
          <button
            className="icon-button"
            type="button"
            aria-label={t.ads.close}
            onClick={close}
          >
            ×
          </button>
        )}
      </aside>
    );
  return (
    <div
      className={`ad-overlay ${current.format === 'FULLSCREEN' ? 'fullscreen' : ''}`}
      role="dialog"
      aria-label={t.ads.label}
      style={{ ['--ad-time' as string]: `${seconds}s` }}
    >
      <div className="ad-card">
        {closeButton}
        {media}
        {text}
        <span className="ad-timer" aria-hidden="true" />
      </div>
    </div>
  );
}

/** Signed-in screens: applies the panel's skin and shows its advertisements. */
export function BrandingHost({ forcePanel }: { forcePanel?: PanelKey }) {
  const location = useLocation();
  const panel = forcePanel ?? panelOfPath(location.pathname);
  const { data } = useBranding();
  const skin = data?.design.panels[panel].skin ?? 'classic';
  useEffect(() => {
    applySkin(skin);
    return () => applySkin(null);
  }, [skin]);
  return (
    <AdHost
      ads={data?.ads ?? []}
      panel={adPanelOf(panel)}
      serverTime={data?.serverTime}
    />
  );
}

/** Guest pages (menu, order tracking): the Customer panel's skin and advertising. */
export function PublicBrandingHost() {
  const { slug } = useParams();
  const code = (slug ?? '').trim().toLowerCase();
  const { data } = useQuery({
    queryKey: ['branding', 'public', code],
    queryFn: () =>
      api<LoginBranding>(
        `/branding/login?ads=customer${code ? `&tenant=${encodeURIComponent(code)}` : ''}`,
      ),
    staleTime: 60_000,
    retry: 1,
  });
  const skin = data?.panels.customer.skin ?? 'classic';
  useEffect(() => {
    applySkin(skin);
    return () => applySkin(null);
  }, [skin]);
  return (
    <AdHost
      ads={data?.ads ?? []}
      panel="CUSTOMER"
      serverTime={data?.serverTime}
    />
  );
}
