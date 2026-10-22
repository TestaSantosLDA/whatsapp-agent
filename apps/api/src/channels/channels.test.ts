import { createHmac } from 'node:crypto';
import { metaSendMessageSchema } from '@wa/shared';
import { describe, expect, it } from 'vitest';
import { fixture } from '../test/helpers.js';
import { toMetaPayload } from './channel.js';
import { parseInbound, InvalidPayloadError } from './inbound.js';
import { buildSimulatedWebhook } from './simulator.js';
import { verifyMetaSignature } from './whatsapp-cloud.js';
import { testClient } from '../test/helpers.js';

describe('parseInbound', () => {
  it('parses a text message with the contact name', () => {
    const [m] = parseInbound(JSON.parse(fixture('text')));
    expect(m).toMatchObject({
      phoneNumberId: 'test-phone-id',
      from: '351912345678',
      profileName: 'Ana Costa',
      type: 'text',
      text: 'Olá, têm pavimento vinílico?',
    });
    expect(m!.timestamp.toISOString()).toBe('2025-10-21T22:50:00.000Z');
  });

  it('uses the tapped button title as the text', () => {
    const [m] = parseInbound(JSON.parse(fixture('button-reply')));
    expect(m).toMatchObject({ type: 'interactive', text: 'Pedir orçamento' });
    expect(m!.raw.interactive?.button_reply?.id).toBe('quote');
  });

  it('keeps an image caption', () => {
    const [m] = parseInbound(JSON.parse(fixture('image')));
    expect(m).toMatchObject({ type: 'image', text: '[image] Gosto deste chão' });
  });

  it('ignores status callbacks', () => {
    expect(parseInbound(JSON.parse(fixture('status')))).toEqual([]);
  });

  it('rejects a body that is not a WhatsApp webhook', () => {
    expect(() => parseInbound({ hello: 'world' })).toThrow(InvalidPayloadError);
  });
});

describe('buildSimulatedWebhook', () => {
  it('produces a body the real parser accepts, for text and button replies', () => {
    const client = testClient();
    const text = parseInbound(
      buildSimulatedWebhook(client, { phone: '351911111111', name: 'Rui', text: 'Olá' }),
    );
    expect(text[0]).toMatchObject({
      phoneNumberId: 'test-phone-id',
      from: '351911111111',
      profileName: 'Rui',
      text: 'Olá',
    });

    const reply = parseInbound(
      buildSimulatedWebhook(client, {
        phone: '351911111111',
        name: 'Rui',
        reply: { type: 'list_reply', id: 'vinyl', title: 'Vinílico' },
      }),
    );
    expect(reply[0]).toMatchObject({ type: 'interactive', text: 'Vinílico' });
  });

  it('has the same top-level shape as a recorded Meta payload', () => {
    const sim = buildSimulatedWebhook(testClient(), {
      phone: '351912345678',
      name: 'Ana Costa',
      text: 'x',
    });
    const real = JSON.parse(fixture('text'));
    const keys = (o: object) => Object.keys(o).sort();
    expect(keys(sim)).toEqual(keys(real));
    expect(keys(sim.entry[0]!.changes[0]!.value)).toEqual(keys(real.entry[0].changes[0].value));
    expect(keys(sim.entry[0]!.changes[0]!.value.messages![0]!)).toEqual(
      keys(real.entry[0].changes[0].value.messages[0]),
    );
  });
});

describe('toMetaPayload', () => {
  it('builds valid Cloud API bodies for every message type', () => {
    const bodies = [
      toMetaPayload('351', { type: 'text', text: 'Olá' }),
      toMetaPayload('351', { type: 'image', url: 'https://x.test/a.png', caption: 'A' }),
      toMetaPayload('351', {
        type: 'buttons',
        body: 'Escolha',
        buttons: [{ id: 'a', title: 'A' }],
      }),
      toMetaPayload('351', {
        type: 'list',
        body: 'Escolha',
        button: 'Ver',
        sections: [{ title: 'S', rows: [{ id: 'r', title: 'R' }] }],
      }),
    ];
    for (const body of bodies) expect(metaSendMessageSchema.safeParse(body).success).toBe(true);
  });
});

describe('verifyMetaSignature', () => {
  const secret = 'app-secret';
  const body = fixture('text');
  const sign = (b: string) => `sha256=${createHmac('sha256', secret).update(b).digest('hex')}`;

  it('accepts a correct signature', () => {
    expect(verifyMetaSignature(body, sign(body), secret)).toBe(true);
  });

  it('rejects a tampered body, a wrong secret and a missing header', () => {
    expect(verifyMetaSignature(body + ' ', sign(body), secret)).toBe(false);
    expect(verifyMetaSignature(body, sign(body), 'other')).toBe(false);
    expect(verifyMetaSignature(body, undefined, secret)).toBe(false);
    expect(verifyMetaSignature(body, 'sha256=abc', secret)).toBe(false);
  });
});
