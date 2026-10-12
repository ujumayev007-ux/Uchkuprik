import { z } from 'zod/mini';

const healthSchema = z.object({
  status: z.enum(['ok', 'unavailable']),
  message: z.string(),
});

export async function getReadiness(
  signal: AbortSignal,
): Promise<'ready' | 'unavailable'> {
  const response = await fetch('/api/health/ready', {
    signal,
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  });
  if (response.status !== 200 && response.status !== 503)
    throw new Error('Unexpected response');
  const payload = healthSchema.parse(await response.json());
  if (response.status === 200 && payload.status === 'ok') return 'ready';
  if (response.status === 503 && payload.status === 'unavailable')
    return 'unavailable';
  throw new Error('Inconsistent readiness response');
}
