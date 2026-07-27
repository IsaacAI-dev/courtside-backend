import { randomUUID } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId: string;
    }
  }
}

export function requestId(req: Request, res: Response, next: NextFunction): void {
  req.requestId = (req.header('x-request-id') || randomUUID()).slice(0, 64);
  res.setHeader('x-request-id', req.requestId);
  next();
}
