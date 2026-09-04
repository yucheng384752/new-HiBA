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
  protectionId: string;
  fileHash: string;
  chainId: string;
  contractAddress: string;
  txHash: string;
  blockHash: string;
}

interface ProtectionRow {
  file_hash: string;
  tx_hash: string;
  block_hash: string;
}

const protectionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hashPattern = /^[0-9a-f]{64}$/i;
const addressPattern = /^0x[0-9a-f]{40}$/i;
const chainHashPattern = /^0x[0-9a-f]{64}$/i;

export function saveProtectionRecord(record: ProtectionRecord): void {
  validate(record);
  withDatabase(db => db.prepare(`
    INSERT INTO file_protection_index
      (protection_id, file_hash, chain_id, contract_address, tx_hash, block_hash, protected_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(file_hash, chain_id, contract_address) DO UPDATE SET
      protection_id = excluded.protection_id,
      tx_hash = excluded.tx_hash,
      block_hash = excluded.block_hash,
      protected_at = excluded.protected_at
  `).run(
    record.protectionId.toLowerCase(), record.fileHash.toLowerCase(), record.chainId.toLowerCase(), record.contractAddress.toLowerCase(),
    record.txHash.toLowerCase(), record.blockHash.toLowerCase(), new Date().toISOString(),
  ));
}

export function findProtectionRecord(
  fileHash: string,
  chainId: string,
  contractAddress: string,
): Pick<ProtectionRecord, 'txHash' | 'blockHash'> | null {
  validateContext(fileHash, chainId, contractAddress);
  return withDatabase(db => {
    const row = db.prepare(`
      SELECT tx_hash, block_hash FROM file_protection_index
      WHERE file_hash = ? AND chain_id = ? AND contract_address = ?
    `).get(fileHash.toLowerCase(), chainId.toLowerCase(), contractAddress.toLowerCase()) as ProtectionRow | undefined;
    return row === undefined ? null : { txHash: row.tx_hash, blockHash: row.block_hash };
  });
}

export function findProtectionRecordById(
  protectionId: string,
  chainId: string,
  contractAddress: string,
): Pick<ProtectionRecord, 'fileHash' | 'txHash' | 'blockHash'> | null {
  if (!protectionIdPattern.test(protectionId)) throw new Error('Invalid protection ID');
  validateContext('0'.repeat(64), chainId, contractAddress);
  return withDatabase(db => {
    const row = db.prepare(`
      SELECT file_hash, tx_hash, block_hash FROM file_protection_index
      WHERE protection_id = ? AND chain_id = ? AND contract_address = ?
    `).get(protectionId.toLowerCase(), chainId.toLowerCase(), contractAddress.toLowerCase()) as ProtectionRow | undefined;
    return row === undefined ? null : { fileHash: row.file_hash, txHash: row.tx_hash, blockHash: row.block_hash };
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
        protection_id TEXT NOT NULL,
        file_hash TEXT NOT NULL,
        chain_id TEXT NOT NULL,
        contract_address TEXT NOT NULL,
        tx_hash TEXT NOT NULL,
        block_hash TEXT NOT NULL,
        protected_at TEXT NOT NULL,
        PRIMARY KEY (file_hash, chain_id, contract_address)
      )
    `);
    const hasProtectionId = db.prepare(
      `SELECT 1 FROM pragma_table_info('file_protection_index') WHERE name = 'protection_id'`,
    ).get() !== undefined;
    if (!hasProtectionId) db.exec(`ALTER TABLE file_protection_index ADD COLUMN protection_id TEXT`);
    db.exec(`
      UPDATE file_protection_index SET protection_id =
        lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) ||
        '-' || substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))
      WHERE protection_id IS NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS file_protection_index_protection_id ON file_protection_index(protection_id);
    `);
    return action(db);
  } finally {
    db.close();
  }
}

function validate(record: ProtectionRecord): void {
  if (!protectionIdPattern.test(record.protectionId)) throw new Error('Invalid protection ID');
  validateContext(record.fileHash, record.chainId, record.contractAddress);
  if (!chainHashPattern.test(record.txHash)) throw new Error('Invalid transaction hash');
  if (!chainHashPattern.test(record.blockHash)) throw new Error('Invalid block hash');
}

function validateContext(fileHash: string, chainId: string, contractAddress: string): void {
  if (!hashPattern.test(fileHash)) throw new Error('Invalid file hash');
  if (!/^0x[0-9a-f]+$/i.test(chainId)) throw new Error('Invalid chain ID');
  if (!addressPattern.test(contractAddress)) throw new Error('Invalid contract address');
}
