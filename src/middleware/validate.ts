import type { Request, Response, NextFunction } from 'express';
import { ZodError, type ZodSchema } from 'zod';
import { AppError } from '../lib/errors';

export const validateQuery =
  <T>(schema: ZodSchema<T>) =>
  (req: Request, _res: Response, next: NextFunction): void => {
    try {
      (req as Request & { validQuery: T }).validQuery = schema.parse(req.query);
      next();
    } catch (err) {
      next(
        err instanceof ZodError
          ? new AppError('INVALID_QUERY', 'Query parameters failed validation', 400, err.flatten())
          : err,
      );
    }
  };

export const validateBody =
  <T>(schema: ZodSchema<T>) =>
  (req: Request, _res: Response, next: NextFunction): void => {
    try {
      req.body = schema.parse(req.body);
      next();
    } catch (err) {
      next(
        err instanceof ZodError
          ? new AppError('INVALID_BODY', 'Request body failed validation', 400, err.flatten())
          : err,
      );
    }
  };

export const q = <T>(req: Request): T => (req as Request & { validQuery: T }).validQuery;
