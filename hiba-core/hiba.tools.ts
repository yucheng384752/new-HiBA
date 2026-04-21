/**
 * hiba.tools.ts — 全域 ToolRegistry 初始化
 *
 * 本模組以副作用方式呼叫 defineTool()，將所有 Tool 注入全域 ToolRegistry。
 * 在應用程式入口點 import 一次即可：
 *   import './hiba.tools';
 *
 * 標記 ⭐ 的 Tool 具有真實 handler（對接 hiba-core Java API）。
 * 其餘 Tool handler 為 NOT_IMPLEMENTED stub，待後端接通後逐一替換。
 *
 * 料(material) 7 + 機(machine) 5 + 人(man) 5 + 法(method) 5 + 環(env) 4 + meta 2 = 28
 */

import { z } from 'zod';
import { defineTool } from './hiba.toolbox';
import type { ToolContext } from './hiba.types';

// ── Shared sub-schemas ────────────────────────────────────────────────────────

const timeRangeSchema = z.object({
  from: z.string().describe('開始時間 ISO 8601'),
  to: z.string().describe('結束時間 ISO 8601'),
});

// ── Stub handler ──────────────────────────────────────────────────────────────

const notImplemented = async (): Promise<never> => {
  throw new Error('NOT_IMPLEMENTED');
};

// ── Helper: standard API fetch ────────────────────────────────────────────────

async function hibaFetch(
  ctx: ToolContext,
  path: string,
  body: unknown,
): Promise<unknown> {
  const res = await fetch(`${ctx.hibaBaseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Trace-Id': ctx.traceId,
      'X-Agent-Id': ctx.agentId,
      'X-Depth': String(ctx.depth),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${path}`);
  return res.json();
}

// ══════════════════════════════════════════════════════════════════════════════
// 料（Material）Agent — 7 Tools
// ══════════════════════════════════════════════════════════════════════════════

defineTool({
  name: 'material.protectFile',
  version: '1.0.0',
  tags: ['material', 'write'],
  description: '將檔案 metadata 上鏈保護 ⭐',
  inputSchema: z.object({
    filePath: z.string().describe('檔案絕對路徑'),
    keepFile: z.boolean().default(true).describe('是否保留本地檔案'),
  }),
  outputSchema: z.object({
    success: z.boolean().describe('ui:widget: status-light'),
    txHash: z.string().describe('區塊鏈交易 hash'),
  }),
  permissions: ['material.write'],
  timeout: 30_000,
  retryPolicy: { maxAttempts: 3, initialDelayMs: 500, backoffMultiplier: 2, retryOn: ['TOOL_TIMEOUT'] },
  handler: async (input, ctx) => {
    const data = await hibaFetch(ctx, '/api/blockchain/protect', { filePath: input.filePath }) as { txHash: string };
    return { success: true, txHash: data.txHash };
  },
});

defineTool({
  name: 'material.verifyFile',
  version: '1.0.0',
  tags: ['material', 'read'],
  description: '驗證檔案 metadata 是否與鏈上記錄一致 ⭐',
  inputSchema: z.object({
    filePath: z.string().describe('檔案絕對路徑'),
  }),
  outputSchema: z.object({
    isValid: z.boolean().describe('驗證結果'),
    txHash: z.string().describe('上鏈交易 hash'),
    blockHash: z.string().describe('區塊雜湊'),
  }),
  permissions: ['material.read'],
  timeout: 15_000,
  retryPolicy: { maxAttempts: 2, initialDelayMs: 500, backoffMultiplier: 2, retryOn: ['TOOL_TIMEOUT'] },
  handler: async (input, ctx) => {
    const data = await hibaFetch(ctx, '/api/blockchain/verify', { filePath: input.filePath }) as {
      valid: boolean; txHash: string; blockHash: string;
    };
    return { isValid: data.valid, txHash: data.txHash, blockHash: data.blockHash };
  },
});

defineTool({
  name: 'material.traceLot',
  version: '1.0.0',
  tags: ['material', 'read'],
  description: '批次追蹤：查詢批次從進料到出貨的完整記錄',
  inputSchema: z.object({
    lotId: z.string().describe('批次 ID'),
  }),
  outputSchema: z.object({
    lotId: z.string(),
    records: z.array(z.object({
      timestamp: z.string().describe('ISO 8601'),
      operation: z.string().describe('操作名稱'),
      operatorId: z.string().describe('操作員 ID'),
      location: z.string().describe('作業位置'),
    })).describe('批次追蹤記錄（依時序排列）'),
  }),
  permissions: ['material.read'],
  timeout: 10_000,
  handler: notImplemented,
});

