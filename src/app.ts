import express from 'express';
import { requestId } from './middleware/requestId';
import { apiKeyAuth } from './middleware/auth';
import { errorHandler } from './middleware/errorHandler';
import { apiRouter } from './routes';
import { logger } from './lib/logger';

export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb' }));
  app.use(requestId);

  // Permissive CORS for the local React client; tighten for any real deployment.
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', req.header('origin') ?? '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type, x-api-key, x-request-id');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  });

  app.use((req, res, next) => {
    const started = Date.now();
    res.on('finish', () => {
      logger.debug(
        { method: req.method, path: req.originalUrl, status: res.statusCode, ms: Date.now() - started, requestId: req.requestId },
        'request',
      );
    });
    next();
  });

  app.use('/api/v1', apiKeyAuth, apiRouter);

  app.use((req, res) => {
    res.status(404).json({
      error: { code: 'ROUTE_NOT_FOUND', message: `No route for ${req.method} ${req.path}`, details: null },
      meta: { requestId: req.requestId },
    });
  });

  app.use(errorHandler);
  return app;
}
