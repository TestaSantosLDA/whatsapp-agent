import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { testClient } from '../test/helpers.js';
import { ClientRegistry, loadClients, parseClientConfig } from './registry.js';

describe('client config', () => {
  it('loads the real client files, including Jular with its four branches', () => {
    const registry = loadClients(fileURLToPath(new URL('../../../../clients', import.meta.url)));
    const jular = registry.get('jular');
    expect(jular?.branches.map((b) => b.id).sort()).toEqual([
      'albufeira',
      'azambuja',
      'camarate',
      'maia',
    ]);
    expect(Object.keys(jular?.policies ?? {}).length).toBeGreaterThan(5);
    expect(registry.getByPhoneNumberId(jular!.channel.phone_number_id)?.id).toBe('jular');
  });

  it('names the file and the field when the config is invalid', () => {
    const bad = { ...testClient(), default_language: undefined, branches: [] };
    expect(() => parseClientConfig(stringify(bad), 'clients/bad.yaml')).toThrow(
      /clients\/bad\.yaml[\s\S]*default_language[\s\S]*branches/,
    );
  });

  it('rejects routing to a branch that does not exist', () => {
    const bad = { ...testClient(), routing: { default_branch: 'porto', rules: [] } };
    expect(() => parseClientConfig(stringify(bad), 'x.yaml')).toThrow(/unknown branch porto/);
  });

  it("rejects a skill with an unknown business line or a field id that clashes with the lead's", () => {
    const skill = { id: 's', name: 'S', when: 'w', instructions: 'i' };
    const unknownLine = { ...testClient(), skills: [{ ...skill, business_line: 'houses' }] };
    expect(() => parseClientConfig(stringify(unknownLine), 'x.yaml')).toThrow(
      /unknown business line houses/,
    );
    const clash = {
      ...testClient(),
      skills: [{ ...skill, lead_fields: [{ id: 'phone', ask: 'a' }] }],
    };
    expect(() => parseClientConfig(stringify(clash), 'x.yaml')).toThrow(
      /phone is a core lead field/,
    );
  });

  it('looks clients up by id and by phone number id, and refuses duplicates', () => {
    const a = testClient();
    const b = testClient({
      id: 'other',
      channel: { type: 'simulator', phone_number_id: 'p2', display_phone_number: '2' },
    });
    const registry = new ClientRegistry([a, b]);
    expect(registry.get('other')).toBe(b);
    expect(registry.getByPhoneNumberId('test-phone-id')).toBe(a);
    expect(() => new ClientRegistry([a, a])).toThrow(/Duplicate client id/);
  });

  it('defaults the model to Claude Opus 5.5', () => {
    expect(testClient().model).toEqual({ id: 'claude-opus-5-5', effort: 'medium' });
  });
});
