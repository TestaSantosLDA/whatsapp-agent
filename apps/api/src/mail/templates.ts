/**
 * Emails to the client's team (WA-015), in pt-PT: new lead, handoff, order draft. Plain text
 * plus a simple HTML version that renders in Gmail and Outlook (inline styles, one table).
 * Customer words are quoted as given, whatever their language.
 */
import type { Branch, ClientConfig } from '@wa/shared';
import type { Email, EmailKind } from './mailer.js';

export interface EmailContext {
  client: ClientConfig;
  branch: Branch;
  conversationId?: string;
  contact: { name: string | null; waId: string };
}

/** A branch's lead recipients: `lead_emails`, else the branch email, else nobody. */
export function branchRecipients(branch: Branch): string[] {
  if (branch.lead_emails.length) return branch.lead_emails;
  return branch.email ? [branch.email] : [];
}

const requestTypeLabels: Record<string, string> = {
  info: 'Pedido de informação',
  quote: 'Pedido de orçamento',
  sample: 'Pedido de amostra',
  order: 'Encomenda',
};

export function requestTypeLabel(type: string): string {
  return requestTypeLabels[type] ?? type;
}

const reasonLabels: Record<string, string> = {
  customer_asked: 'O cliente pediu para falar com uma pessoa',
  complaint: 'Reclamação',
  repeated_misunderstanding: 'O assistente não conseguiu perceber o pedido',
  needs_decision: 'Precisa de uma decisão da equipa',
  large_project: 'Projeto grande ou complexo',
  could_not_help: 'O assistente não conseguiu ajudar',
  technical_problem: 'Problema técnico do assistente',
  other: 'Outro motivo',
};

type Field = [label: string, value: string | number | null | undefined];

export function leadEmail(
  ctx: EmailContext,
  lead: {
    requestType: string;
    summary: string;
    fields: Field[];
    attachments: number;
  },
): Email {
  const who = customerName(ctx);
  const label = requestTypeLabel(lead.requestType);
  return render(ctx, 'lead', {
    subject: `${label}: ${who} (WhatsApp)`,
    heading: `${label} recebido pelo WhatsApp`,
    intro: `O assistente do WhatsApp recolheu um pedido para ${ctx.branch.name}. Responda ao cliente em ${ctx.client.lead.response_time}.`,
    fields: [
      ...lead.fields,
      ...(lead.attachments
        ? ([['Anexos', `${lead.attachments} (imagens ou documentos na conversa)`]] as Field[])
        : []),
    ],
    summary: lead.summary,
  });
}

export function handoffEmail(
  ctx: EmailContext,
  handoff: { reason: string; urgency: 'normal' | 'high'; summary: string; fields?: Field[] },
): Email {
  const who = customerName(ctx);
  const urgent = handoff.urgency === 'high';
  return render(ctx, 'handoff', {
    subject: `${urgent ? '[URGENTE] ' : ''}Cliente à espera de um colega: ${who} (WhatsApp)`,
    heading: 'Um cliente precisa de falar com um colega',
    intro:
      'O assistente passou esta conversa para a equipa e deixou de responder. Responda ao cliente pelo WhatsApp; no simulador, devolva a conversa ao assistente quando terminar.',
    fields: [
      ['Motivo', reasonLabels[handoff.reason] ?? handoff.reason],
      ['Urgência', urgent ? 'Alta' : 'Normal'],
      ...(handoff.fields ?? []),
    ],
    summary: handoff.summary,
  });
}

export interface DraftLine {
  title: string;
  variant?: string | null;
  sku?: string | null;
  quantity: number;
  unitPriceEur?: number;
  lineTotalEur?: number;
}

