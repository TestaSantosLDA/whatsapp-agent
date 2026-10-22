export interface Persona {
  id: string;
  name: string;
  /** Digits only, international format without "+". */
  phone: string;
  lang: string;
  note?: string;
}

export const PERSONAS: readonly Persona[] = [
  { id: 'ana', name: 'Ana Costa', phone: '351912345678', lang: 'pt-PT' },
  { id: 'john', name: 'John Miller', phone: '447700900123', lang: 'en' },
  {
    id: 'rui',
    name: 'Rui Carpinteiro',
    phone: '351936000111',
    lang: 'pt-PT',
    note: 'profissional',
  },
];

export const CUSTOM_PERSONA_ID = 'custom';

export function isValidPhone(phone: string): boolean {
  return /^\d{6,15}$/.test(phone);
}
