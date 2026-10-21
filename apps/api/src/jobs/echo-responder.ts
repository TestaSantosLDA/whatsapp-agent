import type { OutboundMessage } from '../channels/channel.js';
import type { Responder, TurnInput } from './process-conversation.js';

/**
 * Placeholder until the Claude agent (WA-009). Echoes the customer, and a few keywords show
 * each message type so the simulator UI can be exercised: "botões", "lista", "imagem".
 */
export class EchoResponder implements Responder {
  constructor(private readonly publicBaseUrl: string) {}

  async respond({ client, newMessages }: TurnInput): Promise<OutboundMessage[]> {
    const text = newMessages.map((m) => m.text ?? '').join('\n');
    const keyword = text.trim().toLowerCase();

    if (keyword === 'botões' || keyword === 'botoes' || keyword === 'buttons') {
      return [
        {
          type: 'buttons',
          header: client.name,
          body: 'Em que podemos ajudar?',
          footer: 'Escolha uma opção',
          buttons: [
            { id: 'products', title: 'Produtos' },
            { id: 'quote', title: 'Pedir orçamento' },
            { id: 'human', title: 'Falar com alguém' },
          ],
        },
      ];
    }
    if (keyword === 'lista' || keyword === 'list') {
      return [
        {
          type: 'list',
          body: 'Que tipo de produto procura?',
          button: 'Ver categorias',
          sections: [
            {
              title: 'Pavimentos',
              rows: [
                {
                  id: 'laminate',
                  title: 'Laminado',
                  description: 'AC4 e AC5, uso residencial e comercial',
                },
                { id: 'vinyl', title: 'Vinílico', description: 'Resistente à água' },
              ],
            },
            {
              title: 'Exterior',
              rows: [{ id: 'decks', title: 'Decks', description: 'Madeira e compósito' }],
            },
          ],
        },
      ];
    }
    if (keyword === 'imagem' || keyword === 'image') {
      return [
        {
          type: 'image',
          url: `${this.publicBaseUrl}/static/demo-product.svg`,
          caption: '*Pavimento de demonstração*\n€32,08 · _imagem de teste_',
        },
      ];
    }
    return [
      {
        type: 'text',
        text: `Recebi: ${text}\n\n_(resposta de teste; escreva *botões*, *lista* ou *imagem*)_`,
      },
    ];
  }
}
