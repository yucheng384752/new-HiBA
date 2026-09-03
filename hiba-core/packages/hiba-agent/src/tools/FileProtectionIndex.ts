import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

interface SqliteStatement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

export interface ProtectionRecord {
  fileHash: string;
  chainId: string;
  contractAddress: string;
  txHash: string;
  blockHash: string;
}

interface ProtectionRow {
  tx_hash: string;
  block_hash: string;
}

const hashPattern = /^[0-9a-f]{64}$/i;
const addressPattern = /^0x[0-9a-f]{40}$/i;
const chainHashPattern = /^0x[0-9a-f]{64}$/i;

export function saveProtectionRecord(record: ProtectionRecord): void {
  validate(record);
  withDatabase(db => db.prepare(`
    INSERT INTO file_protection_index
      (file_hash, chain_id, contract_address, tx_hash, block_hash, protected_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(file_hash, chain_id, contract_address) DO UPDATE SET
      tx_hash = excluded.tx_hash,
      block_hash = excluded.block_hash,
      protected_at = excluded.protected_at
  `).run(
    record.fileHash.toLowerCase(), record.chainId.toLowerCase(), record.contractAddress.toLowerCase(),
    record.txHash.toLowerCase(), record.blockHash.toLowerCase(), new Date().toISOString(),
  ));
}

export function findProtectionRecord(
  fileHash: string,
  chainId: string,
  contractAddress: string,
): Pick<ProtectionRecord, 'txHash' | 'blockHash'> | null {
  validate({ fileHash, chainId, contractAddress, txHash: `0x${'0'.repeat(64)}`, blockHash: `0x${'0'.repeat(64)}` });
  return withDatabase(db => {
    const row = db.prepare(`
      SELECT tx_hash, block_hash FROM file_protection_index
      WHERE file_hash = ? AND chain_id = ? AND contract_address = ?
    `).get(fileHash.toLowerCase(), chainId.toLowerCase(), contractAddress.toLowerCase()) as ProtectionRow | undefined;
    return row === undefined ? null : { txHash: row.tx_hash, blockHash: row.block_hash };
  });
}

function withDatabase<T>(action: (db: SqliteDatabase) => T): T {
  // ponytail: open per operation for restart-safe lifecycle; keep a shared connection only if profiling shows contention.
  const dbPath = process.env['FILE_PROTECTION_INDEX_PATH'] ?? resolve('data', 'file-protection-index.db');
  mkdirSync(dirname(dbPath), { recursive: true });
  const Database = require('better-sqlite3') as new (path: string) => SqliteDatabase;
  const db = new Database(dbPath);
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS file_protection_index (
        file_hash TEXT NOT NULL,
        chain_id TEXT NOT NULL,
        contract_address TEXT NOT NULL,
        tx_hash TEXT NOT NULL,
        block_hash TEXT NOT NULL,
        protected_at TEXT NOT NULL,
        PRIMARY KEY (file_hash, chain_id, contract_address)
      )
    `);
    return action(db);
  } finally {
    db.close();
  }
}

function validate(record: ProtectionRecord): void {
  if (!hashPattern.test(record.fileHash)) throw new Error('Invalid file hash');
  if (!/^0x[0-9a-f]+$/i.test(record.chainId)) throw new Error('Invalid chain ID');
  if (!addressPattern.test(record.contractAddress)) throw new Error('Invalid contract address');
  if (!chainHashPattern.test(record.txHash)) throw new Error('Invalid transaction hash');
  if (!chainHashPattern.test(record.blockHash)) throw new Error('Invalid block hash');
}
