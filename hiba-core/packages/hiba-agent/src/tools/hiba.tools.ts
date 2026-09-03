import { z } from 'zod';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { defineTool } from '../core/defineTool';
import type { HiBAToolbox } from '../core/HiBAToolbox';
import type { ToolContext } from '../types/hiba.types';
import { findProtectionRecordById, saveProtectionRecord } from './FileProtectionIndex';

// ── Shared sub-schemas ────────────────────────────────────────────────────────

const timeRangeSchema = z.object({
  from: z.string().describe('開始時間 ISO 8601'),
  to:   z.string().describe('結束時間 ISO 8601'),
});

// ── Stub handler ──────────────────────────────────────────────────────────────

const notImplemented = async (): Promise<never> => {
  throw new Error('NOT_IMPLEMENTED');
};

// ── Helper: Java HiBA + Web3 RPC bridge ──────────────────────────────────────

type ChainRecord = { txHash: string; blockHash: string };
type TransactionReceipt = { status: string };
type HibaFile = { success?: boolean; fileHash?: string; metadata?: { verdict?: string } };
type HibaResponse = { success: boolean; data?: { files?: HibaFile[] } };

async function hibaFileRequest(
  ctx: ToolContext,
  requestName: 'BlockchainFileProtect' | 'BlockchainFileIntegrity',
  filePath: string,
  keepFile = true,
): Promise<{ response: HibaResponse; fileHash: string }> {
  const bytes = await readFile(filePath);
  const fileName = basename(filePath);
  const form = new FormData();
  form.append('serviceName', requestName);
  form.append('requestName', requestName);
  form.append('description', `HiBA-AB trace ${ctx.traceId}`);
  form.append('keepFile', String(keepFile));
  form.append('file', new Blob([bytes]), fileName);

  const res = await fetch(`${ctx.hibaBaseUrl.replace(/\/$/, '')}/`, {
    method: 'POST',
    headers: {
      'X-Trace-Id': ctx.traceId,
      'X-Agent-Id': ctx.agentId,
      'X-Depth':    String(ctx.depth),
    },
    body: form,
  });
  if (!res.ok) throw new Error(`Java HiBA HTTP ${res.status}`);
  const response = await res.json() as HibaResponse;
  const fileHash = createHash('sha256')
    .update(bytes)
    .update(fileName)
    .update(String(bytes.length))
    .update('SHA-256')
    .update('8192')
    .digest('hex');
  return { response, fileHash };
}

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const url = process.env['WEB3_RPC_URL'] ?? 'http://127.0.0.1:8545';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`Web3 RPC HTTP ${res.status}`);
  const body = await res.json() as { result?: T; error?: { message?: string } };
  if (body.error !== undefined || body.result === undefined) {
    throw new Error(`Web3 RPC ${method} failed: ${body.error?.message ?? 'missing result'}`);
  }
  return body.result;
}

async function latestBlockNumber(): Promise<number> {
  return Number.parseInt(await rpc<string>('eth_blockNumber', []), 16);
}

async function receiptStatus(txHash: string): Promise<string> {
  const receipt = await rpc<TransactionReceipt | null>('eth_getTransactionReceipt', [txHash]);
  if (receipt === null) throw new Error(`Transaction receipt not found for ${txHash}`);
  return receipt.status;
}

async function chainContext(): Promise<{ chainId: string; contractAddress: string }> {
  const chainId = await rpc<string>('eth_chainId', []);
  const contractAddress = process.env['FILE_PROTECTION_CONTRACT_ADDRESS'];
  if (!/^0x[0-9a-f]{40}$/i.test(contractAddress ?? '')) {
    throw new Error('FILE_PROTECTION_CONTRACT_ADDRESS is required and must be a 20-byte address');
  }
  return { chainId, contractAddress: contractAddress! };
}

// Solidity ABI-encodes a `string` argument as a 32-byte length word followed by
// its UTF-8 bytes. fileHash is always a 64-char hex digest, i.e. exactly 64
// bytes / 2 EVM words, so it lands in calldata with no padding — its hex form
// is a reliable, dependency-free substring check against tx.input. This is
// what tells apart this call's on-chain transaction from any other concurrent
// call hitting the same contract address in the same block range.
function fileHashCalldataMarker(fileHash: string): string {
  return Buffer.from(fileHash, 'ascii').toString('hex');
}

