import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';

export type Me = {
  userId: string;
  tenantId: string;
  tenantKind: 'PLATFORM' | 'BUSINESS';
  username: string;
  displayName: string;
  isPlatformAdmin: boolean;
  authMethod: 'PASSWORD' | 'PIN';
  permissions: string[];
  roleKeys: string[];
  allBranches: boolean;
  branchIds: string[];
  activeBranchId: string | null;
  deviceId: string | null;
  mfaEnabled: boolean;
  mfaVerified: boolean;
  mfaSetupRequired: boolean;
  mustChangePassword: boolean;
  tenant: { name: string; slug: string };
  entitlements: {
    planCode: string | null;
    status: string | null;
    // Null means unrestricted.
    features: string[] | null;
    limits: {
      branches: number | null;
      users: number | null;
      devices: number | null;
    };
  };
  financial?: { cost: boolean; margin: boolean; profit: boolean };
  control?: {
    mode: string;
    reason: string | null;
    offlineUntil: string | null;
  };
  billing: {
    status: string;
    trialEndsAt: string | null;
    trialDaysLeft: number | null;
    openInvoice: { amount: number; dueDate: string } | null;
  } | null;
};

export const meKey = ['auth', 'me'] as const;

/** Resolves the current session; null means signed out. */
export function useMe() {
  return useQuery({
    queryKey: meKey,
    queryFn: async () => {
      try {
        return await api<Me>('/auth/me');
      } catch (error) {
        if (
          error instanceof ApiError &&
          (error.status === 401 || error.code === 'TENANT_SUSPENDED')
        )
          return null;
        throw error;
      }
    },
    staleTime: 30_000,
    retry: (count, error) =>
      !(error instanceof ApiError && error.status > 0) && count < 2,
  });
}

export function useRefreshMe() {
  const client = useQueryClient();
  return () => client.invalidateQueries({ queryKey: meKey });
}

export function can(me: Me | null | undefined, permission: string) {
  return (
    !!me && me.tenantKind === 'BUSINESS' && me.permissions.includes(permission)
  );
}

/** Whether the tenant's plan includes an optional module (the server enforces it too). */
export function hasFeature(me: Me | null | undefined, feature: string) {
  if (!me || me.tenantKind !== 'BUSINESS') return false;
  const features = me.entitlements?.features ?? null;
  return features === null || features.includes(feature);
}
