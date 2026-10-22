import type { OutboundMessage } from '../channels/channel.js';
import type { ToolContext } from './tool.js';

const TEXT_MAX = 4096;
const BUTTON_BODY_MAX = 1024;

/** Splits text into WhatsApp-sized messages, at paragraph, then line, then word boundaries. */
export function splitText(text: string, max = TEXT_MAX): string[] {
  const chunks: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    const window = rest.slice(0, max);
    // The last paragraph break, line break or space in the second half of the window, in that
    // order of preference; a hard cut only when there is none.
    const at =
      ['\n\n', '\n', ' '].map((sep) => window.lastIndexOf(sep)).find((i) => i > max / 2) ?? max;
    chunks.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

const truncate = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max - 1)}…`);

/**
 * The messages for one turn: the agent's text (with its tap-to-answer options attached, when it
 * offered some), then the rich messages tools queued, such as product cards.
 */
export function toOutbound(
  text: string,
  state: Pick<ToolContext, 'outbox' | 'choices'>,
  language: string,
): OutboundMessage[] {
  const out: OutboundMessage[] = [];
  const chunks = splitText(text);
  const choices = state.choices;

  if (!choices) {
    out.push(...chunks.map((t): OutboundMessage => ({ type: 'text', text: t })));
  } else {
    // The options ride on the last chunk when it fits an interactive body, else on a short prompt.
    const english = language === 'en';
    const last = chunks.at(-1);
    const lastFits = last !== undefined && last.length <= BUTTON_BODY_MAX;
    const body = lastFits ? last : english ? 'Choose an option:' : 'Escolha uma opção:';
    out.push(
      ...(lastFits ? chunks.slice(0, -1) : chunks).map((t): OutboundMessage => ({
        type: 'text',
        text: t,
      })),
    );
    if (choices.options.length <= 3) {
      out.push({
        type: 'buttons',
        body,
        buttons: choices.options.map((o, i) => ({ id: `choice-${i + 1}`, title: truncate(o, 20) })),
      });
    } else {
      out.push({
        type: 'list',
        body,
        button: truncate(choices.listButton ?? (english ? 'See options' : 'Ver opções'), 20),
        sections: [
          {
            rows: choices.options
              .slice(0, 10)
              .map((o, i) => ({ id: `choice-${i + 1}`, title: truncate(o, 24) })),
          },
        ],
      });
    }
  }
  out.push(...state.outbox);
  return out;
}
