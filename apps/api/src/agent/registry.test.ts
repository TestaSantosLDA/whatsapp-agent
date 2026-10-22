import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import { describe, expect, it } from 'vitest';
import { loadClients } from '../clients/registry.js';
import { agentTools } from './registry.js';

describe('tool registry', () => {
  it('has unique snake_case names and schemas the API accepts', () => {
    const names = agentTools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const tool of agentTools) {
      expect(tool.name).toMatch(/^[a-z][a-z0-9_]*$/);
      const wrapped = betaZodTool({ ...tool, run: () => '' }) as {
        input_schema?: { type?: string };
      };
      expect(wrapped.input_schema?.type).toBe('object');
    }
  });

  it('knows every tool the client configs enable', () => {
    const known = new Set(agentTools.map((t) => t.name));
    const clients = loadClients(new URL('../../../../clients', import.meta.url).pathname);
    for (const client of clients.all()) {
      expect(client.tools.filter((name) => !known.has(name))).toEqual([]);
    }
  });
});
