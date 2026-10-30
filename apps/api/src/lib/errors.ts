import { ERROR_CODES, type ErrorCode } from '@sk-cinema/shared';

/**
 * An error whose code and message are safe to show to clients.
 * Anything else that reaches the error handler becomes a generic 500.
 */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const notFound = (message = 'Not found') =>
  new AppError(404, ERROR_CODES.NOT_FOUND, message);