export async function findProtectionTransaction(fromBlock: number, toBlock: number, fileHash: string): Promise<ChainRecord> {
  const contract = process.env['FILE_PROTECTION_CONTRACT_ADDRESS']?.toLowerCase();
  if (contract === undefined) throw new Error('FILE_PROTECTION_CONTRACT_ADDRESS is required');
  const marker = fileHashCalldataMarker(fileHash);

  for (let blockNumber = fromBlock + 1; blockNumber <= toBlock; blockNumber += 1) {
    const block = await rpc<{ hash: string; transactions: Array<{ hash: string; to: string | null; input: string }> }>(
      'eth_getBlockByNumber',
      [`0x${blockNumber.toString(16)}`, true],
    );
    const transaction = block.transactions.find(item =>
      item.to?.toLowerCase() === contract && item.input.toLowerCase().includes(marker),
    );
    if (transaction !== undefined) return { txHash: transaction.hash, blockHash: block.hash };
  }
  throw new Error('Java HiBA succeeded but no FileProtection transaction carrying this file hash was found');
}

// ══════════════════════════════════════════════════════════════════════════════
// 料（Material）Agent — 7 Tools
// ══════════════════════════════════════════════════════════════════════════════

const materialProtectFile = defineTool({
  name: 'material.protectFile',
  version: '1.0.0',
  tags: ['material', 'write'],
  description: '將檔案 metadata 上鏈保護',
  inputSchema: z.object({
    filePath: z.string().describe('檔案絕對路徑'),
    keepFile: z.boolean().default(true).describe('是否保留本地檔案'),
  }),
  outputSchema: z.object({
    success:         z.boolean(),
    protectionId:    z.string().uuid().describe('內容無關的穩定保護 ID'),
    fileHash:         z.string().describe('受保護檔案 hash'),
    txHash:           z.string().describe('區塊鏈交易 hash'),
    blockHash:        z.string().describe('區塊 hash'),
    chainId:          z.string().describe('鏈 ID（hex）'),
    contractAddress:  z.string().describe('FileProtection 合約地址'),
    receiptStatus:    z.string().describe('交易 receipt status'),
  }),
  permissions: ['material.write'],
  timeout: 30_000,
  retryPolicy: { maxAttempts: 3, initialDelayMs: 500, backoffMultiplier: 2, retryOn: ['TOOL_TIMEOUT'] },
  handler: async (input, ctx) => {
    const before = await latestBlockNumber();
    const { response, fileHash } = await hibaFileRequest(ctx, 'BlockchainFileProtect', input.filePath, input.keepFile);
    const file = response.data?.files?.[0];
    if (!response.success || !file?.success || file.fileHash !== fileHash) {
      throw new Error('Java HiBA did not protect the file');
    }
    const chain = await findProtectionTransaction(before, await latestBlockNumber(), fileHash);
    const context = await chainContext();
    const protectionId = randomUUID();
    const status = await receiptStatus(chain.txHash);
    if (status !== '0x1') throw new Error(`FileProtection transaction failed with receipt status ${status}`);
    saveProtectionRecord({ protectionId, fileHash, ...context, ...chain });
    return { success: true, protectionId, fileHash, ...chain, ...context, receiptStatus: status };
  },
});

const materialVerifyFile = defineTool({
  name: 'material.verifyFile',
  version: '1.0.0',
  tags: ['material', 'read'],
  description: '驗證檔案 metadata 是否與鏈上記錄一致',
  inputSchema: z.object({
    filePath:     z.string().describe('檔案絕對路徑'),
    protectionId: z.string().uuid().describe('material.protectFile 回傳的穩定保護 ID'),
  }),
  outputSchema: z.object({
    isValid:          z.boolean().describe('驗證結果'),
    protectionId:     z.string().uuid(),
    expectedHash:     z.string().describe('原始保護 hash'),
    actualHash:       z.string().describe('目前檔案 hash'),
    verdict:          z.string().describe('Java HiBA 驗證結果'),
    txHash:           z.string().describe('上鏈交易 hash'),
    blockHash:        z.string().describe('區塊雜湊'),
    chainId:          z.string().describe('鏈 ID（hex）'),
    contractAddress:  z.string().describe('FileProtection 合約地址'),
    receiptStatus:    z.string().describe('原始保護交易 receipt status'),
  }),
  permissions: ['material.read'],
  timeout: 15_000,
  retryPolicy: { maxAttempts: 2, initialDelayMs: 500, backoffMultiplier: 2, retryOn: ['TOOL_TIMEOUT'] },
  handler: async (input, ctx) => {
    const context = await chainContext();
    const chain = findProtectionRecordById(input.protectionId, context.chainId, context.contractAddress);
    if (chain === null) throw new Error('No protection transaction indexed for this protection ID, chain, and contract');
    const { response, fileHash } = await hibaFileRequest(ctx, 'BlockchainFileIntegrity', input.filePath);
    const file = response.data?.files?.[0];
    const verdict = file?.metadata?.verdict ?? 'VERIFICATION_FAILED';
    return {
      isValid: response.success && file?.success === true && verdict === 'VERIFICATION_SUCCESSFUL' && fileHash === chain.fileHash,
      protectionId: input.protectionId,
      expectedHash: chain.fileHash,
      actualHash: fileHash,
      verdict,
      ...chain,
      ...context,
      receiptStatus: await receiptStatus(chain.txHash),
    };
  },
});

