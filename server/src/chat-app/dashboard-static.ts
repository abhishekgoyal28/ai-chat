import { NestExpressApplication } from '@nestjs/platform-express';
import express from 'express';
import { existsSync } from 'fs';
import { join, resolve } from 'path';
import { logger } from '../shared/logger/logger';

export const DASHBOARD_PATH = '/admin';

/** The built dashboard: next to the server in the container image, or in the monorepo during development. */
const candidateDirectories = (): string[] => [
  process.env.DASHBOARD_DIR ?? '',
  resolve(__dirname, '../../public/dashboard'),
  resolve(__dirname, '../../../dashboard/dist'),
];

/**
 * Serves the dashboard single-page app at /admin. Unknown /admin/* paths
 * return index.html so client-side routes survive a reload; /admin/api/* is
 * never shadowed. `/` redirects to the dashboard.
 */
export const mountDashboard = (app: NestExpressApplication): void => {
  const directory = candidateDirectories().find((candidate) => candidate && existsSync(join(candidate, 'index.html')));
  if (!directory) {
    logger.warn('dashboard build not found — run `npm run build:dashboard`; the APIs work without it');
    return;
  }
  const indexFile = join(directory, 'index.html');
  app.use(DASHBOARD_PATH, express.static(directory, { index: false, maxAge: '1h' }));
  app.use(DASHBOARD_PATH, (request: express.Request, response: express.Response, next: express.NextFunction) => {
    if (request.method !== 'GET' || request.path.startsWith('/api')) {
      next();
      return;
    }
    response.setHeader('Cache-Control', 'no-cache');
    response.sendFile(indexFile);
  });
  app.use((request: express.Request, response: express.Response, next: express.NextFunction) => {
    if (request.method === 'GET' && request.path === '/') {
      response.redirect(DASHBOARD_PATH);
      return;
    }
    next();
  });
  logger.info({ directory }, 'dashboard mounted at /admin');
};
