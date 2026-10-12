import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { messages, type MessageKey } from '../messages.js';

export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly messageKey: MessageKey,
    readonly details?: unknown,
  ) {
    super(code);
  }
}

export const errors = {
  validation: (details?: unknown) =>
    new AppError(400, 'VALIDATION_ERROR', 'validation', details),
  unauthenticated: () =>
    new AppError(401, 'UNAUTHENTICATED', 'unauthenticated'),
  forbidden: () => new AppError(403, 'FORBIDDEN', 'forbidden'),
  notFound: () => new AppError(404, 'NOT_FOUND', 'notFound'),
  conflict: () => new AppError(409, 'CONFLICT', 'conflict'),
};

export function sendError(res: Response, error: AppError): void {
  res.status(error.status).json({
    code: error.code,
    message: messages[error.messageKey],
    ...(error.details === undefined ? {} : { details: error.details }),
  });
}

/** Parses untrusted input; field paths are returned, raw values never are. */
export function parse<T extends z.ZodType>(
  schema: T,
  input: unknown,
): z.infer<T> {
  const result = schema.safeParse(input);
  if (!result.success)
    throw errors.validation(
      result.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        code: issue.code,
      })),
    );
  return result.data;
}

export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === 'P2002'
  );
}

export type Handler = (
  req: Request,
  res: Response,
  next: NextFunction,
) => unknown;
