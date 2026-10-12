import { fileURLToPath } from 'node:url';
import { config as loadDotEnv } from 'dotenv';
import { z } from 'zod';

const postgresUrl = z
  .string()
  .url()
  .superRefine((value, ctx) => {
    const url = URL.parse(value);
    if (
      !url ||
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      !url.hostname ||
      url.pathname.length < 2
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'A PostgreSQL database URL is required.',
      });
    }
    if (value.includes('REPLACE_WITH_')) {
      ctx.addIssue({
        code: 'custom',
        message: 'Replace example credentials before startup.',
      });
    }
  });

const schema = z
  .object({
    NODE_ENV: z
      .enum(['development', 'test', 'production'])
      .default('development'),
    HOST: z.string().min(1).default('127.0.0.1'),
    PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    APP_ORIGIN: z
      .string()
      .url()
      .refine((value) => {
        const url = URL.parse(value);
        return (
          !!url &&
          ['http:', 'https:'].includes(url.protocol) &&
          url.origin === value
        );
      }, 'Use an HTTP(S) origin without a path or trailing slash.'),
    DATABASE_URL: postgresUrl,
    SERVE_FRONTEND: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
    // 32 random bytes (base64). Encrypts MFA secrets and keys PIN hashes.
    APP_SECRET_KEY: z
      .string()
      .refine(
        (value) =>
          !value.includes('REPLACE_WITH_') &&
          Buffer.from(value, 'base64').length >= 32,
        'APP_SECRET_KEY must be at least 32 random bytes in base64.',
      ),
    // Number of trusted reverse-proxy hops (Render: 1). 0 trusts no forwarding headers.
    TRUST_PROXY: z.coerce.number().int().min(0).max(5).default(0),
    // Per-IP limit for login, PIN and public order requests (per minute).
    CREDENTIAL_RATE_LIMIT: z.coerce
      .number()
      .int()
      .min(1)
      .max(10_000)
      .default(20),
    // Self-service sign-ups per IP per hour; 0 disables public registration.
    SIGNUP_RATE_LIMIT: z.coerce.number().int().min(0).max(10_000).default(5),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
  })
  .superRefine((value, ctx) => {
    if (value.NODE_ENV !== 'production') return;
    if (!value.APP_ORIGIN.startsWith('https://')) {
      ctx.addIssue({
        code: 'custom',
        path: ['APP_ORIGIN'],
        message: 'Production requires HTTPS.',
      });
    }
    const sslMode = URL.parse(value.DATABASE_URL)?.searchParams.get('sslmode');
    if (sslMode !== 'verify-full') {
      ctx.addIssue({
        code: 'custom',
        path: ['DATABASE_URL'],
        message:
          'Production requires verified database TLS (sslmode=verify-full).',
      });
    }
  });

export type AppConfig = z.infer<typeof schema>;

export function parseConfig(env: NodeJS.ProcessEnv): AppConfig {
  const onRender = env.RENDER === 'true';
  const result = schema.safeParse({
    ...env,
    HOST: env.HOST ?? (onRender ? '0.0.0.0' : undefined),
    PORT: env.PORT ?? (onRender ? '10000' : undefined),
    TRUST_PROXY: env.TRUST_PROXY ?? (onRender ? '1' : undefined),
    APP_ORIGIN:
      env.APP_ORIGIN ?? (onRender ? env.RENDER_EXTERNAL_URL : undefined),
  });
  if (!result.success) {
    // Include field names only; validation errors must never echo credentials.
    const fields = [
      ...new Set(result.error.issues.map((issue) => issue.path.join('.'))),
    ];
    throw new Error(`Invalid environment configuration: ${fields.join(', ')}`);
  }
  return result.data;
}

export function loadEnvironment(): void {
  loadDotEnv({
    path: fileURLToPath(new URL('../../.env', import.meta.url)),
    quiet: true,
  });
}

export function loadConfig(): AppConfig {
  loadEnvironment();
  return parseConfig(process.env);
}
