/**
 * Inbox alert emails (WA-023), in pt-PT: a customer waiting for a person, a new message on a
 * conversation a person has, or a conversation assigned to someone. Sent through the Mailer, so
 * MAIL_REDIRECT_TO applies in demos.
 */
import type { ClientConfig, InboxConversation } from '@wa/shared';
import type { Email } from '../../mail/mailer.js';
import type { TeamMemberRow } from '../context.js';

export type AlertKind =
  | { kind: 'handoff'; branchId: string | null; summary: string }
  | { kind: 'message'; text: string }
  | { kind: 'assigned'; by: Pick<TeamMemberRow, 'name' | 'email'> };

export function inboxAlertEmail(opts: {
  client: ClientConfig;
  conversation: InboxConversation;
  alert: AlertKind;
  to: string[];
  dashboardUrl: string;
}): Email {
  const { client, conversation, alert } = opts;
  const who = conversation.contact.name?.trim() || `+${conversation.contact.phone}`;
  const link = `${opts.dashboardUrl.replace(/\/+$/, '')}/inbox/${conversation.id}`;
  const content =
    alert.kind === 'handoff'
      ? {
          subject: `Cliente à espera de uma pessoa: ${who}`,
          heading: 'Um cliente quer falar com uma pessoa',
          intro: `O assistente passou a conversa com ${who} para a equipa${conversation.branchName ? ` (${conversation.branchName})` : ''} e deixou de responder.`,
          quote: alert.summary,
        }
      : alert.kind === 'message'
        ? {
            subject: `Nova mensagem de ${who}`,
            heading: `${who} escreveu numa conversa entregue a uma pessoa`,
            intro: 'O assistente não responde enquanto a conversa estiver com a equipa.',
            quote: alert.text,
          }
        : {
            subject: `Conversa atribuída a si: ${who}`,
            heading: 'Tem uma conversa atribuída',
            intro: `${alert.by.name || alert.by.email} atribuiu-lhe a conversa com ${who}.`,
            quote: conversation.lastMessage?.text ?? '',
          };

  const text = [
    content.heading,
    '',
    content.intro,
    ...(content.quote ? ['', `«${content.quote}»`] : []),
    '',
    `Abrir no painel: ${link}`,
    '',
    `— Painel da equipa de ${client.name}`,
  ].join('\n');
  const html = `<!doctype html>
<html lang="pt-PT"><body style="margin:0;padding:24px;background:#f6f6f6;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#222;">
<div style="max-width:600px;margin:0 auto;background:#ffffff;padding:24px;border-radius:6px;">
<h1 style="margin:0 0 12px;font-size:18px;">${esc(content.heading)}</h1>
<p style="margin:0 0 16px;">${esc(content.intro)}</p>
${content.quote ? `<blockquote style="margin:0 0 20px;padding:8px 12px;border-left:3px solid #25d366;background:#f3faf6;white-space:pre-wrap;">${esc(content.quote)}</blockquote>\n` : ''}<p style="margin:0 0 20px;"><a href="${esc(link)}" style="display:inline-block;background:#008069;color:#ffffff;text-decoration:none;padding:10px 16px;border-radius:4px;font-weight:bold;">Abrir a conversa</a></p>
<p style="margin:0;color:#888;font-size:12px;">Painel da equipa de ${esc(client.name)}</p>
</div></body></html>`;

  return {
    clientId: client.id,
    conversationId: conversation.id,
    phone: conversation.contact.phone,
    kind: 'inbox_alert',
    from: client.mail.from,
    replyTo: client.mail.reply_to,
    to: opts.to,
    subject: content.subject,
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
