/** Seeds a short demo conversation for every simulator client. Safe to run more than once. */
import { randomUUID } from 'node:crypto';
import { loadClients } from '../clients/registry.js';
import { openDb } from '../db/index.js';
import { messages } from '../db/schema.js';
import { loadDotEnv, loadEnv } from '../env.js';
import { MessageService } from '../services/messages.js';
import { EventBus } from '../bus.js';
import { SimulatorChannel } from '../channels/simulator.js';

loadDotEnv();
const env = loadEnv({ SIMULATOR_WEBHOOK_SECRET: 'not-needed-for-seed', ...process.env });
const handle = openDb({ databaseUrl: env.DATABASE_URL, pgliteDir: env.PGLITE_DIR });
await handle.migrate();
const bus = new EventBus();
const service = new MessageService(
  handle.db,
  bus,
  new Map([['simulator', new SimulatorChannel(bus)]]),
);

const phone = '351910000000';
for (const client of loadClients(env.CLIENTS_DIR).all()) {
  if (client.channel.type !== 'simulator') continue;
  const { messages: existing } = await service.history(client.id, phone);
  if (existing.length) continue;
  const contact = await service.upsertContact(client.id, phone, 'Cliente de demonstração');
  const conversation = await service.openConversation(client.id, contact.id);
  const id = `wamid.seed-${randomUUID()}`;
  await handle.db.insert(messages).values({
    clientId: client.id,
    conversationId: conversation.id,
    direction: 'inbound',
    channelMessageId: id,
    type: 'text',
    text: 'Olá! Têm pavimento vinílico para casa de banho?',
    payload: {
      from: phone,
      id,
      timestamp: String(Math.floor(Date.now() / 1000)),
      type: 'text',
      text: { body: 'Olá! Têm pavimento vinílico para casa de banho?' },
    },
    status: 'received',
    processedAt: new Date(),
  });
  await service.send(client, conversation.id, phone, {
    type: 'text',
    text: 'Olá! Sim, temos várias opções resistentes à água. Qual é a área da casa de banho?',
  });
  console.log(`Seeded a demo conversation for ${client.id} (phone ${phone}).`);
}
await handle.close();
