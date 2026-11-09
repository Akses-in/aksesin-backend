import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { env } from './config/env.js';
import { errorHandler } from './middleware/error-handler.js';
import { router } from './routes/index.js';

export const app = express();

app.disable('x-powered-by');
app.use(helmet());
app.use(cors({ origin: env.CORS_ORIGINS }));
app.use((req, res, next) => {
  if (req.path.startsWith('/api/card-applications')) {
    next();
    return;
  }
  express.json({ limit: '100kb' })(req, res, next);
});
app.use(router);
app.use((_req, res) => {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Endpoint tidak ditemukan.' } });
});
app.use(errorHandler);
