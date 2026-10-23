import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import type { Context, Hono, Next } from 'hono';

const contentTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

/**
 * Angular's output hashing: `main-ABCD1234.js`, `styles-EFGH5678.css`, and lazy chunks in mixed
 * case such as `chunk-DOy8qFOw.js` or `chunk-D-Rz4jH9.js`.
 */
const hashedName = /-[A-Za-z0-9_-]{8}\.(?:js|mjs|css)$/;

/** Paths owned by the API: never answered with an app's index.html. */
const apiPrefixes = ['/api/', '/sim/', '/webhook/', '/jobs/', '/static/'];

/** Where the team dashboard (WA-022) is served; the simulator never answers at or below it. */
export const ADMIN_BASE = '/admin';

/**
 * Serves a built Angular app from `dir` at `base` (`/`, or e.g. `/admin`), with a fallback to
 * index.html for client-side routes. Hashed assets are cached for a year; index.html is
 * revalidated on every load so a new deploy is picked up straight away. Does nothing when `dir`
 * does not exist (local dev, where `ng serve` serves the app). Register it after the API routes.
 */
export function serveSpa(
  app: Hono,
  dir: string,
  opts: { base?: string; exclude?: string[] } = {},
): boolean {
  if (!existsSync(join(dir, 'index.html'))) return false;
  const root = normalize(dir + sep);
  const base = (opts.base ?? '').replace(/\/+$/, '');
  const exclude = opts.exclude ?? [];

  const handler = async (c: Context, next: Next) => {
    const fullPath = decodeURIComponentSafe(c.req.path);
    if (fullPath === undefined) return c.text('Bad request', 400);
    if (apiPrefixes.some((p) => fullPath.startsWith(p))) return next();
    if (exclude.some((p) => fullPath === p || fullPath.startsWith(`${p}/`))) return next();
    const path = fullPath.slice(base.length) || '/';

    const file = normalize(join(root, path));
    if (file.startsWith(root) && extname(file)) {
      const body = await readFile(file).catch(() => undefined);
      if (body) {
        const name = file.slice(root.length);
        return c.body(body, 200, {
          'content-type': contentTypes[extname(file)] ?? 'application/octet-stream',
          'cache-control': hashedName.test(name)
            ? 'public, max-age=31536000, immutable'
            : 'public, max-age=3600',
        });
      }
      // A missing file with an extension is a real 404, not a client-side route.
      return next();
    }

    if (!(c.req.header('accept') ?? '').includes('text/html') && path !== '/') return next();
    const index = await readFile(join(root, 'index.html'));
    return c.body(index, 200, {
      'content-type': contentTypes['.html']!,
      'cache-control': 'no-cache',
    });
  };

  if (base) {
    app.get(base, handler);
    app.get(`${base}/*`, handler);
  } else {
    app.get('*', handler);
  }
  return true;
}

/** The simulator at `/` (WA-020). Everything at or below /admin belongs to the dashboard. */
export function serveSimulator(app: Hono, dir: string): boolean {
  return serveSpa(app, dir, { exclude: [ADMIN_BASE] });
}

/** The team dashboard at /admin (WA-022), built with `baseHref: /admin/`. */
export function serveAdmin(app: Hono, dir: string): boolean {
  return serveSpa(app, dir, { base: ADMIN_BASE });
}

function decodeURIComponentSafe(path: string): string | undefined {
  try {
    return decodeURIComponent(path);
  } catch {
    return undefined;
  }
}
