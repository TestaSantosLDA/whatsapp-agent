/**
 * A cheap first guess at the customer's language, from their own words. Claude still answers in
 * whatever language the customer writes; this guess picks the language of the system's fixed
 * texts (apology, handoff) and is stored on the contact.
 */
const portuguese = new Set(
  'olá ola bom boa dia tarde noite obrigado obrigada preciso queria quero tem têm têem tenho para com uma um não nao sim qual quanto quantos custa preço preco orçamento orcamento pavimento madeira casa de banho morada loja pode podem gostaria ajuda por favor você voce é está esta são e o a os as do da dos das no na em que se'.split(
    ' ',
  ),
);
const english = new Set(
  'hello hi good morning afternoon evening thanks thank you need want would like have has do does can could the a an is are for with price cost quote floor wood bathroom store shop please help what which how much many and of in to my i we'.split(
    ' ',
  ),
);

export type Language = 'pt-PT' | 'en';

/** Returns undefined when the text gives no clear signal (e.g. "ok", a number, an emoji). */
export function detectLanguage(text: string): Language | undefined {
  const lower = text.toLowerCase();
  if (/[ãõçâêôáéíóú]/.test(lower)) return 'pt-PT';
  let pt = 0;
  let en = 0;
  for (const word of lower.match(/[a-zà-ú']+/g) ?? []) {
    if (portuguese.has(word)) pt++;
    if (english.has(word)) en++;
  }
  if (pt === en) return undefined;
  return pt > en ? 'pt-PT' : 'en';
}