const materialTraceLot = defineTool({
  name: 'material.traceLot',
  version: '1.0.0',
  tags: ['material', 'read'],
  description: '批次追蹤：查詢批次從進料到出貨的完整記錄',
  inputSchema: z.object({ lotId: z.string().describe('批次 ID') }),
  outputSchema: z.object({
    lotId: z.string(),
    records: z.array(z.object({
      timestamp:  z.string().describe('ISO 8601'),
      operation:  z.string().describe('操作名稱'),
      operatorId: z.string().describe('操作員 ID'),
      location:   z.string().describe('作業位置'),
    })).describe('批次追蹤記錄（依時序排列）'),
  }),
  permissions: ['material.read'],
  timeout: 10_000,
  handler: notImplemented,
});

const materialQueryStock = defineTool({
  name: 'material.queryStock',
  version: '1.0.0',
  tags: ['material', 'read'],
  description: '查詢指定料號的即時庫存數量與儲位',
  inputSchema: z.object({ partNumber: z.string().describe('料號') }),
  outputSchema: z.object({
    partNumber:  z.string(),
    quantity:    z.number().describe('庫存數量'),
    location:    z.string().describe('儲位代號'),
    unit:        z.string().describe('計量單位'),
    lastUpdated: z.string().describe('最後更新時間 ISO 8601'),
  }),
  permissions: ['material.read'],
  timeout: 8_000,
  handler: notImplemented,
});

const materialFetchBom = defineTool({
  name: 'material.fetchBom',
  version: '1.0.0',
  tags: ['material', 'read'],
  description: '取得指定產品的 BOM（用料清單）',
  inputSchema: z.object({
    productId: z.string().describe('產品 ID'),
    revision:  z.string().optional().describe('BOM 版本，省略時取最新版'),
  }),
  outputSchema: z.object({
    productId: z.string(),
    revision:  z.string(),
    items: z.array(z.object({
      partNumber:  z.string(),
      quantity:    z.number(),
      unit:        z.string(),
      description: z.string().optional(),
    })).describe('BOM 項目清單'),
  }),
  permissions: ['material.read'],
  timeout: 10_000,
  handler: notImplemented,
});

const materialInspectIncoming = defineTool({
  name: 'material.inspectIncoming',
  version: '1.0.0',
  tags: ['material', 'write'],
  description: '記錄進料檢驗結果',
  inputSchema: z.object({
    lotId:            z.string().describe('批次 ID'),
    inspectionResult: z.enum(['pass', 'fail', 'conditional']).describe('檢驗結果'),
    notes:            z.string().optional().describe('備註說明'),
  }),
  outputSchema: z.object({
    success:   z.boolean(),
    recordId:  z.string().describe('稽核記錄 ID'),
    timestamp: z.string().describe('記錄時間 ISO 8601'),
  }),
  permissions: ['material.write'],
  timeout: 10_000,
  handler: notImplemented,
});

const materialCheckExpiry = defineTool({
  name: 'material.checkExpiry',
  version: '1.0.0',
  tags: ['material', 'read'],
  description: '查詢批次有效期限與狀態預警',
  inputSchema: z.object({ lotId: z.string().describe('批次 ID') }),
  outputSchema: z.object({
    lotId:         z.string(),
    expiryDate:    z.string().describe('到期日 ISO 8601'),
    daysRemaining: z.number().describe('距到期剩餘天數'),
    status:        z.enum(['valid', 'expiring_soon', 'expired']).describe('有效期狀態'),
  }),
  permissions: ['material.read'],
  timeout: 8_000,
  handler: notImplemented,
});

// ══════════════════════════════════════════════════════════════════════════════
// 機（Machine）Agent — 5 Tools
// ══════════════════════════════════════════════════════════════════════════════

const machineQueryStatus = defineTool({
  name: 'machine.queryStatus',
  version: '1.0.0',
  tags: ['machine', 'read'],
  description: '查詢機台當前運作狀態',
  inputSchema: z.object({ machineId: z.string().describe('機台 ID') }),
  outputSchema: z.object({
    machineId: z.string(),
    status:    z.enum(['running', 'idle', 'error']).describe('運作狀態'),
    oee:       z.number(),
    alarms:    z.array(z.unknown()),
    queriedAt: z.string().describe('查詢時間 ISO 8601'),
    orderId:   z.string().nullable().optional(),
  }),
  permissions: ['machine.read'],
  timeout: 8_000,
  handler: notImplemented,
});

