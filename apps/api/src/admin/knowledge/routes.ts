/**
 * /api/admin/clients/:clientId/knowledge (WA-026). Everyone on the team can read; uploads,
 * replacements, deletions and decisions are for admins.
 *
 *   GET    /documents                        list with status and counts
 *   POST   /documents                        upload (multipart, field `file`)
 *   GET    /documents/:id                    detail: proposals and passages
 *   PUT    /documents/:id                    replace the file (multipart, field `file`)
 *   DELETE /documents/:id?removeData=true    delete (and the data approved from it)
 *   POST   /documents/:id/proposals          bulk approve or reject
 *   POST   /proposals/:id                    approve (optionally edited) or reject one
 */
import { bulkDecisionSchema, KNOWLEDGE_MAX_BYTES, proposalDecisionSchema } from '@wa/shared';
import type { Context } from 'hono';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { adminError, parseBody, requireAdmin, type AdminEnv } from '../context.js';
import type { AdminDeps } from '../deps.js';
import type { UploadedFile } from './service.js';

/** Room for the multipart envelope around the largest accepted file. */
const MAX_REQUEST_BYTES = KNOWLEDGE_MAX_BYTES + 256 * 1024;

const uploadLimit = bodyLimit({
  maxSize: MAX_REQUEST_BYTES,
  onError: () => {
    throw adminError(
      413,
      'too_large',
      `O ficheiro é maior do que ${KNOWLEDGE_MAX_BYTES / 1024 / 1024} MB.`,
    );
  },
});

export function knowledgeRoutes({ knowledge }: AdminDeps) {
  const routes = new Hono<AdminEnv>();

  routes.get('/documents', async (c) => c.json(await knowledge.list(c.get('admin').client.id)));

  routes.get('/documents/:id', async (c) =>
    c.json(await knowledge.detail(c.get('admin').client, c.req.param('id'))),
  );

  routes.post('/documents', requireAdmin, uploadLimit, async (c) => {
    const ctx = c.get('admin');
    const file = await uploadedFile(c);
    return c.json(await knowledge.upload(ctx.client.id, file, ctx.member.id), 201);
  });

  routes.put('/documents/:id', requireAdmin, uploadLimit, async (c) => {
    const ctx = c.get('admin');
    const file = await uploadedFile(c);
    return c.json(await knowledge.replace(ctx.client.id, c.req.param('id'), file, ctx.member.id));
  });

  routes.delete('/documents/:id', requireAdmin, async (c) => {
    const removeData = c.req.query('removeData') === 'true';
    await knowledge.remove(c.get('admin').client, c.req.param('id'), removeData);
    return c.body(null, 204);
  });

  routes.post('/documents/:id/proposals', requireAdmin, async (c) => {
    const ctx = c.get('admin');
    const body = await parseBody(c, bulkDecisionSchema);
    return c.json(await knowledge.decideMany(ctx.client, c.req.param('id'), body, ctx.member.id));
  });

  routes.post('/proposals/:id', requireAdmin, async (c) => {
    const ctx = c.get('admin');
    const body = await parseBody(c, proposalDecisionSchema);
    return c.json(await knowledge.decide(ctx.client, c.req.param('id'), body, ctx.member.id));
  });

  return routes;
}

async function uploadedFile(c: Context<AdminEnv>): Promise<UploadedFile> {
  if (!c.req.header('content-type')?.startsWith('multipart/form-data')) {
    throw adminError(
      400,
      'invalid_body',
      'Envie o ficheiro como multipart/form-data (campo "file").',
    );
  }
  const form = await c.req.parseBody().catch(() => {
    throw adminError(400, 'invalid_body', 'Não foi possível ler o envio.');
  });
  const file = form['file'];
  if (!(file instanceof File))
    throw adminError(400, 'invalid_body', 'Falta o ficheiro (campo "file").');
  return { name: file.name, body: new Uint8Array(await file.arrayBuffer()) };
}
