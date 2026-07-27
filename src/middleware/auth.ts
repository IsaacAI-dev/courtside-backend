import type { Request, Response, NextFunction } from 'express';
import { env } from '../env';

/** Static x-api-key gate (spec §9.1). /health is exempt so probes work unauthenticated. */
const EXEMPT = new Set(['/api/v1/health', '/health']);

export function apiKeyAuth(req: Request, res: Response, next: NextFunction): void {
  if (EXEMPT.has(req.path) || req.method === 'OPTIONS') {
    next();
    return;
  }
  const key = req.header('x-api-key');
  if (!key || key !== env.API_KEY) {
    res.status(401).json({
      error: { code: 'UNAUTHORISED', message: 'Missing or invalid x-api-key header', details: null },
      meta: { requestId: req.requestId },
    });
    return;
  }
  next();
}
