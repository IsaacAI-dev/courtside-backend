import type { Request, Response, NextFunction } from 'express';
import { AppError } from '../lib/errors';
import { logger } from '../lib/logger';
import { BetanoNotConfiguredError, BetanoSessionExpiredError } from '../adapters/betano/adapter';
import { SofaScoreSessionExpiredError } from '../adapters/sofascore';

/** Uniform error envelope (spec §9.1). */
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  const requestId = req.requestId;

  if (err instanceof AppError) {
    res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details },
      meta: { requestId },
    });
    return;
  }
  if (err instanceof BetanoNotConfiguredError) {
    res.status(503).json({
      error: { code: 'BETANO_NOT_CONFIGURED', message: err.message, details: null },
      meta: { requestId },
    });
    return;
  }
  if (err instanceof BetanoSessionExpiredError || err instanceof SofaScoreSessionExpiredError) {
    res.status(401).json({
      error: {
        code: 'SESSION_EXPIRED',
        message: err.message,
        details: { action: 'Re-capture the session cookie and User-Agent from a fresh manual browser visit, then update .env' },
      },
      meta: { requestId },
    });
    return;
  }
  // Prisma "record not found"
  if (typeof err === 'object' && err && (err as { code?: string }).code === 'P2025') {
    res.status(404).json({
      error: { code: 'NOT_FOUND', message: 'Record not found', details: null },
      meta: { requestId },
    });
    return;
  }
  logger.error({ err: String(err), requestId, path: req.path }, 'unhandled error');
  res.status(500).json({
    error: { code: 'INTERNAL_ERROR', message: 'Unexpected server error', details: null },
    meta: { requestId },
  });
}

/** Wrap async handlers so rejections reach the error middleware. */
export const asyncRoute =
  <T>(fn: (req: Request, res: Response) => Promise<T>) =>
  (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res).catch(next);
  };