const machineCalculateOee = defineTool({
  name: 'machine.calculateOee',
  version: '1.0.0',
  tags: ['machine', 'read'],
  description: '計算指定時間區間的 OEE（稼動率 × 效能率 × 良品率）',
  inputSchema: z.object({ machineId: z.string().describe('機台 ID'), timeRange: timeRangeSchema }),
  outputSchema: z.object({
    machineId:   z.string(),
    oee:         z.number().describe('OEE 綜合效率（0–100）'),
    availability: z.number().describe('稼動率（0–100）'),
    performance: z.number().describe('效能率（0–100）'),
    quality:     z.number().describe('良品率（0–100）'),
  }),
  permissions: ['machine.read'],
  timeout: 15_000,
  handler: notImplemented,
});

const machineSchedulePm = defineTool({
  name: 'machine.schedulePm',
  version: '1.0.0',
  tags: ['machine', 'write'],
  description: '建立預防保養（PM）工單',
  inputSchema: z.object({
    machineId:     z.string().describe('機台 ID'),
    scheduledDate: z.string().describe('預排保養日期 ISO 8601'),
    pmType:        z.string().optional().describe('保養類型（省略時套用預設計畫）'),
  }),
  outputSchema: z.object({
    success:       z.boolean(),
    workOrderId:   z.string().describe('PM 工單 ID'),
    scheduledDate: z.string().describe('確認排程日期 ISO 8601'),
  }),
  permissions: ['machine.write'],
  timeout: 10_000,
  handler: notImplemented,
});

const machineListAlarms = defineTool({
  name: 'machine.listAlarms',
  version: '1.0.0',
  tags: ['machine', 'read'],
  description: '查詢指定時間區間內的機台警報記錄',
  inputSchema: z.object({ machineId: z.string().describe('機台 ID'), timeRange: timeRangeSchema }),
  outputSchema: z.object({
    machineId: z.string(),
    alarms: z.array(z.object({
      alarmCode:   z.string().describe('警報碼'),
      description: z.string().describe('說明'),
      severity:    z.enum(['low', 'medium', 'high', 'critical']).describe('嚴重等級'),
      timestamp:   z.string().describe('發生時間 ISO 8601'),
    })).describe('警報清單（依時序降序）'),
    total: z.number().describe('警報總筆數'),
  }),
  permissions: ['machine.read'],
  timeout: 10_000,
  handler: notImplemented,
});

const machineCheckCalib = defineTool({
  name: 'machine.checkCalib',
  version: '1.0.0',
  tags: ['machine', 'read'],
  description: '查詢機台校正狀態與下次校正到期日',
  inputSchema: z.object({ machineId: z.string().describe('機台 ID') }),
  outputSchema: z.object({
    machineId:     z.string(),
    lastCalibDate: z.string().describe('最近校正日期 ISO 8601'),
    nextCalibDate: z.string().describe('下次校正期限 ISO 8601'),
    status:        z.enum(['valid', 'due_soon', 'overdue']).describe('校正有效狀態'),
  }),
  permissions: ['machine.read'],
  timeout: 8_000,
  handler: notImplemented,
});

// ══════════════════════════════════════════════════════════════════════════════
// 人（Man）Agent — 5 Tools
// ══════════════════════════════════════════════════════════════════════════════

const manLoginOperator = defineTool({
  name: 'man.loginOperator',
  version: '1.0.0',
  tags: ['man', 'write'],
  description: '操作員登入，回傳 session token',
  inputSchema: z.object({
    employeeId:   z.string().describe('員工 ID'),
    passwordHash: z.string().describe('密碼 SHA-256 雜湊（hex）'),
  }),
  outputSchema: z.object({
    success:      z.boolean(),
    sessionToken: z.string().optional().describe('Session token（失敗時省略）'),
    expiresAt:    z.string().optional().describe('到期時間 ISO 8601（失敗時省略）'),
  }),
  permissions: ['man.write'],
  timeout: 10_000,
  handler: notImplemented,
});

const manQueryShift = defineTool({
  name: 'man.queryShift',
  version: '1.0.0',
  tags: ['man', 'read'],
  description: '查詢指定日期的班表與在班人員',
  inputSchema: z.object({ date: z.string().describe('查詢日期 ISO 8601（YYYY-MM-DD）') }),
  outputSchema: z.object({
    date: z.string(),
    shifts: z.array(z.object({
      shiftId:   z.string().describe('班次 ID'),
      name:      z.string().describe('班次名稱'),
      startTime: z.string().describe('開始時間 HH:mm'),
      endTime:   z.string().describe('結束時間 HH:mm'),
      operators: z.array(z.string()).describe('在班員工 ID 清單'),
    })),
  }),
  permissions: ['man.read'],
  timeout: 8_000,
  handler: notImplemented,
});

