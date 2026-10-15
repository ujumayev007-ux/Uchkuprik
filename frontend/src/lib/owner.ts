import { api, ApiError } from './api';

// Owner (SUPER_OWNER) API client. The Owner session is its own cookie; this module
// only adds the step-up (password + authenticator code) prompt on REAUTH_REQUIRED.

export type OwnerBridge = {
  // Public key and label of this Owner installation (private key never leaves it).
  deviceKey: () => Promise<{ publicKey: string; label: string }>;
  // Signs a JSON value with the installation's private key (canonical JSON).
  sign: (value: object) => Promise<string>;
};

export const ownerBridge = (): OwnerBridge | undefined =>
  (window as unknown as { fastfoodOwner?: OwnerBridge }).fastfoodOwner;

type Options = { method?: string; body?: unknown };
type ReauthPrompt = () => Promise<boolean>;
let reauthPrompt: ReauthPrompt | null = null;
export const setOwnerReauthPrompt = (prompt: ReauthPrompt | null) => {
  reauthPrompt = prompt;
};

/** Calls `/api/control<path>`; asks for step-up once when the server requires it. */
export async function ownerApi<T = unknown>(
  path: string,
  options: Options = {},
): Promise<T> {
  try {
    return await api<T>(`/control${path}`, options);
  } catch (error) {
    if (
      error instanceof ApiError &&
      error.code === 'REAUTH_REQUIRED' &&
      reauthPrompt &&
      (await reauthPrompt())
    )
      return api<T>(`/control${path}`, options);
    throw error;
  }
}

export const ownerPost = <T = unknown>(path: string, body: unknown = {}) =>
  ownerApi<T>(path, { method: 'POST', body });
export const ownerPut = <T = unknown>(path: string, body: unknown) =>
  ownerApi<T>(path, { method: 'PUT', body });
export const ownerPatch = <T = unknown>(path: string, body: unknown) =>
  ownerApi<T>(path, { method: 'PATCH', body });

// ---- types ------------------------------------------------------------------

export type Presence = 'ONLINE' | 'OFFLINE' | 'BLOCKED' | 'NEVER';

export type FeatureDef = {
  key: string;
  kind: 'panel' | 'module' | 'action' | 'button' | 'report_field' | 'financial';
  group: string;
  label: string;
  hint?: string;
  permission?: string;
  menuPath?: string;
  offlineCapable: boolean;
  defaultOffline: boolean;
  defaultMode?: 'ON' | 'OFF';
  sensitive?: boolean;
};

export type FeatureOverride = {
  mode?: 'ON' | 'OFF' | 'ADMIN';
  online?: boolean;
  offline?: boolean;
};

export type PolicyDoc = {
  version: number;
  features: Record<string, FeatureOverride>;
  offlineEnabled: boolean;
  maxOfflineMinutes: number;
  minAppVersion: string | null;
  minVersionFrom: string | null;
};

export type LicenseRow = {
  id: string;
  keyHint: string;
  status: 'ACTIVE' | 'SUSPENDED' | 'REVOKED';
  startsAt: string;
  expiresAt: string;
  daysLeft: number;
  expired: boolean;
  maxInstalls: number;
  maxDevices: number | null;
  maxBranches: number | null;
  maxUsers: number | null;
  features: string[];
  note: string | null;
  renewedAt: string | null;
};

export type TerminalRow = {
  id: string;
  name: string;
  branchName: string | null;
  panel: string;
  status: string;
  appVersion: string | null;
  model: string | null;
  os: string | null;
  lastSeenAt: string | null;
  lastIp: string | null;
  currentUser: string | null;
  presence: Presence;
};

export type DeviceRow = {
  id: string;
  customerId: string;
  customerName: string | null;
  deviceName: string;
  model: string | null;
  os: string | null;
  appVersion: string | null;
  branchName: string | null;
  status: 'ACTIVE' | 'BLOCKED' | 'REPLACED' | 'REVOKED';
  presence: Presence;
  activatedAt: string;
  lastHeartbeatAt: string | null;
  lastIp: string | null;
  currentUser: string | null;
  stats: Record<string, number | string | boolean | null> | null;
  blockedReason: string | null;
  terminals: TerminalRow[];
};

export type CustomerSummary = {
  id: string;
  name: string;
  contactName: string | null;
  phone: string | null;
  status: 'ACTIVE' | 'SUSPENDED' | 'CLOSED';
  license: LicenseRow | null;
  devices: Record<Presence, number>;
  branchCount: number;
  createdAt: string;
};

export type CustomerDetail = {
  id: string;
  name: string;
  contactName: string | null;
  phone: string | null;
  note: string | null;
  status: CustomerSummary['status'];
  createdAt: string;
  licenses: LicenseRow[];
  devices: DeviceRow[];
  branches: {
    id: string;
    code: string;
    name: string;
    isActive: boolean;
    lastReportedAt: string;
  }[];
  payments: {
    id: string;
    amount: number;
    currency: string;
    method: string;
    periodMonths: number;
    reference: string | null;
    paidAt: string;
  }[];
  policy: PolicyDoc;
};
