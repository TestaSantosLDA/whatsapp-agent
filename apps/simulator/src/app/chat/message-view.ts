import type { MetaSendMessage, SimChatMessage } from '@wa/shared';

type Interactive = Extract<MetaSendMessage, { type: 'interactive' }>['interactive'];
export type ListInteractive = Extract<Interactive, { type: 'list' }>;

/** Flat, template-friendly view of a chat message. */
export interface MessageView {
  id: string;
  /** 'in' = sent by the customer (right, green); 'out' = business reply (left, white). */
  side: 'in' | 'out';
  kind: 'text' | 'image' | 'buttons' | 'list' | 'unknown';
  timestamp: string;
  status?: 'sent' | 'read';
  text?: string;
  header?: string;
  footer?: string;
  imageUrl?: string;
  buttons?: { id: string; title: string }[];
  listButton?: string;
  list?: ListInteractive;
}

export function toMessageView(m: SimChatMessage): MessageView {
  if (m.direction === 'inbound') {
    return {
      id: m.id,
      side: 'in',
      kind: 'text',
      timestamp: m.timestamp,
      status: m.status,
      text: m.text,
    };
  }
  const base = { id: m.id, side: 'out' as const, timestamp: m.timestamp };
  const p = m.payload;
  switch (p.type) {
    case 'text':
      return { ...base, kind: 'text', text: p.text.body };
    case 'image':
      return {
        ...base,
        kind: 'image',
        imageUrl: localizeStaticUrl(p.image.link),
        text: p.image.caption,
      };
    case 'interactive': {
      const i = p.interactive;
      const common = { header: i.header?.text, text: i.body.text, footer: i.footer?.text };
      if (i.type === 'button') {
        return {
          ...base,
          ...common,
          kind: 'buttons',
          buttons: i.action.buttons.map((b) => ({ id: b.reply.id, title: b.reply.title })),
        };
      }
      return { ...base, ...common, kind: 'list', listButton: i.action.button, list: i };
    }
    default:
      return { ...base, kind: 'unknown', text: JSON.stringify(p) };
  }
}

/**
 * The API builds image links from PUBLIC_BASE_URL (http://localhost:3000 in dev). A phone on the LAN
 * cannot reach that host, so localhost /static/ links are made relative and go through the dev proxy.
 */
export function localizeStaticUrl(link: string): string {
  try {
    const u = new URL(link);
    if (/^(localhost|127\.0\.0\.1)$/.test(u.hostname) && u.pathname.startsWith('/static/')) {
      return u.pathname + u.search;
    }
  } catch {
    // not an absolute URL; use as is
  }
  return link;
}