const manVerifyOperatorCert = defineTool({
  name: 'man.verifyOperatorCert',
  version: '1.0.0',
  tags: ['man', 'read'],
  description: '驗證操作員是否具備指定技能的有效資格證書',
  inputSchema: z.object({
    employeeId: z.string().describe('員工 ID'),
    skillCode:  z.string().describe('技能碼'),
  }),
  outputSchema: z.object({
    employeeId:  z.string(),
    skillCode:   z.string(),
    isValid:     z.boolean().describe('證書是否有效'),
    certExpiry:  z.string().optional().describe('證書到期日 ISO 8601'),
  }),
  permissions: ['man.read'],
  timeout: 8_000,
  handler: notImplemented,
});

const manCheckSkill = defineTool({
  name: 'man.checkSkill',
  version: '1.0.0',
  tags: ['man', 'read'],
  description: '取得操作員的完整技能清單',
  inputSchema: z.object({ employeeId: z.string().describe('員工 ID') }),
  outputSchema: z.object({
    employeeId: z.string(),
    skills: z.array(z.object({
      skillCode:  z.string(),
      name:       z.string().describe('技能名稱'),
      level:      z.enum(['trainee', 'qualified', 'expert']).describe('技能等級'),
      certExpiry: z.string().optional().describe('到期日 ISO 8601'),
    })).describe('技能清單'),
  }),
  permissions: ['man.read'],
  timeout: 8_000,
  handler: notImplemented,
});

const manSendAlert = defineTool({
  name: 'man.sendAlert',
  version: '1.0.0',
  tags: ['man', 'write'],
  description: '發送即時通知給指定操作員',
  inputSchema: z.object({
    employeeId: z.string().describe('員工 ID'),
    message:    z.string().describe('通知內容'),
    priority:   z.enum(['low', 'normal', 'urgent']).default('normal').describe('優先等級'),
  }),
  outputSchema: z.object({
    success:     z.boolean(),
    channel:     z.string().describe('實際使用的通知管道'),
    deliveredAt: z.string().optional().describe('送達時間 ISO 8601'),
  }),
  permissions: ['man.write'],
  timeout: 10_000,
  handler: notImplemented,
});

// ══════════════════════════════════════════════════════════════════════════════
// 法（Method）Agent — 5 Tools
// ══════════════════════════════════════════════════════════════════════════════

const methodFetchSop = defineTool({
  name: 'method.fetchSop',
  version: '1.0.0',
  tags: ['method', 'read'],
  description: '取得指定 SOP 的文件 URL 與版本資訊',
  inputSchema: z.object({
    sopCode:  z.string().describe('SOP 編號'),
    language: z.enum(['zh-TW', 'en-US']).default('zh-TW').describe('文件語言'),
  }),
  outputSchema: z.object({
    sopCode:       z.string(),
    title:         z.string().describe('SOP 標題'),
    version:       z.string().describe('文件版本'),
    url:           z.string().describe('SOP 文件 URL'),
    effectiveDate: z.string().describe('生效日期 ISO 8601'),
  }),
  permissions: ['method.read'],
  timeout: 8_000,
  handler: notImplemented,
});

const methodValidateParam = defineTool({
  name: 'method.validateParam',
  version: '1.0.0',
  tags: ['method', 'read'],
  description: '驗證製程參數量測值是否在規格範圍內',
  inputSchema: z.object({
    processId: z.string().describe('製程 ID'),
    paramKey:  z.string().describe('參數鍵值'),
    value:     z.number().describe('量測值'),
  }),
  outputSchema: z.object({
    processId:    z.string(),
    paramKey:     z.string(),
    value:        z.number(),
    isWithinSpec: z.boolean().describe('是否在規格範圍內'),
    lowerLimit:   z.number().optional().describe('規格下限'),
    upperLimit:   z.number().optional().describe('規格上限'),
  }),
  permissions: ['method.read'],
  timeout: 5_000,
  handler: notImplemented,
});

const methodQueryEcn = defineTool({
  name: 'method.queryEcn',
  version: '1.0.0',
  tags: ['method', 'read'],
  description: '查詢指定料號相關的工程變更通知（ECN）清單',
  inputSchema: z.object({
    partNumber: z.string().describe('料號'),
    status:     z.enum(['all', 'active', 'draft', 'obsolete']).default('active').describe('ECN 狀態篩選'),
  }),
  outputSchema: z.object({
    partNumber: z.string(),
    ecns: z.array(z.object({
      ecnNumber:     z.string().describe('ECN 編號'),
      description:   z.string().describe('變更說明'),
      effectiveDate: z.string().describe('生效日期 ISO 8601'),
      status:        z.enum(['draft', 'active', 'obsolete']),
    })).describe('ECN 清單'),
    total: z.number(),
  }),
  permissions: ['method.read'],
  timeout: 8_000,
  handler: notImplemented,
});