defineTool({
  name: 'material.queryStock',
  version: '1.0.0',
  tags: ['material', 'read'],
  description: '查詢指定料號的即時庫存數量與儲位',
  inputSchema: z.object({
    partNumber: z.string().describe('料號'),
  }),
  outputSchema: z.object({
    partNumber: z.string(),
    quantity: z.number().describe('庫存數量'),
    location: z.string().describe('儲位代號'),
    unit: z.string().describe('計量單位'),
    lastUpdated: z.string().describe('最後更新時間 ISO 8601'),
  }),
  permissions: ['material.read'],
  timeout: 8_000,
  handler: notImplemented,
});

defineTool({
  name: 'material.fetchBom',
  version: '1.0.0',
  tags: ['material', 'read'],
  description: '取得指定產品的 BOM（用料清單）',
  inputSchema: z.object({
    productId: z.string().describe('產品 ID'),
    revision: z.string().optional().describe('BOM 版本，省略時取最新版'),
  }),
  outputSchema: z.object({
    productId: z.string(),
    revision: z.string(),
    items: z.array(z.object({
      partNumber: z.string(),
      quantity: z.number(),
      unit: z.string(),
      description: z.string().optional(),
    })).describe('BOM 項目清單'),
  }),
  permissions: ['material.read'],
  timeout: 10_000,
  handler: notImplemented,
});

