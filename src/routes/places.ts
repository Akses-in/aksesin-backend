import { Router } from 'express';
import { env } from '../config/env.js';
import { PlaceImportError, toPlaceImportError } from '../services/place-import.js';
import {
  createPrismaPublicPlacesReader,
  publicPlacesQuerySchema,
  type PublicPlacesReader,
} from '../services/public-places.js';

export function createPlacesRouter(options?: { reader?: PublicPlacesReader }): Router {
  const router = Router();
  let defaultReader: PublicPlacesReader | undefined;

  const getReader = (): PublicPlacesReader => {
    if (options?.reader) return options.reader;
    if (!env.DATABASE_URL) {
      throw new PlaceImportError(503, 'DATABASE_UNAVAILABLE', 'Database tempat belum tersedia.');
    }
    defaultReader ??= createPrismaPublicPlacesReader();
    return defaultReader;
  };

  // GET /api/places?bbox=minLon,minLat,maxLon,maxLat&status=&limit=
  // Publik dan selalu membaca database, sehingga peta tetap terisi walau Overpass mati.
  router.get('/places', async (req, res, next) => {
    try {
      const query = publicPlacesQuerySchema.parse(
        Object.fromEntries(Object.entries(req.query).filter(([, value]) => value !== '')),
      );
      const result = await getReader().listInBounds(query);
      res.set('Cache-Control', 'public, max-age=60');
      res.json({ data: result });
    } catch (error) {
      const domainError = toPlaceImportError(error);
      if (!domainError) {
        next(error);
        return;
      }
      res.status(domainError.status).json({ error: { code: domainError.code, message: domainError.message } });
    }
  });

  return router;
}

export const placesRouter = createPlacesRouter();
