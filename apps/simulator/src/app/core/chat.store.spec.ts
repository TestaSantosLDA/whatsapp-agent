import { TestBed } from '@angular/core/testing';
import { ChatStore } from './chat.store';

describe('ChatStore.handleEvent', () => {
  let store: ChatStore;
  beforeEach(() => {
    store = TestBed.inject(ChatStore);
  });

  it('loads history, dedupes messages by id and applies read status', () => {
    store.handleEvent({
      type: 'history',
      conversationStatus: 'open',
      messages: [{ id: 'a', direction: 'inbound', timestamp: '1', text: 'oi', status: 'sent' }],
    });
    store.handleEvent({
      type: 'message',
      message: { id: 'a', direction: 'inbound', timestamp: '1', text: 'oi', status: 'sent' },
    });
    expect(store.messages().length).toBe(1);

    store.handleEvent({ type: 'status', messageId: 'a', status: 'read' });
    const m = store.messages()[0];
    expect(m.direction === 'inbound' && m.status).toBe('read');
    expect(store.conversationStatus()).toBe('open');
  });

  it('remembers a read status that arrives before its message', () => {
    store.handleEvent({ type: 'status', messageId: 'b', status: 'read' });
    store.handleEvent({
      type: 'message',
      message: { id: 'b', direction: 'inbound', timestamp: '1', text: 'x', status: 'sent' },
    });
    const m = store.messages()[0];
    expect(m.direction === 'inbound' && m.status).toBe('read');
  });

  it('turns typing off when a bot message arrives', () => {
    store.handleEvent({ type: 'typing', on: true });
    expect(store.typing()).toBe(true);
    store.handleEvent({
      type: 'message',
      message: {
        id: 'c',
        direction: 'outbound',
        timestamp: '2',
        payload: {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: '1',
          type: 'text',
          text: { body: 'olá' },
        },
      },
    });
    expect(store.typing()).toBe(false);
  });
});
