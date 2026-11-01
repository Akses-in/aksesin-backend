import type { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';

export const errorHandler: ErrorRequestHandler = (error: unknown, _req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }

  if (error instanceof ZodError) {
    res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Input tidak valid.',
        details: error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      },
    });
    return;
  }

  if (typeof error === 'object' && error !== null && 'status' in error) {
    if (error.status === 400) {
      res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Request tidak valid.' } });
      return;
    }
    if (error.status === 413) {
      res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Body terlalu besar.' } });
      return;
    }
    if (error.status === 415) {
      res.status(415).json({ error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Format body tidak didukung.' } });
      return;
    }
  }

  console.error('Unhandled request error:', error instanceof Error ? error.name : 'UnknownError');
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Terjadi kesalahan pada server.' } });
};
