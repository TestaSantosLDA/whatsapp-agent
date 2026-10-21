/**
 * WhatsApp-style text formatting to HTML.
 * The input is HTML-escaped first, so the result only contains tags we add here and is safe for [innerHTML].
 */

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

const INLINE: ReadonlyArray<[marker: string, tag: string]> = [
  ['\\*', 'strong'],
  ['_', 'em'],
  ['~', 's'],
];

/** Trailing characters that usually end a sentence rather than a URL. */
const URL_TRAILER = /(?:[.,!?;:)\]]|&quot;|&#39;)+$/;

export function formatWhatsApp(input: string | null | undefined): string {
  if (!input) return '';
  const slots: string[] = [];
  const hold = (html: string) => `\u0000${slots.push(html) - 1}\u0000`;

  let s = escapeHtml(input.replace(/\u0000/g, ''));

  // Monospace first, so nothing inside it is formatted.
  s = s.replace(/```([\s\S]+?)```/g, (_m, code: string) =>
    hold(`<code class="wa-mono">${code}</code>`),
  );
  s = s.replace(/`([^`\n]+)`/g, (_m, code: string) =>
    hold(`<code class="wa-inline">${code}</code>`),
  );

  // Links, held aside so underscores or asterisks in URLs are not treated as formatting.
  s = s.replace(/\b(?:https?:\/\/|www\.)[^\s<\u0000]+/gi, (match: string) => {
    const trailer = URL_TRAILER.exec(match)?.[0] ?? '';
    const url = trailer ? match.slice(0, -trailer.length) : match;
    if (!url) return match;
    const href = /^www\./i.test(url) ? `https://${url}` : url;
    return hold(`<a href="${href}" target="_blank" rel="noopener noreferrer">${url}</a>`) + trailer;
  });

  for (const [m, tag] of INLINE) {
    const re = new RegExp(
      `(^|[^\\w${m}])${m}([^\\s${m}](?:[^${m}\\n]*?[^\\s${m}])?)${m}(?![\\w${m}])`,
      'g',
    );
    s = s.replace(re, (_x, pre: string, inner: string) => `${pre}<${tag}>${inner}</${tag}>`);
  }

  s = s.replace(/\r?\n/g, '<br>');
  return s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => slots[Number(i)]);
}

/** Meta timestamps are unix seconds as a string; the simulator may also send ISO dates. */
export function toDate(timestamp: string | number): Date | null {
  const raw = String(timestamp).trim();
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    return new Date(n < 1e12 ? n * 1000 : n);
  }
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function formatTime(timestamp: string | number): string {
  const d = toDate(timestamp);
  if (!d) return '';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
