import type { Request, Response } from 'express';

export const ok = <T>(req: Request, res: Response, data: T, extraMeta: Record<string, unknown> = {}): void => {
  res.json({ data, meta: { requestId: req.requestId, ...extraMeta } });
};

export const accepted = <T>(req: Request, res: Response, data: T): void => {
  res.status(202).json({ data, meta: { requestId: req.requestId } });
};