const methodRecordAudit = defineTool({
  name: 'method.recordAudit',
  version: '1.0.0',
  tags: ['method', 'write'],
  description: '記錄品質稽核結果',
  inputSchema: z.object({
    auditType: z.string().describe('稽核類型（e.g. process / supplier / product）'),
    result:    z.enum(['pass', 'fail', 'observation']).describe('稽核結果'),
    notes:     z.string().optional().describe('備註說明'),
  }),
  outputSchema: z.object({
    success:   z.boolean(),
    recordId:  z.string().describe('稽核記錄 ID'),
    timestamp: z.string().describe('記錄時間 ISO 8601'),
  }),
  permissions: ['method.write'],
  timeout: 8_000,
  handler: notImplemented,
});

const methodCheckCompliance = defineTool({
  name: 'method.checkCompliance',
  version: '1.0.0',
  tags: ['method', 'read'],
  description: '查詢產品的 IATF 16949 合規狀態',
  inputSchema: z.object({ productId: z.string().describe('產品 ID') }),
  outputSchema: z.object({
    productId:       z.string(),
    standard:        z.literal('IATF-16949'),
    isCompliant:     z.boolean(),
    nonConformities: z.array(z.string()).describe('不符合項目列表（合規時為空陣列）'),
    lastAuditDate:   z.string().optional().describe('最近稽核日期 ISO 8601'),
  }),
  permissions: ['method.read'],
  timeout: 10_000,
  handler: notImplemented,
});

// ══════════════════════════════════════════════════════════════════════════════
// 環（Environment）Agent — 4 Tools
// ══════════════════════════════════════════════════════════════════════════════

const envReadTemperature = defineTool({
  name: 'env.readTemperature',
  version: '1.0.0',
  tags: ['env', 'read'],
  description: '讀取指定感測器的即時溫度',
  inputSchema: z.object({ sensorId: z.string().describe('感測器 ID') }),
  outputSchema: z.object({
    sensorId:    z.string(),
    temperature: z.number().describe('溫度值（°C）'),
    unit:        z.literal('celsius'),
    timestamp:   z.string().describe('量測時間 ISO 8601'),
  }),
  permissions: ['env.read'],
  timeout: 5_000,
  handler: notImplemented,
});

const envReadHumidity = defineTool({
  name: 'env.readHumidity',
  version: '1.0.0',
  tags: ['env', 'read'],
  description: '讀取指定感測器的即時相對濕度',
  inputSchema: z.object({ sensorId: z.string().describe('感測器 ID') }),
  outputSchema: z.object({
    sensorId:  z.string(),
    humidity:  z.number().describe('相對濕度（%RH）'),
    unit:      z.literal('percent_rh'),
    timestamp: z.string().describe('量測時間 ISO 8601'),
  }),
  permissions: ['env.read'],
  timeout: 5_000,
  handler: notImplemented,
});

const envCheckCleanroom = defineTool({
  name: 'env.checkCleanroom',
  version: '1.0.0',
  tags: ['env', 'read'],
  description: '查詢潔淨室的 ISO 等級與即時粒子計數',
  inputSchema: z.object({ roomId: z.string().describe('潔淨室 ID') }),
  outputSchema: z.object({
    roomId:       z.string(),
    isoClass:     z.number().int().min(1).max(9).describe('ISO 14644-1 等級（1–9）'),
    particleCount: z.number().describe('粒子計數（個/m³，≥0.5μm）'),
    status:       z.enum(['compliant', 'warning', 'non_compliant']).describe('合規狀態'),
    timestamp:    z.string().describe('量測時間 ISO 8601'),
  }),
  permissions: ['env.read'],
  timeout: 8_000,
  handler: notImplemented,
});

const envAlertThreshold = defineTool({
  name: 'env.alertThreshold',
  version: '1.0.0',
  tags: ['env', 'write'],
  description: '設定感測器警報閾值',
  inputSchema: z.object({
    sensorId: z.string().describe('感測器 ID'),
    thresholdConfig: z.object({
      min:          z.number().optional().describe('下限（超出時觸發警報）'),
      max:          z.number().optional().describe('上限（超出時觸發警報）'),
      alertChannel: z.string().optional().describe('警報通知管道'),
    }),
  }),
  outputSchema: z.object({
    success:      z.boolean(),
    sensorId:     z.string(),
    configuredAt: z.string().describe('設定時間 ISO 8601'),
  }),
  permissions: ['env.write'],
  timeout: 5_000,
  handler: notImplemented,
});

// ══════════════════════════════════════════════════════════════════════════════
// Pi Sub-Web Script Tools — 5 Tools（對應 manifest.json，由 OrchestratorRunner 遠端派發）
// ══════════════════════════════════════════════════════════════════════════════

