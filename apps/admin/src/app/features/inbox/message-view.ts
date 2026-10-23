import type { InboxMessage, MetaInboundMessage, MetaSendMessage } from '@wa/shared';

/** A transcript message, flattened for the template. */
export interface InboxMessageView {
  id: string;
  /** in: the customer. out: the agent or a person on the team. */
  side: 'in' | 'out';
  /** Who wrote it, for outbound: "Assistente" or the member's name. */
  author: string | null;
  byMember: boolean;
  at: string;
  kind: 'text' | 'image' | 'buttons' | 'list' | 'tap' | 'media' | 'unknown';
  text: string;
  header?: string;
  footer?: string;
  imageUrl?: string;
  /** Reply buttons or list rows the agent offered. */
  options?: { id: string; title: string; description?: string }[];
  listButton?: string;
}

export function toInboxMessageView(m: InboxMessage): InboxMessageView {
  const base = { id: m.id, at: m.at };
  if (m.direction === 'inbound') {
    const p = m.payload as MetaInboundMessage;
    const inbound = { ...base, side: 'in' as const, author: null, byMember: false };
    const tap = p.interactive?.button_reply ?? p.interactive?.list_reply;
    if (tap) return { ...inbound, kind: 'tap', text: tap.title };
    if (p.type === 'text') return { ...inbound, kind: 'text', text: p.text?.body ?? m.text };
    if (p.type === 'image') return { ...inbound, kind: 'media', text: p.image?.caption ?? '' };
    return { ...inbound, kind: m.text ? 'text' : 'media', text: m.text };
  }

  const out = {
    ...base,
    side: 'out' as const,
    author: m.sentBy ? m.sentBy.name || m.sentBy.email : 'Assistente',
    byMember: m.sentBy !== null,
  };
  const p = m.payload as MetaSendMessage;
  switch (p.type) {
    case 'text':
      return { ...out, kind: 'text', text: p.text.body };
    case 'image':
      return { ...out, kind: 'image', imageUrl: p.image.link, text: p.image.caption ?? '' };
    case 'interactive': {
      const i = p.interactive;
      const common = { header: i.header?.text, text: i.body.text, footer: i.footer?.text };
      if (i.type === 'button') {
        return {
          ...out,
          ...common,
          kind: 'buttons',
          options: i.action.buttons.map((b) => ({ id: b.reply.id, title: b.reply.title })),
        };
      }
      return {
        ...out,
        ...common,
        kind: 'list',
        listButton: i.action.button,
        options: i.action.sections.flatMap((s) =>
          s.rows.map((r) => ({ id: r.id, title: r.title, description: r.description })),
        ),
      };
    }
    default:
      return { ...out, kind: 'unknown', text: m.text };
  }
}
