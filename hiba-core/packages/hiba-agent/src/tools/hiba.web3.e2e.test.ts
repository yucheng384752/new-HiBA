import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from '@jest/globals';
import { AuditTrail } from '../audit/AuditTrail';
import { HiBAToolbox } from '../core/HiBAToolbox';
import type { ToolContext } from '../types/hiba.types';
import { registerHibaTools } from './hiba.tools';

const live = process.env['HIBA_WEB3_E2E'] === '1' ? describe : describe.skip;

live('HiBA-AB + Java HiBA + Web3', () => {
  test('protects and verifies a real file on-chain', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hiba-web3-'));
    const filePath = join(dir, 'work-order.json');
    const previousIndexPath = process.env['FILE_PROTECTION_INDEX_PATH'];
    process.env['FILE_PROTECTION_INDEX_PATH'] = join(dir, 'file-protection-index.sqlite');
    await writeFile(filePath, JSON.stringify({ orderId: `WO-E2E-${Date.now()}`, quantity: 7 }));

    try {
      const toolbox = new HiBAToolbox({
        auditWriter: new AuditTrail(':memory:'),
        permissions: ['material.write', 'material.read'],
      });
      registerHibaTools(toolbox);
      const ctx: ToolContext = {
        hibaBaseUrl: process.env['HIBA_BASE_URL'] ?? 'http://127.0.0.1:8092',
        traceId: `e2e-${Date.now()}`,
        agentId: 'hiba-ab-web3-test',
        depth: 0,
        permissions: ['material.write', 'material.read'],
      };

      const protectedResult = await toolbox.execute<{ success: boolean; txHash: string }>(
        'material.protectFile',
        { filePath, keepFile: true },
        ctx,
      );
      if (!protectedResult.success) throw new Error(protectedResult.error);
      expect(protectedResult.success).toBe(true);
      expect(protectedResult.output.txHash).toMatch(/^0x[0-9a-f]{64}$/i);

      const verifiedResult = await toolbox.execute<{ isValid: boolean; txHash: string; blockHash: string }>(
        'material.verifyFile',
        { filePath },
        ctx,
      );
      if (!verifiedResult.success) throw new Error(verifiedResult.error);
      expect(verifiedResult.success).toBe(true);
      expect(verifiedResult.output).toEqual({
        isValid: true,
        txHash: protectedResult.output.txHash,
        blockHash: expect.stringMatching(/^0x[0-9a-f]{64}$/i),
      });

      const receipt = await fetch(process.env['WEB3_RPC_URL'] ?? 'http://127.0.0.1:8545', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [protectedResult.output.txHash] }),
      }).then(response => response.json()) as { result: { status: string; to: string } };
      expect(receipt.result.status).toBe('0x1');
      expect(receipt.result.to.toLowerCase()).toBe(process.env['FILE_PROTECTION_CONTRACT_ADDRESS']?.toLowerCase());
    } finally {
      if (previousIndexPath === undefined) delete process.env['FILE_PROTECTION_INDEX_PATH'];
      else process.env['FILE_PROTECTION_INDEX_PATH'] = previousIndexPath;
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
