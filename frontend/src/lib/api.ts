import { t } from '../i18n';
import { reportFailure, reportOk } from './serverState';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

type ReauthHandler = () => Promise<boolean>;
let reauthHandler: ReauthHandler | null = null;

/** Registered by the ReauthDialog; resolves true once the user re-authenticated. */
export function setReauthHandler(handler: ReauthHandler | null) {
  reauthHandler = handler;
}

type Options = { method?: string; body?: unknown; signal?: AbortSignal };

async function send(path: string, options: Options): Promise<Response> {
  return fetch(`/api${path}`, {
    method: options.method ?? 'GET',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: {
      Accept: 'application/json',
      // Offline rules allow orders only from the Cashier panel (server verifies it).
      ...(window.location.pathname.startsWith('/kassa')
        ? { 'X-Panel': 'cashier' }
        : {}),
      ...(options.body === undefined
        ? {}
        : { 'Content-Type': 'application/json' }),
    },
    ...(options.body === undefined
      ? {}
      : { body: JSON.stringify(options.body) }),
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

export async function api<T = unknown>(
  path: string,
  options: Options = {},
): Promise<T> {
  let response: Response;
  try {
    response = await send(path, options);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError')
      throw error;
    reportFailure();
    throw new ApiError(0, 'NETWORK', t.common.errorOffline);
  }
  // A gateway error, or an HTML page where our JSON should be (a host that is still
  // waking up), means the server is not ready: never treat it as an answer. A JSON
  // answer, even a 503 from our own rules, is always real.
  const isJson = (response.headers.get('content-type') ?? '').includes('json');
  if (
    !isJson &&
    response.status !== 204 &&
    (response.ok || [502, 503, 504].includes(response.status))
  ) {
    reportFailure();
    throw new ApiError(0, 'NETWORK', t.common.errorOffline);
  }
  reportOk();
  if (response.status === 204) return undefined as T;
  const payload = (await response.json().catch(() => null)) as {
    code?: string;
    message?: string;
    details?: unknown;
  } | null;
  if (response.ok) return payload as T;
  const error = new ApiError(
    response.status,
    payload?.code ?? 'UNKNOWN',
    payload?.message ?? t.common.errorTitle,
    payload?.details,
  );
  // Privileged operations need a fresh password check; ask once, then retry.
  if (
    error.code === 'REAUTH_REQUIRED' &&
    reauthHandler &&
    (await reauthHandler())
  )
    return api<T>(path, options);
  throw error;
}

export const post = <T = unknown>(path: string, body?: unknown) =>
  api<T>(path, { method: 'POST', body: body ?? {} });
export const patch = <T = unknown>(path: string, body: unknown) =>
  api<T>(path, { method: 'PATCH', body });
export const del = <T = unknown>(path: string) =>
  api<T>(path, { method: 'DELETE' });

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return t.common.errorTitle;
}

/** Uploads a photo as evidence; the server checks the real image type and size. */
export async function uploadEvidence(
  file: File,
  path = '/api/operations/evidence',
): Promise<string> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
      body: file,
    });
  } catch {
    throw new ApiError(0, 'NETWORK', t.common.errorOffline);
  }
  const payload = (await response.json().catch(() => null)) as {
    id?: string;
    code?: string;
    message?: string;
  } | null;
  if (!response.ok || !payload?.id)
    throw new ApiError(
      response.status,
      payload?.code ?? 'UNKNOWN',
      payload?.message ?? t.common.errorTitle,
    );
  return payload.id;
}
