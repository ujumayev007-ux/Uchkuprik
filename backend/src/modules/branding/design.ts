import { z } from 'zod';

/**
 * Remote design: six login/panel skins, per-panel assignment, login background, logo,
 * welcome message and splash. Layers are sparse and merged in this order:
 * defaults ← Owner "global" ← Owner per restaurant ← restaurant Admin (only when the
 * Owner delegated design). Removing a layer restores the one below it.
 */

export const SKINS = [
  'classic',
  'premium',
  'blue',
  'emerald',
  'minimal',
  'luxury',
] as const;
export type Skin = (typeof SKINS)[number];

export const DESIGN_PANELS = [
  'admin',
  'cashier',
  'waiter',
  'kitchen',
  'customer',
] as const;
export type DesignPanel = (typeof DESIGN_PANELS)[number];

/** Uzbek names shown in the Owner and Admin design screens. */
export const SKIN_LABELS: Record<Skin, { name: string; hint: string }> = {
  classic: {
    name: 'Klassik Fast Food',
    hint: 'To‘q sariq va oq (hozirgi dizayn)',
  },
  premium: { name: 'Premium qora', hint: 'Qora va oltin' },
  blue: { name: 'Zamonaviy ko‘k', hint: 'Ko‘k va oq' },
  emerald: { name: 'Zumrad yashil', hint: 'Yashil va oq' },
  minimal: { name: 'Minimal yorug‘', hint: 'Toza oq va kulrang' },
  luxury: { name: 'Hashamatli restoran', hint: 'To‘q bordo va oltin' },
};

const mediaId = z.uuid();
const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const skin = z.enum(SKINS);

const panelDesign = z
  .object({
    // Skin of the panel's working screens.
    skin: skin.nullable().optional(),
    // Skin of the sign-in screen when this panel's application is opened.
    loginSkin: skin.nullable().optional(),
  })
  .strict();

/** A sparse design layer as stored and as received from the Owner / Admin. */
export const designLayerSchema = z
  .object({
    login: z
      .object({
        skin: skin.nullable().optional(),
        background: mediaId.nullable().optional(),
        logo: mediaId.nullable().optional(),
        welcome: z.string().trim().max(140).nullable().optional(),
        accent: hexColor.nullable().optional(),
      })
      .strict()
      .optional(),
    panels: z
      .object({
        admin: panelDesign.optional(),
        cashier: panelDesign.optional(),
        waiter: panelDesign.optional(),
        kitchen: panelDesign.optional(),
        customer: panelDesign.optional(),
      })
      .strict()
      .optional(),
    splash: z
      .object({
        title: z.string().trim().max(60).nullable().optional(),
        subtitle: z.string().trim().max(100).nullable().optional(),
        logo: mediaId.nullable().optional(),
        skin: skin.nullable().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type DesignLayer = z.infer<typeof designLayerSchema>;

/** What a restaurant Admin may change when the Owner delegated design to them. */
export const adminLayerSchema = z
  .object({
    login: z
      .object({
        skin: skin.nullable().optional(),
        logo: mediaId.nullable().optional(),
        welcome: z.string().trim().max(140).nullable().optional(),
        accent: hexColor.nullable().optional(),
      })
      .strict()
      .optional(),
    panels: designLayerSchema.shape.panels,
  })
  .strict();

export type ResolvedDesign = {
  login: {
    skin: Skin;
    background: string | null;
    logo: string | null;
    welcome: string;
    accent: string | null;
  };
  panels: Record<DesignPanel, { skin: Skin; loginSkin: Skin | null }>;
  splash: {
    title: string;
    subtitle: string;
    logo: string | null;
    skin: Skin;
  };
};

export const defaultDesign = (): ResolvedDesign => ({
  login: {
    skin: 'classic',
    background: null,
    logo: null,
    welcome: '',
    accent: null,
  },
  panels: {
    admin: { skin: 'classic', loginSkin: null },
    cashier: { skin: 'classic', loginSkin: null },
    waiter: { skin: 'classic', loginSkin: null },
    kitchen: { skin: 'classic', loginSkin: null },
    customer: { skin: 'classic', loginSkin: null },
  },
  splash: {
    title: 'FAST FOOD',
    subtitle: 'Restoran boshqaruv tizimi',
    logo: null,
    skin: 'classic',
  },
});

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Applies a sparse layer: `undefined` and `null` leave the lower layer's value alone. */
function apply(
  target: Record<string, unknown>,
  patch: Record<string, unknown>,
) {
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || value === null) continue;
    const current = target[key];
    if (isObject(value) && isObject(current)) apply(current, value);
    else target[key] = value;
  }
}

export function layerOf(value: unknown): DesignLayer {
  const parsed = designLayerSchema.safeParse(value ?? {});
  return parsed.success ? parsed.data : {};
}

export function resolveDesign(
  ...layers: (DesignLayer | null | undefined)[]
): ResolvedDesign {
  const result = defaultDesign() as unknown as Record<string, unknown>;
  for (const layer of layers)
    if (layer) apply(result, layer as Record<string, unknown>);
  return result as unknown as ResolvedDesign;
}

/** Media ids a design layer refers to (they travel with the bundle). */
export function mediaOfDesign(design: ResolvedDesign): string[] {
  return [
    design.login.background,
    design.login.logo,
    design.splash.logo,
  ].filter((id): id is string => !!id);
}