const envVerifyFileIo = defineTool({
  name: 'env.verifyFileIo',
  version: '1.0.0',
  tags: ['env', 'write'],
  description: 'Pi 本地檔案系統讀寫驗證（2-phase：probe 確認通道，write 寫入並回讀）',
  inputSchema: z.object({
    mode:     z.enum(['probe', 'write', 'full']).default('full').describe('執行模式'),
    content:  z.string().optional().describe('要寫入的字串（write/full 用，省略時使用時間戳）'),
    filename: z.string().optional().describe('檔名（省略時使用 test_io.txt）'),
  }),
  outputSchema: z.object({
    success:    z.boolean(),
    phase:      z.enum(['probe', 'write', 'full']),
    transferOk: z.boolean().optional().describe('probe / full 模式：空檔傳輸是否成功'),
    written:    z.boolean().optional().describe('write / full 模式：是否已寫入'),
    content:    z.string().optional(),
    path:       z.string().describe('寫入的絕對路徑'),
    sizeBytes:  z.number().optional(),
    writtenAt:  z.string().optional().describe('寫入時間 ISO 8601'),
    readBack:   z.string().optional().describe('回讀內容'),
    matched:    z.boolean().optional().describe('寫入內容與回讀是否一致'),
    failReason: z.string().optional().describe('probe 失敗原因；成功時不存在'),
  }),
  permissions: ['env.write'],
  timeout: 15_000,
  handler: notImplemented,
});

const machineExecuteOrder = defineTool({
  name: 'machine.executeOrder',
  version: '1.0.0',
  tags: ['machine', 'write'],
  description: '在 Pi 節點執行工單（讀取 data_orders.json）',
  inputSchema: z.object({
    machineId: z.string().describe('機台 ID，如 CNC-01'),
    orderId:  z.string().describe('工單 ID，如 WO-2026-001'),
    quantity: z.number().optional().describe('執行數量（省略時沿用工單預設）'),
  }),
  outputSchema: z.object({
    success:     z.boolean(),
    machineId:   z.string(),
    orderId:     z.string(),
    product:     z.string(),
    material:    z.string(),
    quantity:    z.number(),
    processed:   z.number(),
    unit:        z.string(),
    priority:    z.string(),
    completedAt: z.string().describe('完成時間 ISO 8601'),
  }),
  permissions: ['machine.write'],
  timeout: 10_000,
  handler: notImplemented,
});

const envReadSensor = defineTool({
  name: 'env.readSensor',
  version: '1.0.0',
  tags: ['env', 'read'],
  description: '讀取 Pi 節點所有環境感測器（溫濕度等），可指定單一感測器 ID',
  inputSchema: z.object({
    sensorId: z.string().optional().describe('感測器 ID（省略時讀取全部）'),
  }),
  outputSchema: z.object({
    temperature: z.number().optional().describe('代表性溫度（°C）'),
    humidity:    z.number().optional().describe('代表性相對濕度（%RH）'),
    sensors:     z.array(z.object({
      sensorId:    z.string(),
      temperature: z.number(),
      humidity:    z.number(),
      timestamp:   z.string(),
    })).describe('所有感測器讀值陣列'),
    timestamp: z.string().describe('量測時間 ISO 8601'),
  }),
  permissions: ['env.read'],
  timeout: 5_000,
  handler: notImplemented,
});

const orchestratorEchoRtt = defineTool({
  name: 'orchestrator.echoRtt',
  version: '1.0.0',
  tags: ['orchestrator', 'read'],
  description: 'Echo 回響 / RTT 測試：驗證 PC→Pi→PC 通道並量測延遲',
  inputSchema: z.object({
    message: z.string().optional().describe('任意字串，Pi 原樣回傳'),
    sentAt:  z.string().optional().describe('PC 送出時間戳（ISO 8601），用於計算 RTT'),
  }),
  outputSchema: z.object({
    success:    z.boolean(),
    echo:       z.string(),
    sentAt:     z.string().optional(),
    receivedAt: z.string(),
    rttMs:      z.number().nullable().describe('Pi 端量測的來回延遲 ms'),
    nodeId:     z.string(),
  }),
  permissions: ['orchestrator.read'],
  timeout: 10_000,
  handler: notImplemented,
});

