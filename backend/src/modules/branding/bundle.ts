import { createHash } from 'node:crypto';
import type { Services } from '../../context.js';
import type { Db } from '../../db.js';
import { catalogByKey } from '../control/catalog.js';
import { canonicalJson } from '../control/keys.js';
import { loadPolicy } from '../control/issue.js';
import { evaluateFeature } from '../control/policy.js';
import { loadAdminData } from '../control/view.js';
import {
  adminLayerSchema,
  layerOf,
  mediaOfDesign,
  resolveDesign,
  type ResolvedDesign,
} from './design.js';

export const AD_PANELS = [
  'ADMIN',
  'CASHIER',
  'WAITER',
  'KITCHEN',
  'CUSTOMER',
] as const;
export type AdPanel = (typeof AD_PANELS)[number];

export type AdDef = {
  id: string;
  kind: 'TEXT' | 'IMAGE' | 'VIDEO';
  format: 'FULLSCREEN' | 'POPUP' | 'BANNER';
  text: string | null;
  mediaId: string | null;
  panels: AdPanel[];
  durationSec: number;
  closable: boolean;
  autoCloseSec: number | null;
  startsAt: string | null;
  endsAt: string | null;
  everyMinutes: number;
  maxPerDay: number | null;
  priority: number;
  version: number;
};

export type MediaRef = {
  id: string;
  kind: string;
  mime: string;
  sha256: string;
  size: number;
};

/** Everything an install needs to show the Owner's design and advertisements. */
export type BrandingBundle = {
  v: string;
  design: ResolvedDesign;
  ads: AdDef[];
  media: MediaRef[];
};

export const emptyBundle = (): BrandingBundle => ({
  v: 'none',
  design: resolveDesign(),
  ads: [],
  media: [],
});

const versionOf = (value: unknown) =>
  createHash('sha256').update(canonicalJson(value)).digest('hex').slice(0, 16);

const iso = (value: Date | null) => (value ? value.toISOString() : null);

export function adDefOf(row: {
  id: string;
  kind: string;
  format: string;
  text: string | null;
  mediaId: string | null;
  panels: string[];
  durationSec: number;
  closable: boolean;
  autoCloseSec: number | null;
  startsAt: Date | null;
  endsAt: Date | null;
  everyMinutes: number;
  maxPerDay: number | null;
  priority: number;
  version: number;
}): AdDef {
  return {
    id: row.id,
    kind: row.kind as AdDef['kind'],
    format: row.format as AdDef['format'],
    text: row.text,
    mediaId: row.mediaId,
    panels: row.panels.filter((panel): panel is AdPanel =>
      (AD_PANELS as readonly string[]).includes(panel),
    ),
    durationSec: row.durationSec,
    closable: row.closable,
    autoCloseSec: row.autoCloseSec,
    startsAt: iso(row.startsAt),
    endsAt: iso(row.endsAt),
    everyMinutes: row.everyMinutes,
    maxPerDay: row.maxPerDay,
    priority: row.priority,
    version: row.version,
  };
}

const CACHE_MS = 5_000;
const cache = new Map<string, { at: number; bundle: BrandingBundle }>();
export const clearBundleCache = () => cache.clear();

/**
 * Central side: the bundle of one licensed restaurant (Owner global design, the
 * restaurant's own design, active campaigns aimed at it). Same shape for hosted
 * restaurants (read directly) and installs (delivered in the signed heartbeat).
 */
