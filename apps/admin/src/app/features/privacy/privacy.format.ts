/** pt-PT labels and formatting for the privacy screens (WA-028). */
import type {
  PrivacyAuditAction,
  PrivacyCounts,
  PrivacyRequestStatus,
  PrivacyRequestType,
} from '@wa/shared';

export const requestTypeLabel: Record<PrivacyRequestType, string> = {
  delete: 'Apagar dados',
  export: 'Cópia dos dados',
  clear_profile: 'Limpar perfil',
};

export const requestStatusLabel: Record<PrivacyRequestStatus, string> = {
  pending: 'Pendente',
  done: 'Concluído',
  rejected: 'Rejeitado',
};

export const auditActionLabel: Record<PrivacyAuditAction, string> = {
  export: 'Exportação',
  clear_profile: 'Perfil limpo',
  delete: 'Cliente apagado',
  retention_delete: 'Apagado por retenção',
  request_rejected: 'Pedido rejeitado',
};

/** [one, many] per count key; unknown keys show as they are. */
const countLabel: Record<string, [string, string]> = {
  contacts: ['contacto', 'contactos'],
  conversations: ['conversa', 'conversas'],
  messages: ['mensagem', 'mensagens'],
  emails: ['email', 'emails'],
  leads: ['pedido', 'pedidos'],
  leads_anonymised: ['pedido anonimizado', 'pedidos anonimizados'],
  agent_runs: ['registo do agente', 'registos do agente'],
  agent_runs_anonymised: ['registo do agente anonimizado', 'registos do agente anonimizados'],
  privacy_requests: ['pedido de privacidade', 'pedidos de privacidade'],
  privacy_requests_anonymised: ['pedido de privacidade', 'pedidos de privacidade'],
};

/** "3 mensagens · 1 pedido anonimizado"; empty counts are left out. */
export function formatCounts(counts: PrivacyCounts | null | undefined): string {
  const parts = Object.entries(counts ?? {})
    .filter(([, n]) => n > 0)
    .map(([key, n]) => {
      const label = countLabel[key];
      return `${n} ${label ? label[n === 1 ? 0 : 1] : key.replace(/_/g, ' ')}`;
    });
  return parts.length ? parts.join(' · ') : 'sem alterações';
}

/** +351 912 345 678 for Portuguese numbers, +<digits> otherwise. */
export function formatPhone(digits: string): string {
  if (digits.length === 12 && digits.startsWith('351')) {
    return `+351 ${digits.slice(3, 6)} ${digits.slice(6, 9)} ${digits.slice(9)}`;
  }
  return `+${digits}`;
}

export function formatDate(iso: string | null, withTime = true): string {
  if (!iso) return '';
  const date = new Date(iso);
  return withTime
    ? date.toLocaleString('pt-PT', { dateStyle: 'short', timeStyle: 'short' })
    : date.toLocaleDateString('pt-PT', { dateStyle: 'medium' } as Intl.DateTimeFormatOptions);
}
