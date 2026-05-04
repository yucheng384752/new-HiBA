import { describe, expect, it, jest } from '@jest/globals';
import { HiBAError } from '../core/ScopedToolbox';
import { TrustRegistry, type AgentRecord } from './TrustRegistry';

function createRecord(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    agentId: 'agent-001',
    role: 'domain',
    permissions: ['material.read', 'material.write'],
    parentAgentId: 'root-agent',
    publicKeyPem: '-----BEGIN PUBLIC KEY-----\nMIIB\n-----END PUBLIC KEY-----',
    registeredAt: 1_700_000_000_000,
    status: 'active',
    ...overrides,
  };
}

describe('TrustRegistry', () => {
  it('register + lookup returns the correct AgentRecord', async () => {
    const registry = new TrustRegistry(':memory:');
    const record = createRecord();

    await registry.register(record);
    const found = await registry.lookup('agent-001');

    expect(found).toEqual(record);
  });

  it('lookup second call uses cache and does not call db.prepare again', async () => {
    const registry = new TrustRegistry(':memory:');
    await registry.register(createRecord());
    await registry.lookup('agent-001');
    const prepareSpy = jest.spyOn(registry.db, 'prepare');

    const found = await registry.lookup('agent-001');

    expect(found?.agentId).toBe('agent-001');
    expect(prepareSpy).not.toHaveBeenCalled();
  });

  it('register same agentId uses INSERT OR REPLACE and invalidates cache', async () => {
    const registry = new TrustRegistry(':memory:');
    await registry.register(createRecord({
      permissions: ['material.read'],
      publicKeyPem: 'old-key',
    }));
    await registry.lookup('agent-001');

    const replacement = createRecord({
      permissions: ['machine.read'],
      publicKeyPem: 'new-key',
      registeredAt: 1_700_000_000_500,
    });
    await registry.register(replacement);
    const found = await registry.lookup('agent-001');

    expect(found).toEqual(replacement);
  });

  it("revoke updates lookup status to 'revoked' and invalidates cache", async () => {
    const registry = new TrustRegistry(':memory:');
    await registry.register(createRecord());
    const cached = await registry.lookup('agent-001');
    expect(cached?.status).toBe('active');

    await registry.revoke('agent-001');
    const found = await registry.lookup('agent-001');

    expect(found?.status).toBe('revoked');
  });

  it('revoke throws HiBAError when agentId does not exist', async () => {
    const registry = new TrustRegistry(':memory:');

    await expect(registry.revoke('missing-agent')).rejects.toMatchObject({
      name: 'HiBAError',
      errorCode: 'AGENT_NOT_REGISTERED',
    });
    await expect(registry.revoke('missing-agent')).rejects.toBeInstanceOf(HiBAError);
  });

  it('lookup returns null when agentId does not exist', async () => {
    const registry = new TrustRegistry(':memory:');

    await expect(registry.lookup('missing-agent')).resolves.toBeNull();
  });

  it('listAll returns all active and revoked records', async () => {
    const registry = new TrustRegistry(':memory:');
    await registry.register(createRecord({
      agentId: 'agent-active',
      registeredAt: 1,
      status: 'active',
    }));
    await registry.register(createRecord({
      agentId: 'agent-revoked',
      registeredAt: 2,
      status: 'active',
    }));
    await registry.revoke('agent-revoked');

    const all = await registry.listAll();

    expect(all).toEqual([
      createRecord({
        agentId: 'agent-active',
        registeredAt: 1,
        status: 'active',
      }),
      createRecord({
        agentId: 'agent-revoked',
        registeredAt: 2,
        status: 'revoked',
      }),
    ]);
  });
});
