import { TestBed } from '@angular/core/testing';
import type { SimChatMessage } from '@wa/shared';
import { MessageBubble } from './message-bubble';
import { localizeStaticUrl } from './message-view';

const base = {
  messaging_product: 'whatsapp',
  recipient_type: 'individual',
  to: '351912345678',
} as const;

const buttonMsg: SimChatMessage = {
  id: 'out-1',
  direction: 'outbound',
  timestamp: '1792570000',
  payload: {
    ...base,
    type: 'interactive',
    interactive: {
      type: 'button',
      header: { type: 'text', text: 'Olá!' },
      body: { text: 'Em que posso *ajudar*?' },
      footer: { text: 'Responda abaixo' },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'quote', title: 'Orçamento' } },
          { type: 'reply', reply: { id: 'hours', title: 'Horário' } },
        ],
      },
    },
  },
};

function render(message: SimChatMessage) {
  const fixture = TestBed.createComponent(MessageBubble);
  fixture.componentRef.setInput('message', message);
  fixture.detectChanges();
  return { fixture, el: fixture.nativeElement as HTMLElement };
}

describe('MessageBubble', () => {
  beforeEach(() => TestBed.configureTestingModule({ imports: [MessageBubble] }));

  it('renders a button message with header, formatted body, footer and buttons', () => {
    const { el } = render(buttonMsg);
    expect(el.querySelector('.bubble--out')).toBeTruthy();
    expect(el.querySelector('.bubble__header')?.textContent).toContain('Olá!');
    expect(el.querySelector('.bubble__text strong')?.textContent).toBe('ajudar');
    expect(el.querySelector('.bubble__footer')?.textContent).toContain('Responda abaixo');
    const titles = [...el.querySelectorAll('.reply-button')].map((b) => b.textContent?.trim());
    expect(titles).toEqual(['Orçamento', 'Horário']);
  });

  it('emits a button_reply when a button is tapped', () => {
    const { fixture, el } = render(buttonMsg);
    const spy = vi.fn();
    fixture.componentInstance.reply.subscribe(spy);
    (el.querySelectorAll('.reply-button')[1] as HTMLButtonElement).click();
    expect(spy).toHaveBeenCalledWith({ type: 'button_reply', id: 'hours', title: 'Horário' });
  });

  it('renders a customer message on the right with read ticks', () => {
    const { el } = render({
      id: 'in-1',
      direction: 'inbound',
      timestamp: '1792570000',
      text: 'Bom dia',
      status: 'read',
    });
    expect(el.classList).toContain('msg-row--in');
    expect(el.querySelector('.bubble--in .bubble__text')?.textContent).toBe('Bom dia');
    expect(el.querySelector('.tick--read')).toBeTruthy();
  });

  it('emits openList for a list message', () => {
    const { fixture, el } = render({
      id: 'out-2',
      direction: 'outbound',
      timestamp: '1792570000',
      payload: {
        ...base,
        type: 'interactive',
        interactive: {
          type: 'list',
          body: { text: 'Escolha uma loja' },
          action: {
            button: 'Ver lojas',
            sections: [{ title: 'Norte', rows: [{ id: 'porto', title: 'Porto' }] }],
          },
        },
      },
    });
    const spy = vi.fn();
    fixture.componentInstance.openList.subscribe(spy);
    const btn = el.querySelector('.bubble__list-btn') as HTMLButtonElement;
    expect(btn.textContent).toContain('Ver lojas');
    btn.click();
    expect(spy.mock.calls[0][0].action.button).toBe('Ver lojas');
  });
});

describe('localizeStaticUrl', () => {
  it('makes localhost /static links relative and keeps others', () => {
    expect(localizeStaticUrl('http://localhost:3000/static/a.svg')).toBe('/static/a.svg');
    expect(localizeStaticUrl('https://cdn.example.com/static/a.png')).toBe(
      'https://cdn.example.com/static/a.png',
    );
  });
});