const orchestratorUpdateSubWebRuntime = defineTool({
  name: 'orchestrator.updateSubWebRuntime',
  version: '1.0.0',
  tags: ['orchestrator', 'write'],
  description: '在目前節點本機安裝或更新 Sub-Web runtime；不會透過 SSH 部署其他節點',
  inputSchema: z.object({
    hibaRoot: z.string().optional().describe('安裝根目錄，預設 /opt/hiba'),
    nodeId:   z.string().optional().describe('節點 ID，預設 m1'),
    clawUrl:  z.string().optional().describe('Claw 主控端 URL'),
  }),
  outputSchema: z.object({
    success:    z.boolean(),
    steps:      z.array(z.unknown()),
    warnings:   z.array(z.unknown()),
    serverPath: z.string(),
    scriptsDir: z.string(),
    dataDir:    z.string(),
  }),
  permissions: ['orchestrator.write'],
  timeout: 180_000,
  handler: notImplemented,
});

const materialReadAttachment = defineTool({
  name: 'material.readAttachment',
  version: '1.0.0',
  tags: ['material', 'read'],
  description: '讀取前端上傳的附加文件並回傳摘要（_filePath 由後端自動注入）',
  inputSchema: z.object({
    _filePath: z.string().optional().describe('由後端注入的臨時檔案路徑'),
    _fileName: z.string().optional().describe('原始檔名（後端注入）'),
    maxRows:   z.number().int().min(1).max(200).default(20).describe('最多回傳幾行'),
  }),
  outputSchema: z.object({
    success:   z.boolean(),
    fileName:  z.string(),
    sizeBytes: z.number(),
    lineCount: z.number(),
    preview:   z.string().describe('前 N 行或 JSON 摘要'),
    dataType:  z.enum(['json', 'text']),
    summary:   z.string().optional().describe('內容類型與筆數的一句話摘要'),
    filePath:  z.string().describe('Agent 暫存路徑，供後續 material tools 使用'),
  }),
  permissions: ['material.read'],
  timeout: 10_000,
  handler: async input => {
    if (!input._filePath) throw new Error('No attachment was uploaded');
    const bytes = await readFile(input._filePath);
    const text = bytes.toString('utf8');
    const lines = text.split(/\r?\n/);
    let dataType: 'json' | 'text' = 'text';
    let summary = `${lines.length} lines of text`;
    try {
      const value = JSON.parse(text) as unknown;
      dataType = 'json';
      summary = Array.isArray(value) ? `JSON array with ${value.length} items` : 'JSON document';
    } catch { /* text attachment */ }
    return {
      success: true,
      fileName: input._fileName ?? basename(input._filePath),
      sizeBytes: bytes.byteLength,
      lineCount: lines.length,
      preview: lines.slice(0, input.maxRows).join('\n'),
      dataType,
      summary,
      filePath: input._filePath,
    };
  },
});

// ══════════════════════════════════════════════════════════════════════════════
// Orchestrator Meta-Tools — 1 Tool
// (orchestrator.verifyAuditIntegrity / anchorAuditBatch / getAuditSummary 在 audit.tools.ts)
// ══════════════════════════════════════════════════════════════════════════════

const orchestratorListAgents = defineTool({
  name: 'orchestrator.listAgents',
  version: '1.0.0',
  tags: ['orchestrator', 'read'],
  description: '回傳 TrustRegistry 中已註冊的 Agent 清單與狀態',
  inputSchema: z.object({
    statusFilter: z.enum(['all', 'active', 'suspended']).default('all').describe('狀態篩選'),
  }),
  outputSchema: z.object({
    agents: z.array(z.object({
      agentId:      z.string(),
      name:         z.string(),
      status:       z.enum(['registered', 'active', 'suspended']),
      permissions:  z.array(z.string()).describe('持有的權限集合'),
      registeredAt: z.string().describe('註冊時間 ISO 8601'),
    })),
    total: z.number(),
  }),
  permissions: ['orchestrator.read'],
  timeout: 10_000,
  handler: notImplemented,
});

// ── All tools array ───────────────────────────────────────────────────────────

export const allHibaTools = [
  materialProtectFile,
  materialVerifyFile,
  materialTraceLot,
  materialQueryStock,
  materialFetchBom,
  materialInspectIncoming,
  materialCheckExpiry,
  machineQueryStatus,
  machineCalculateOee,
  machineSchedulePm,
  machineListAlarms,
  machineCheckCalib,
  manLoginOperator,
  manQueryShift,
  manVerifyOperatorCert,
  manCheckSkill,
  manSendAlert,
  methodFetchSop,
  methodValidateParam,
  methodQueryEcn,
  methodRecordAudit,
  methodCheckCompliance,
  envReadTemperature,
  envReadHumidity,
  envCheckCleanroom,
  envAlertThreshold,
  envVerifyFileIo,
  machineExecuteOrder,
  envReadSensor,
  orchestratorEchoRtt,
  orchestratorUpdateSubWebRuntime,
  materialReadAttachment,
  orchestratorListAgents,
];

export function registerHibaTools(toolbox: HiBAToolbox): void {
  for (const tool of allHibaTools) {
    toolbox.register(tool);
  }
}