defineTool({
  name: 'material.inspectIncoming',
  version: '1.0.0',
  tags: ['material', 'write'],
  description: '記錄進料檢驗結果',
  inputSchema: z.object({
    lotId: z.string().describe('批次 ID'),
    inspectionResult: z.enum(['pass', 'fail', 'conditional']).describe('檢驗結果'),
    notes: z.string().optional().describe('備註說明'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    recordId: z.string().describe('稽核記錄 ID'),
    timestamp: z.string().describe('記錄時間 ISO 8601'),
  }),
  permissions: ['material.write'],
  timeout: 10_000,
  handler: notImplemented,
});

defineTool({
  name: 'material.checkExpiry',
  version: '1.0.0',
  tags: ['material', 'read'],
  description: '查詢批次有效期限與狀態預警',
  inputSchema: z.object({
    lotId: z.string().describe('批次 ID'),
  }),
  outputSchema: z.object({
    lotId: z.string(),
    expiryDate: z.string().describe('到期日 ISO 8601'),
    daysRemaining: z.number().describe('距到期剩餘天數'),
    status: z.enum(['valid', 'expiring_soon', 'expired']).describe('有效期狀態'),
  }),
  permissions: ['material.read'],
  timeout: 8_000,
  handler: notImplemented,
});

// ══════════════════════════════════════════════════════════════════════════════
// 機（Machine）Agent — 5 Tools
// ══════════════════════════════════════════════════════════════════════════════

defineTool({
  name: 'machine.queryStatus',
  version: '1.0.0',
  tags: ['machine', 'read'],
  description: '查詢機台當前運作狀態',
  inputSchema: z.object({
    machineId: z.string().describe('機台 ID'),
  }),
  outputSchema: z.object({
    machineId: z.string(),
    status: z.enum(['running', 'idle', 'alarm', 'maintenance']).describe('運作狀態'),
    lastUpdated: z.string().describe('最後更新時間 ISO 8601'),
  }),
  permissions: ['machine.read'],
  timeout: 8_000,
  handler: notImplemented,
});

defineTool({
  name: 'machine.calculateOee',
  version: '1.0.0',
  tags: ['machine', 'read'],
  description: '計算指定時間區間的 OEE（稼動率 × 效能率 × 良品率）',
  inputSchema: z.object({
    machineId: z.string().describe('機台 ID'),
    timeRange: timeRangeSchema,
  }),
  outputSchema: z.object({
    machineId: z.string(),
    oee: z.number().describe('OEE 綜合效率（0–100）'),
    availability: z.number().describe('稼動率（0–100）'),
    performance: z.number().describe('效能率（0–100）'),
    quality: z.number().describe('良品率（0–100）'),
  }),
  permissions: ['machine.read'],
  timeout: 15_000,
  handler: notImplemented,
});

defineTool({
  name: 'machine.schedulePm',
  version: '1.0.0',
  tags: ['machine', 'write'],
  description: '建立預防保養（PM）工單',
  inputSchema: z.object({
    machineId: z.string().describe('機台 ID'),
    scheduledDate: z.string().describe('預排保養日期 ISO 8601'),
    pmType: z.string().optional().describe('保養類型（省略時套用預設計畫）'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    workOrderId: z.string().describe('PM 工單 ID'),
    scheduledDate: z.string().describe('確認排程日期 ISO 8601'),
  }),
  permissions: ['machine.write'],
  timeout: 10_000,
  handler: notImplemented,
});

defineTool({
  name: 'machine.listAlarms',
  version: '1.0.0',
  tags: ['machine', 'read'],
  description: '查詢指定時間區間內的機台警報記錄',
  inputSchema: z.object({
    machineId: z.string().describe('機台 ID'),
    timeRange: timeRangeSchema,
  }),
  outputSchema: z.object({
    machineId: z.string(),
    alarms: z.array(z.object({
      alarmCode: z.string().describe('警報碼'),
      description: z.string().describe('說明'),
      severity: z.enum(['low', 'medium', 'high', 'critical']).describe('嚴重等級'),
      timestamp: z.string().describe('發生時間 ISO 8601'),
    })).describe('警報清單（依時序降序）'),
    total: z.number().describe('警報總筆數'),
  }),
  permissions: ['machine.read'],
  timeout: 10_000,
  handler: notImplemented,
});

defineTool({
  name: 'machine.checkCalib',
  version: '1.0.0',
  tags: ['machine', 'read'],
  description: '查詢機台校正狀態與下次校正到期日',
  inputSchema: z.object({
    machineId: z.string().describe('機台 ID'),
  }),
  outputSchema: z.object({
    machineId: z.string(),
    lastCalibDate: z.string().describe('最近校正日期 ISO 8601'),
    nextCalibDate: z.string().describe('下次校正期限 ISO 8601'),
    status: z.enum(['valid', 'due_soon', 'overdue']).describe('校正有效狀態'),
  }),
  permissions: ['machine.read'],
  timeout: 8_000,
  handler: notImplemented,
});

// ══════════════════════════════════════════════════════════════════════════════
// 人（Man）Agent — 5 Tools
// ══════════════════════════════════════════════════════════════════════════════

defineTool({
  name: 'man.loginOperator',
  version: '1.0.0',
  tags: ['man', 'write'],
  description: '操作員登入，回傳 session token',
  inputSchema: z.object({
    employeeId: z.string().describe('員工 ID'),
    passwordHash: z.string().describe('密碼 SHA-256 雜湊（hex）'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    sessionToken: z.string().optional().describe('Session token（失敗時省略）'),
    expiresAt: z.string().optional().describe('到期時間 ISO 8601（失敗時省略）'),
  }),
  permissions: ['man.write'],
  timeout: 10_000,
  handler: notImplemented,
});

defineTool({
  name: 'man.queryShift',
  version: '1.0.0',
  tags: ['man', 'read'],
  description: '查詢指定日期的班表與在班人員',
  inputSchema: z.object({
    date: z.string().describe('查詢日期 ISO 8601（YYYY-MM-DD）'),
  }),
  outputSchema: z.object({
    date: z.string(),
    shifts: z.array(z.object({
      shiftId: z.string().describe('班次 ID'),
      name: z.string().describe('班次名稱'),
      startTime: z.string().describe('開始時間 HH:mm'),
      endTime: z.string().describe('結束時間 HH:mm'),
      operators: z.array(z.string()).describe('在班員工 ID 清單'),
    })),
  }),
  permissions: ['man.read'],
  timeout: 8_000,
  handler: notImplemented,
});

defineTool({
  name: 'man.verifyOperatorCert',
  version: '1.0.0',
  tags: ['man', 'read'],
  description: '驗證操作員是否具備指定技能的有效資格證書',
  inputSchema: z.object({
    employeeId: z.string().describe('員工 ID'),
    skillCode: z.string().describe('技能碼'),
  }),
  outputSchema: z.object({
    employeeId: z.string(),
    skillCode: z.string(),
    isValid: z.boolean().describe('證書是否有效'),
    certExpiry: z.string().optional().describe('證書到期日 ISO 8601'),
  }),
  permissions: ['man.read'],
  timeout: 8_000,
  handler: notImplemented,
});

defineTool({
  name: 'man.checkSkill',
  version: '1.0.0',
  tags: ['man', 'read'],
  description: '取得操作員的完整技能清單',
  inputSchema: z.object({
    employeeId: z.string().describe('員工 ID'),
  }),
  outputSchema: z.object({
    employeeId: z.string(),
    skills: z.array(z.object({
      skillCode: z.string(),
      name: z.string().describe('技能名稱'),
      level: z.enum(['trainee', 'qualified', 'expert']).describe('技能等級'),
      certExpiry: z.string().optional().describe('到期日 ISO 8601'),
    })).describe('技能清單'),
  }),
  permissions: ['man.read'],
  timeout: 8_000,
  handler: notImplemented,
});

defineTool({
  name: 'man.sendAlert',
  version: '1.0.0',
  tags: ['man', 'write'],
  description: '發送即時通知給指定操作員',
  inputSchema: z.object({
    employeeId: z.string().describe('員工 ID'),
    message: z.string().describe('通知內容'),
    priority: z.enum(['low', 'normal', 'urgent']).default('normal').describe('優先等級'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    channel: z.string().describe('實際使用的通知管道'),
    deliveredAt: z.string().optional().describe('送達時間 ISO 8601（非同步時可能延遲）'),
  }),
  permissions: ['man.write'],
  timeout: 10_000,
  handler: notImplemented,
});

// ══════════════════════════════════════════════════════════════════════════════
// 法（Method）Agent — 5 Tools
// ══════════════════════════════════════════════════════════════════════════════

defineTool({
  name: 'method.fetchSop',
  version: '1.0.0',
  tags: ['method', 'read'],
  description: '取得指定 SOP 的文件 URL 與版本資訊',
  inputSchema: z.object({
    sopCode: z.string().describe('SOP 編號'),
    language: z.enum(['zh-TW', 'en-US']).default('zh-TW').describe('文件語言'),
  }),
  outputSchema: z.object({
    sopCode: z.string(),
    title: z.string().describe('SOP 標題'),
    version: z.string().describe('文件版本'),
    url: z.string().describe('PDF 文件 URL'),
    effectiveDate: z.string().describe('生效日期 ISO 8601'),
  }),
  permissions: ['method.read'],
  timeout: 8_000,
  handler: notImplemented,
});

defineTool({
  name: 'method.validateParam',
  version: '1.0.0',
  tags: ['method', 'read'],
  description: '驗證製程參數量測值是否在規格範圍內',
  inputSchema: z.object({
    processId: z.string().describe('製程 ID'),
    paramKey: z.string().describe('參數鍵值'),
    value: z.number().describe('量測值'),
  }),
  outputSchema: z.object({
    processId: z.string(),
    paramKey: z.string(),
    value: z.number(),
    isWithinSpec: z.boolean().describe('是否在規格範圍內'),
    lowerLimit: z.number().optional().describe('規格下限'),
    upperLimit: z.number().optional().describe('規格上限'),
  }),
  permissions: ['method.read'],
  timeout: 5_000,
  handler: notImplemented,
});

defineTool({
  name: 'method.queryEcn',
  version: '1.0.0',
  tags: ['method', 'read'],
  description: '查詢指定料號相關的工程變更通知（ECN）清單',
  inputSchema: z.object({
    partNumber: z.string().describe('料號'),
    status: z.enum(['all', 'active', 'draft', 'obsolete']).default('active').describe('ECN 狀態篩選'),
  }),
  outputSchema: z.object({
    partNumber: z.string(),
    ecns: z.array(z.object({
      ecnNumber: z.string().describe('ECN 編號'),
      description: z.string().describe('變更說明'),
      effectiveDate: z.string().describe('生效日期 ISO 8601'),
      status: z.enum(['draft', 'active', 'obsolete']),
    })).describe('ECN 清單'),
    total: z.number(),
  }),
  permissions: ['method.read'],
  timeout: 8_000,
  handler: notImplemented,
});

defineTool({
  name: 'method.recordAudit',
  version: '1.0.0',
  tags: ['method', 'write'],
  description: '記錄品質稽核結果',
  inputSchema: z.object({
    auditType: z.string().describe('稽核類型（e.g. process / supplier / product）'),
    result: z.enum(['pass', 'fail', 'observation']).describe('稽核結果'),
    notes: z.string().optional().describe('備註說明'),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    recordId: z.string().describe('稽核記錄 ID'),
    timestamp: z.string().describe('記錄時間 ISO 8601'),
  }),
  permissions: ['method.write'],
  timeout: 8_000,
  handler: notImplemented,
});

defineTool({
  name: 'method.checkCompliance',
  version: '1.0.0',
  tags: ['method', 'read'],
  description: '查詢產品的 IATF 16949 合規狀態',
  inputSchema: z.object({
    productId: z.string().describe('產品 ID'),
  }),
  outputSchema: z.object({
    productId: z.string(),
    standard: z.literal('IATF-16949'),
    isCompliant: z.boolean(),
    nonConformities: z.array(z.string()).describe('不符合項目列表（合規時為空陣列）'),
    lastAuditDate: z.string().optional().describe('最近稽核日期 ISO 8601'),
  }),
  permissions: ['method.read'],
  timeout: 10_000,
  handler: notImplemented,
});

// ══════════════════════════════════════════════════════════════════════════════
// 環（Environment）Agent — 4 Tools
// ══════════════════════════════════════════════════════════════════════════════

defineTool({
  name: 'env.readTemperature',
  version: '1.0.0',
  tags: ['env', 'read'],
  description: '讀取指定感測器的即時溫度',
  inputSchema: z.object({
    sensorId: z.string().describe('感測器 ID'),
  }),
  outputSchema: z.object({
    sensorId: z.string(),
    temperature: z.number().describe('溫度值（°C）'),
    unit: z.literal('celsius'),
    timestamp: z.string().describe('量測時間 ISO 8601'),
  }),
  permissions: ['env.read'],
  timeout: 5_000,
  handler: notImplemented,
});

defineTool({
  name: 'env.readHumidity',
  version: '1.0.0',
  tags: ['env', 'read'],
  description: '讀取指定感測器的即時相對濕度',
  inputSchema: z.object({
    sensorId: z.string().describe('感測器 ID'),
  }),
  outputSchema: z.object({
    sensorId: z.string(),
    humidity: z.number().describe('相對濕度（%RH）'),
    unit: z.literal('percent_rh'),
    timestamp: z.string().describe('量測時間 ISO 8601'),
  }),
  permissions: ['env.read'],
  timeout: 5_000,
  handler: notImplemented,
});

defineTool({
  name: 'env.checkCleanroom',
  version: '1.0.0',
  tags: ['env', 'read'],
  description: '查詢潔淨室的 ISO 等級與即時粒子計數',
  inputSchema: z.object({
    roomId: z.string().describe('潔淨室 ID'),
  }),
  outputSchema: z.object({
    roomId: z.string(),
    isoClass: z.number().int().min(1).max(9).describe('ISO 14644-1 等級（1–9）'),
    particleCount: z.number().describe('粒子計數（個/m³，≥0.5μm）'),
    status: z.enum(['compliant', 'warning', 'non_compliant']).describe('合規狀態'),
    timestamp: z.string().describe('量測時間 ISO 8601'),
  }),
  permissions: ['env.read'],
  timeout: 8_000,
  handler: notImplemented,
});

defineTool({
  name: 'env.alertThreshold',
  version: '1.0.0',
  tags: ['env', 'write'],
  description: '設定感測器警報閾值',
  inputSchema: z.object({
    sensorId: z.string().describe('感測器 ID'),
    thresholdConfig: z.object({
      min: z.number().optional().describe('下限（超出時觸發警報）'),
      max: z.number().optional().describe('上限（超出時觸發警報）'),
      alertChannel: z.string().optional().describe('警報通知管道'),
    }),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    sensorId: z.string(),
    configuredAt: z.string().describe('設定時間 ISO 8601'),
  }),
  permissions: ['env.write'],
  timeout: 5_000,
  handler: notImplemented,
});

// ══════════════════════════════════════════════════════════════════════════════
// Orchestrator Meta-Tools — 2 Tools
// ══════════════════════════════════════════════════════════════════════════════

defineTool({
  name: 'orchestrator.listAgents',
  version: '1.0.0',
  tags: ['orchestrator', 'read'],
  description: '回傳 TrustRegistry 中已註冊的 Agent 清單與狀態',
  inputSchema: z.object({
    statusFilter: z.enum(['all', 'active', 'suspended']).default('all').describe('狀態篩選'),
  }),
  outputSchema: z.object({
    agents: z.array(z.object({
      agentId: z.string(),
      name: z.string(),
      status: z.enum(['registered', 'active', 'suspended']),
      permissions: z.array(z.string()).describe('持有的權限集合'),
      registeredAt: z.string().describe('註冊時間 ISO 8601'),
    })),
    total: z.number(),
  }),
  permissions: ['orchestrator.read'],
  timeout: 10_000,
  handler: notImplemented,
});

defineTool({
  name: 'orchestrator.getAuditSummary',
  version: '1.0.0',
  tags: ['orchestrator', 'read'],
  description: '取得指定時間區間的 AuditTrail 摘要統計',
  inputSchema: z.object({
    timeRange: timeRangeSchema,
  }),
  outputSchema: z.object({
    timeRange: timeRangeSchema,
    totalExecutions: z.number().describe('總執行次數'),
    successCount: z.number().describe('成功次數'),
    failureCount: z.number().describe('失敗次數'),
    topTools: z.array(z.object({
      toolName: z.string(),
      count: z.number(),
    })).describe('最常用 Tool 排行（Top 10）'),
    anchored: z.number().describe('已上鏈稽核記錄數'),
  }),
  permissions: ['orchestrator.read'],
  timeout: 15_000,
  handler: notImplemented,
});