export async function buildBundle(
  db: Db,
  customerId: string,
  at: Date = new Date(),
): Promise<BrandingBundle> {
  const hit = cache.get(customerId);
  if (hit && at.getTime() - hit.at < CACHE_MS) return hit.bundle;
  const [globalRow, customerRow, policy] = await Promise.all([
    db.brandingDesign.findUnique({ where: { key: 'global' } }),
    db.brandingDesign.findUnique({ where: { key: customerId } }),
    loadPolicy(db, customerId),
  ]);
  const design = resolveDesign(
    layerOf(globalRow?.config),
    layerOf(customerRow?.config),
  );
  const adsOn = policy.features['ads.display']?.mode !== 'OFF';
  const campaigns = adsOn
    ? await db.adCampaign.findMany({
        where: {
          status: 'ACTIVE',
          OR: [
            { endsAt: null },
            { endsAt: { gt: new Date(at.getTime() - 86_400_000) } },
          ],
          AND: [
            {
              OR: [
                { targetMode: 'ALL' },
                { targets: { some: { customerId } } },
              ],
            },
          ],
        },
        orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
        take: 50,
      })
    : [];
  const ads = campaigns.map(adDefOf);
  const mediaIds = [
    ...new Set([
      ...mediaOfDesign(design),
      ...ads.map((ad) => ad.mediaId).filter((id): id is string => !!id),
    ]),
  ];
  const media = mediaIds.length
    ? await db.brandingMedia.findMany({
        where: { id: { in: mediaIds } },
        select: {
          id: true,
          kind: true,
          mime: true,
          sha256: true,
          sizeBytes: true,
        },
        orderBy: { id: 'asc' },
      })
    : [];
  const body = {
    design,
    ads,
    media: media.map((row) => ({
      id: row.id,
      kind: row.kind,
      mime: row.mime,
      sha256: row.sha256,
      size: row.sizeBytes,
    })),
  };
  const bundle: BrandingBundle = { v: versionOf(body), ...body };
  cache.set(customerId, { at: at.getTime(), bundle });
  return bundle;
}

export type ResolvedBranding = {
  bundle: BrandingBundle;
  design: ResolvedDesign;
  // The restaurant Admin may adjust the design (the Owner delegated it).
  delegated: boolean;
  // The restaurant this server hosts or belongs to (for display counters).
  customerId: string | null;
};

/**
 * The branding of one restaurant on THIS server: from the control tables when the
 * restaurant is hosted here (or this is the central server), otherwise from the last
 * verified bundle cached by the install. A restaurant Admin's own layer is added only
 * while the Owner allows it.
 */
export async function resolveBranding(
  services: Services,
  tenantId: string | null,
  roleKeys: readonly string[] = [],
): Promise<ResolvedBranding> {
  const { db } = services;
  const at = services.now?.() ?? new Date();
  let bundle = emptyBundle();
  let customerId: string | null = null;
  const hosted = tenantId
    ? await db.controlCustomer.findUnique({
        where: { tenantId },
        select: { id: true },
      })
    : null;
  if (hosted) {
    customerId = hosted.id;
    bundle = await buildBundle(db, hosted.id, at);
  } else {
    const [row, link] = await Promise.all([
      db.brandingCache.findUnique({ where: { id: 1 } }),
      db.controlLink.findUnique({
        where: { id: 1 },
        select: { customerId: true },
      }),
    ]);
    customerId = link?.customerId ?? null;
    if (row) bundle = row.bundle as unknown as BrandingBundle;
    else if (services.control?.plane && !tenantId) {
      // The central server's own sign-in screen uses the Owner's global design.
      const globalRow = await db.brandingDesign.findUnique({
        where: { key: 'global' },
      });
      bundle = {
        ...emptyBundle(),
        design: resolveDesign(layerOf(globalRow?.config)),
      };
    }
  }
  let delegated = false;
  let design = bundle.design;
  if (tenantId) {
    const def = catalogByKey.get('design.admin');
    if (def && services.controlView) {
      const view = await services.controlView(tenantId);
      delegated = evaluateFeature(
        view.policy,
        def,
        roleKeys,
        view.adminSettings,
      ).online;
    }
    if (delegated) {
      const own = await db.tenantDesign.findUnique({ where: { tenantId } });
      const parsed = adminLayerSchema.safeParse(own?.config ?? {});
      if (parsed.success) design = resolveDesign(bundle.design, parsed.data);
    }
  }
  return { bundle, design, delegated, customerId };
}

/** Ads of the bundle that belong to one panel (the client applies dates and frequency). */
export const adsForPanel = (ads: AdDef[], panel: AdPanel | null): AdDef[] =>
  panel ? ads.filter((ad) => ad.panels.includes(panel)) : ads;

export { loadAdminData };
