/** Types shared by the simulator API and the simulator UI. */
import type { MetaSendMessage } from './meta.js';

export interface SimClientSummary {
  id: string;
  name: string;
  displayPhoneNumber: string;
  languages: string[];
}

/** A message as the simulator UI renders it. */
export type SimChatMessage =
  | {
      id: string;
      direction: 'inbound';
      timestamp: string;
      text: string;
      status: 'sent' | 'read';
    }
  | {
      id: string;
      direction: 'outbound';
      timestamp: string;
      payload: MetaSendMessage;
    };

/** Events pushed to the simulator UI over Server-Sent Events. */
export type SimEvent =
  | { type: 'history'; messages: SimChatMessage[]; conversationStatus: string }
  | { type: 'message'; message: SimChatMessage }
  | { type: 'status'; messageId: string; status: 'read' }
  | { type: 'typing'; on: boolean };

/** Body of POST /sim/:clientId/messages. */
export type SimSendBody =
  | { phone: string; name: string; text: string }
  | {
      phone: string;
      name: string;
      reply: { type: 'button_reply' | 'list_reply'; id: string; title: string };
    };
