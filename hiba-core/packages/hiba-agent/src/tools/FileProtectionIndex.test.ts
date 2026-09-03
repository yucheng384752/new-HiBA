import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from '@jest/globals';
import { findProtectionRecord, saveProtectionRecord } from './FileProtectionIndex';

describe('FileProtectionIndex', () => {
  test('persists a transaction across separate database connections', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hiba-index-'));
    const previousPath = process.env['FILE_PROTECTION_INDEX_PATH'];
    process.env['FILE_PROTECTION_INDEX_PATH'] = join(dir, 'index.sqlite');
    const record = {
      fileHash: 'a'.repeat(64),
      chainId: '0x7a69',
      contractAddress: `0x${'b'.repeat(40)}`,
      txHash: `0x${'c'.repeat(64)}`,
      blockHash: `0x${'d'.repeat(64)}`,
    };

    try {
      saveProtectionRecord(record);
      expect(findProtectionRecord(record.fileHash, record.chainId, record.contractAddress)).toEqual({
        txHash: record.txHash,
        blockHash: record.blockHash,
      });
      expect(findProtectionRecord(record.fileHash, '0x1', record.contractAddress)).toBeNull();
    } finally {
      if (previousPath === undefined) delete process.env['FILE_PROTECTION_INDEX_PATH'];
      else process.env['FILE_PROTECTION_INDEX_PATH'] = previousPath;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
