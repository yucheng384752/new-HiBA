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

      const protectedResult = await toolbox.execute<{
        success: boolean; protectionId: string; fileHash: string; txHash: string; blockHash: string;
        chainId: string; contractAddress: string; receiptStatus: string;
      }>(
        'material.protectFile',
        { filePath, keepFile: true },
        ctx,
      );
      if (!protectedResult.success) throw new Error(protectedResult.error);
      expect(protectedResult.success).toBe(true);
      expect(protectedResult.output.protectionId).toMatch(/^[0-9a-f-]{36}$/i);
      expect(protectedResult.output.txHash).toMatch(/^0x[0-9a-f]{64}$/i);
      expect(protectedResult.output.receiptStatus).toBe('0x1');

      const verifiedResult = await toolbox.execute<{
        isValid: boolean; protectionId: string; expectedHash: string; actualHash: string;
        verdict: string; txHash: string; blockHash: string;
      }>(
        'material.verifyFile',
        { filePath, protectionId: protectedResult.output.protectionId },
        ctx,
      );
      if (!verifiedResult.success) throw new Error(verifiedResult.error);
      expect(verifiedResult.success).toBe(true);
      expect(verifiedResult.output).toEqual({
        isValid: true,
        protectionId: protectedResult.output.protectionId,
        expectedHash: protectedResult.output.fileHash,
        actualHash: protectedResult.output.fileHash,
        verdict: 'VERIFICATION_SUCCESSFUL',
        txHash: protectedResult.output.txHash,
        blockHash: protectedResult.output.blockHash,
        chainId: protectedResult.output.chainId,
        contractAddress: protectedResult.output.contractAddress,
        receiptStatus: '0x1',
      });

      const receipt = await fetch(process.env['WEB3_RPC_URL'] ?? 'http://127.0.0.1:8545', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [protectedResult.output.txHash] }),
      }).then(response => response.json()) as { result: { status: string; to: string } };
      expect(receipt.result.status).toBe('0x1');
      expect(receipt.result.to.toLowerCase()).toBe(process.env['FILE_PROTECTION_CONTRACT_ADDRESS']?.toLowerCase());

      // The whole point of this feature (Success Criteria: "修改一個字元後能得到
      // 明確的 isValid=false，而不是只有『找不到索引』") -- the original E2E test
      // never actually exercised tampering. Same protectionId, same file path,
      // content mutated by one character: must still find the original chain
      // record (via the content-independent protectionId) and report a clear
      // hash mismatch, not a lookup failure.
      await writeFile(filePath, JSON.stringify({ orderId: `WO-E2E-${Date.now()}-tampered`, quantity: 7 }));
      const tamperedResult = await toolbox.execute<{
        isValid: boolean; expectedHash: string; actualHash: string;
      }>(
        'material.verifyFile',
        { filePath, protectionId: protectedResult.output.protectionId },
        ctx,
      );
      if (!tamperedResult.success) throw new Error(tamperedResult.error);
      expect(tamperedResult.output.isValid).toBe(false);
      expect(tamperedResult.output.expectedHash).toBe(protectedResult.output.fileHash);
      expect(tamperedResult.output.actualHash).not.toBe(protectedResult.output.fileHash);
    } finally {
      if (previousIndexPath === undefined) delete process.env['FILE_PROTECTION_INDEX_PATH'];
      else process.env['FILE_PROTECTION_INDEX_PATH'] = previousIndexPath;
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
