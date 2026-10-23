const time = new Intl.DateTimeFormat('pt-PT', { hour: '2-digit', minute: '2-digit' });
const day = new Intl.DateTimeFormat('pt-PT', { day: 'numeric', month: 'short' });
const full = new Intl.DateTimeFormat('pt-PT', { dateStyle: 'medium', timeStyle: 'short' });

/** "14:05" today, "ontem", else "12/out." (list rows). */
export function shortWhen(iso: string, now = new Date()): string {
  const at = new Date(iso);
  if (at.toDateString() === now.toDateString()) return time.format(at);
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (at.toDateString() === yesterday.toDateString()) return 'ontem';
  return day.format(at);
}

export const timeOf = (iso: string) => time.format(new Date(iso));
export const fullWhen = (iso: string) => full.format(new Date(iso));

/** The customer's name, else their number as +351 912 345 678. */
export function contactLabel(contact: { name: string | null; phone: string }): string {
  return contact.name?.trim() || formatPhone(contact.phone);
}

export function formatPhone(phone: string): string {
  const m = /^(351)(\d{3})(\d{3})(\d{3})$/.exec(phone);
  return m ? `+${m[1]} ${m[2]} ${m[3]} ${m[4]}` : `+${phone}`;
}

export const STATUS_LABELS = {
  bot: 'Assistente',
  human: 'Com a equipa',
  closed: 'Terminada',
} as const;

export const LEAD_TYPES: Record<string, string> = {
  info: 'Pedido de informação',
  quote: 'Pedido de orçamento',
  sample: 'Pedido de amostra',
  order: 'Rascunho de encomenda',
  handoff: 'Pedido para falar com uma pessoa',
};
