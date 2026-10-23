/** The email that takes a quote PDF to the customer (WA-025), in pt-PT. */
import { formatCents, type ClientConfig } from '@wa/shared';
import type { Email } from '../../mail/mailer.js';
import { ptDate } from './pdf.js';

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`).replace(/\n/g, '<br>');

export function quoteEmail(o: {
  client: ClientConfig;
  conversationId?: string;
  phone: string;
  to: string;
  replyTo?: string;
  customerName: string | null;
  number: string;
  totalCents: number;
  validUntil: string;
  message?: string;
  sender: string;
  filename: string;
  pdf: Uint8Array;
}): Email {
  const company = o.client.quotes.company.legal_name ?? o.client.name;
  const greeting = o.customerName ? `Olá ${o.customerName.split(' ')[0]},` : 'Olá,';
  const body =
    o.message ??
    `Segue em anexo o orçamento ${o.number}, no valor de ${formatCents(o.totalCents)} (IVA incluído), válido até ${ptDate(o.validUntil)}.\n\nQualquer dúvida, responda a este email ou fale connosco pelo WhatsApp.`;
  const text = `${greeting}\n\n${body}\n\nCom os melhores cumprimentos,\n${o.sender}\n${company}`;
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#202124;max-width:560px">
<p>${esc(greeting)}</p>
<p>${esc(body)}</p>
<p>Com os melhores cumprimentos,<br>${esc(o.sender)}<br>${esc(company)}</p>
</div>`;
  return {
    clientId: o.client.id,
    conversationId: o.conversationId,
    phone: o.phone,
    kind: 'quote',
    from: o.client.mail.from,
    replyTo: o.replyTo ?? o.client.mail.reply_to,
    to: [o.to],
    subject: `Orçamento ${o.number} – ${company}`,
    text,
    html,
    attachments: [{ filename: o.filename, content: o.pdf }],
  };
}
