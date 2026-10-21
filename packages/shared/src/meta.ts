/**
 * The subset of the WhatsApp Cloud API JSON we use.
 * Inbound: webhook notifications. Outbound: the body of POST /<phone_number_id>/messages.
 * The simulator speaks exactly these shapes, so switching a client to real WhatsApp changes config, not code.
 */
import { z } from 'zod';

// ---------- Inbound (webhook) ----------

export const metaInboundMessageSchema = z.object({
  from: z.string(),
  id: z.string(),
  timestamp: z.string(),
  type: z.string(),
  text: z.object({ body: z.string() }).optional(),
  interactive: z
    .object({
      type: z.enum(['button_reply', 'list_reply']),
      button_reply: z.object({ id: z.string(), title: z.string() }).optional(),
      list_reply: z
        .object({ id: z.string(), title: z.string(), description: z.string().optional() })
        .optional(),
    })
    .optional(),
  image: z
    .object({
      id: z.string(),
      mime_type: z.string().optional(),
      sha256: z.string().optional(),
      caption: z.string().optional(),
    })
    .optional(),
  context: z.object({ from: z.string().optional(), id: z.string() }).optional(),
});
export type MetaInboundMessage = z.infer<typeof metaInboundMessageSchema>;

export const metaWebhookSchema = z.object({
  object: z.literal('whatsapp_business_account'),
  entry: z.array(
    z.object({
      id: z.string(),
      changes: z.array(
        z.object({
          field: z.string(),
          value: z.object({
            messaging_product: z.literal('whatsapp'),
            metadata: z.object({
              display_phone_number: z.string(),
              phone_number_id: z.string(),
            }),
            contacts: z
              .array(z.object({ profile: z.object({ name: z.string() }), wa_id: z.string() }))
              .optional(),
            messages: z.array(metaInboundMessageSchema).optional(),
            statuses: z.array(z.unknown()).optional(),
          }),
        }),
      ),
    }),
  ),
});
export type MetaWebhook = z.infer<typeof metaWebhookSchema>;

// ---------- Outbound (send message) ----------

const replyButtonSchema = z.object({
  type: z.literal('reply'),
  reply: z.object({ id: z.string().max(256), title: z.string().max(20) }),
});

const listRowSchema = z.object({
  id: z.string().max(200),
  title: z.string().max(24),
  description: z.string().max(72).optional(),
});

export const metaSendMessageSchema = z.discriminatedUnion('type', [
  z.object({
    messaging_product: z.literal('whatsapp'),
    recipient_type: z.literal('individual'),
    to: z.string(),
    type: z.literal('text'),
    text: z.object({ body: z.string().max(4096), preview_url: z.boolean().optional() }),
  }),
  z.object({
    messaging_product: z.literal('whatsapp'),
    recipient_type: z.literal('individual'),
    to: z.string(),
    type: z.literal('image'),
    image: z.object({ link: z.string().url(), caption: z.string().max(1024).optional() }),
  }),
  z.object({
    messaging_product: z.literal('whatsapp'),
    recipient_type: z.literal('individual'),
    to: z.string(),
    type: z.literal('interactive'),
    interactive: z.discriminatedUnion('type', [
      z.object({
        type: z.literal('button'),
        header: z.object({ type: z.literal('text'), text: z.string().max(60) }).optional(),
        body: z.object({ text: z.string().max(1024) }),
        footer: z.object({ text: z.string().max(60) }).optional(),
        action: z.object({ buttons: z.array(replyButtonSchema).min(1).max(3) }),
      }),
      z.object({
        type: z.literal('list'),
        header: z.object({ type: z.literal('text'), text: z.string().max(60) }).optional(),
        body: z.object({ text: z.string().max(4096) }),
        footer: z.object({ text: z.string().max(60) }).optional(),
        action: z.object({
          button: z.string().max(20),
          sections: z
            .array(
              z.object({
                title: z.string().max(24).optional(),
                rows: z.array(listRowSchema).min(1),
              }),
            )
            .min(1)
            .max(10),
        }),
      }),
    ]),
  }),
]);
export type MetaSendMessage = z.infer<typeof metaSendMessageSchema>;