export function orderDraftEmail(
  ctx: EmailContext,
  draft: {
    lines: DraftLine[];
    subtotalEur: number | null;
    fulfilment: string;
    reason: string;
    summary: string;
    fields: Field[];
  },
): Email {
  const who = customerName(ctx);
  const lines = draft.lines.map((l) => {
    const name = [l.title, l.variant, l.sku ? `ref. ${l.sku}` : null].filter(Boolean).join(' · ');
    const price =
      l.lineTotalEur === undefined
        ? 'preço a confirmar'
        : `${eur(l.unitPriceEur!)} x ${l.quantity} = ${eur(l.lineTotalEur)}`;
    return { name, quantity: l.quantity, price };
  });
  const email = render(ctx, 'order_draft', {
    subject: `Rascunho de encomenda: ${who} (WhatsApp)`,
    heading: 'Rascunho de encomenda para confirmar',
    intro:
      'Esta encomenda não pode seguir por link de checkout. Confirme com o cliente o preço final, o transporte e o pagamento.',
    fields: [
      ['Motivo', draft.reason],
      ['Entrega', draft.fulfilment],
      ...draft.fields,
      [
        'Subtotal dos produtos (IVA incl., sem transporte)',
        draft.subtotalEur === null ? null : eur(draft.subtotalEur),
      ],
    ],
    summary: draft.summary,
    lines,
  });
  return email;
}

function customerName(ctx: EmailContext): string {
  return ctx.contact.name?.trim() || `+${ctx.contact.waId}`;
}

const eurFormat = new Intl.NumberFormat('pt-PT', { style: 'currency', currency: 'EUR' });
function eur(value: number): string {
  return eurFormat.format(value);
}

function render(
  ctx: EmailContext,
  kind: EmailKind,
  body: {
    subject: string;
    heading: string;
    intro: string;
    fields: Field[];
    summary: string;
    lines?: { name: string; quantity: number; price: string }[];
  },
): Email {
  const phone = `+${ctx.contact.waId}`;
  const waLink = `https://wa.me/${ctx.contact.waId}`;
  const fields: [string, string][] = [
    ['Cliente', ctx.contact.name?.trim() || '(sem nome)'],
    ['Telefone', phone],
    ...body.fields.flatMap(([label, value]): [string, string][] =>
      value === null || value === undefined || value === '' ? [] : [[label, String(value)]],
    ),
    ['Loja', ctx.branch.name],
  ];

  const text = [
    body.heading,
    '',
    body.intro,
    '',
    ...fields.map(([label, value]) => `${label}: ${value}`),
    ...(body.lines?.length
      ? ['', 'Produtos:', ...body.lines.map((l) => `- ${l.name}: ${l.price}`)]
      : []),
    '',
    'Resumo:',
    body.summary,
    '',
    `Conversa no WhatsApp: ${waLink}`,
    '',
    `— Assistente WhatsApp de ${ctx.client.name}`,
  ].join('\n');

  const cell = 'padding:6px 12px 6px 0;vertical-align:top;';
  const html = `<!doctype html>
<html lang="pt-PT"><body style="margin:0;padding:24px;background:#f6f6f6;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#222;">
<div style="max-width:600px;margin:0 auto;background:#ffffff;padding:24px;border-radius:6px;">
<h1 style="margin:0 0 12px;font-size:18px;">${esc(body.heading)}</h1>
<p style="margin:0 0 16px;">${esc(body.intro)}</p>
<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:0 0 16px;">
${fields.map(([label, value]) => `<tr><td style="${cell}color:#666;white-space:nowrap;">${esc(label)}</td><td style="${cell}"><strong>${esc(value)}</strong></td></tr>`).join('\n')}
</table>
${
  body.lines?.length
    ? `<h2 style="margin:0 0 8px;font-size:15px;">Produtos</h2>
<ul style="margin:0 0 16px;padding-left:20px;">
${body.lines.map((l) => `<li>${esc(l.name)}: ${esc(l.price)}</li>`).join('\n')}
</ul>
`
    : ''
}<h2 style="margin:0 0 8px;font-size:15px;">Resumo</h2>
<p style="margin:0 0 20px;white-space:pre-wrap;">${esc(body.summary)}</p>
<p style="margin:0 0 20px;"><a href="${waLink}" style="display:inline-block;background:#25d366;color:#ffffff;text-decoration:none;padding:10px 16px;border-radius:4px;font-weight:bold;">Abrir conversa no WhatsApp</a></p>
<p style="margin:0;color:#888;font-size:12px;">Assistente WhatsApp de ${esc(ctx.client.name)}</p>
</div></body></html>`;

  return {
    clientId: ctx.client.id,
    conversationId: ctx.conversationId,
    phone: ctx.contact.waId,
    kind,
    from: ctx.client.mail.from,
    replyTo: ctx.client.mail.reply_to,
    to: branchRecipients(ctx.branch),
    subject: body.subject,
    text,
    html,
  };
}

function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
