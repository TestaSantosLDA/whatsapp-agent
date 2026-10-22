import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import type { Hono } from 'hono';

const contentTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

/** Angular's output hashing: `main-ABCD1234.js`, `styles-EFGH5678.css`, `chunk-....js`. */
const hashedName = /-[A-Z0-9]{8}\.(?:js|mjs|css)$/;

/** Paths owned by the API: never answered with the simulator's index.html. */
const apiPrefixes = ['/sim/', '/webhook/', '/jobs/', '/static/'];

/**
 * Serves the built simulator from `dir` at `/`, with a fallback to index.html for client-side
 * routes. Hashed assets are cached for a year; index.html is revalidated on every load so a new
 * deploy is picked up straight away. Does nothing when `dir` does not exist (local dev, where
 * `ng serve` serves the simulator).
 */
export function serveSimulator(app: Hono, dir: string): boolean {
  if (!existsSync(join(dir, 'index.html'))) return false;
  const root = normalize(dir + sep);

  app.get('*', async (c, next) => {
    const path = decodeURIComponentSafe(c.req.path);
    if (path === undefined) return c.text('Bad request', 400);
    if (apiPrefixes.some((p) => path.startsWith(p))) return next();

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
  });
  return true;
}

function decodeURIComponentSafe(path: string): string | undefined {
  try {
    return decodeURIComponent(path);
  } catch {
    return undefined;
  }
}
