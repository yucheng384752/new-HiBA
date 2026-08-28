#!/usr/bin/env node
// 執行方式（見 package.json "dataset:v1"）：
//   node --require ts-node/register tools/gen-training-data.ts [--train N] [--eval N] [--out-dir DIR]

import fs from 'node:fs';
import path from 'node:path';
import { toToolSpec } from '../packages/hiba-agent/src/core/defineTool';
import { allHibaTools } from '../packages/hiba-agent/src/tools/hiba.tools';

const PROTOCOL_VERSION = '1.0';
const DEFAULT_OUT_DIR = 'training/data';

type JsonSchema = Record<string, unknown>;

type ToolSpecLike = {
  protocolVersion: string;
  name: string;
  version: string;
  description: string;
  tags: string[];
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  permissions: string[];
  timeoutMs: number;
  retryPolicy?: unknown;
};

type PlanStep = {
  stepId: string;
  toolName: string;
  nodeId: string;
  version: string;
  input: Record<string, unknown>;
  dependsOn: string[];
};

type ScenarioResult = { task: string; steps: PlanStep[] };

type NodeEntry = {
  protocolVersion: string;
  nodeId: string;
  agentUrl: string | null;
  status: 'online' | 'offline';
  canInstall: boolean;
  resources: { name: string; version: string; type: 'tool' }[];
  registeredAt: null;
  lastSeenAt: null;
};

type TrainingRow = { instruction: string; input: string; output: string };

const timeRangeProp: JsonSchema = {
  type: 'object',
  properties: { from: { type: 'string' }, to: { type: 'string' } },
  required: ['from', 'to'],
  additionalProperties: false,
};

// 3 個 orchestrator audit 工具（verifyAuditIntegrity / getAuditSummary / anchorAuditBatch）
// 定義在 packages/hiba-agent/src/tools/audit.tools.ts 的 registerAuditTools() 內，該函式
// 需要注入真實 AuditTrail 實例才能建構 defineTool()，無法像其餘 33 個工具一樣直接用
// toToolSpec(allHibaTools) 動態取得，故在此手動維護一份對應的 ToolSpec。
// 異動 audit.tools.ts 的 inputSchema 時務必同步更新這裡。
const DEFAULT_RETRY_POLICY = { maxAttempts: 3, initialDelayMs: 500, backoffMultiplier: 2, retryOn: ['TOOL_TIMEOUT'] };

const AUDIT_TOOL_SPECS: ToolSpecLike[] = [
  {
    protocolVersion: PROTOCOL_VERSION,
    name: 'orchestrator.verifyAuditIntegrity',
    version: '1.0.0',
    description: '重算 auditHash 比對 DB 儲存值，偵測稽核記錄遭竄改',
    tags: ['orchestrator', 'read'],
    inputSchema: {
      type: 'object',
      properties: { traceId: { type: 'string', description: '指定過濾的 traceId，省略時驗證全部記錄' } },
      required: [],
      additionalProperties: false,
    },
    outputSchema: { type: 'object' },
    permissions: [],
    timeoutMs: 30_000,
    retryPolicy: DEFAULT_RETRY_POLICY,
  },
  {
    protocolVersion: PROTOCOL_VERSION,
    name: 'orchestrator.getAuditSummary',
    version: '1.0.0',
    description: '取得指定時間區間的 AuditTrail 摘要統計',
    tags: ['orchestrator', 'read'],
    inputSchema: {
      type: 'object',
      properties: { timeRange: timeRangeProp },
      required: ['timeRange'],
      additionalProperties: false,
    },
    outputSchema: { type: 'object' },
    permissions: [],
    timeoutMs: 15_000,
    retryPolicy: DEFAULT_RETRY_POLICY,
  },
  {
    protocolVersion: PROTOCOL_VERSION,
    name: 'orchestrator.anchorAuditBatch',
    version: '1.0.0',
    description: 'Anchor unanchored audit records through POST /api/audit/anchor and persist the returned txHash.',
    tags: ['orchestrator', 'write'],
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: '單次 anchor 上限（1-1000，預設 100）' } },
      required: [],
      additionalProperties: false,
    },
    outputSchema: { type: 'object' },
    permissions: ['orchestrator.write'],
    timeoutMs: 30_000,
    retryPolicy: DEFAULT_RETRY_POLICY,
  },
];

// 訓練資料的工具目錄與正式 runtime 保持單一事實來源：33 個一般工具直接從
// packages/hiba-agent/src/tools/hiba.tools.ts 的 allHibaTools 動態轉換
// （toToolSpec，與 tools/sync-tool-manifest.ts 相同手法），加上上面 3 個手動維護的
// audit 工具，合計 36 個，不再手刻一份會隨 runtime 演進而漂移的精簡清單
// （舊版僅手刻 13 個，且 machine.executeOrder 的 input 早已跟真實 schema 不一致，
// 見下方 SCENARIOS 的修正）。
const TOOLS: ToolSpecLike[] = [...allHibaTools.map(toToolSpec), ...AUDIT_TOOL_SPECS];

const VALUES = {
  parts: ['P-1001', 'P-2048', 'PCB-A7', 'MAT-88'],
  machines: ['CNC-03', 'LATHE-02', 'PRESS-07', 'AOI-01'],
  orders: ['WO-2026-001', 'WO-2026-107', 'WO-2026-315', 'WO-2026-808'],
  sensors: ['TEMP-A1', 'HUM-B2', 'ENV-C3', 'ROOM-D4'],
  sops: ['SOP-CNC-01', 'SOP-QC-07', 'SOP-PACK-03', 'SOP-SAFE-02'],
  employees: ['E1007', 'E2031', 'E4410', 'E5502'],
  skills: ['CNC-L2', 'QC-AOI', 'FORKLIFT', 'PACK-L1'],
  files: ['/data/report.csv', '/data/batch.json', '/var/lib/hiba/audit.log', '/srv/share/result.pdf'],
  rttMessages: ['hello', 'health-check', 'pairing-test', 'ready'],
  // 皆為指令內文明講的絕對區間，訓練目標是「照抄成 from/to」，不要求模型自行推算「現在」
  timeRanges: [
    { from: '2026-08-20T00:00:00Z', to: '2026-08-21T00:00:00Z' },
    { from: '2026-08-15T08:00:00Z', to: '2026-08-15T20:00:00Z' },
    { from: '2026-07-01T00:00:00Z', to: '2026-07-31T23:59:59Z' },
    { from: '2026-08-22T09:00:00Z', to: '2026-08-23T09:00:00Z' },
  ],
};

function pick<T>(items: T[], i: number): T {
  return items[i % items.length]!;
}
function value(items: string[], i: number): string {
  return `${pick(items, i)}-${i}`;
}
function step(stepId: string, toolName: string, input: Record<string, unknown>, dependsOn: string[] = []): PlanStep {
  return { stepId, toolName, nodeId: '', version: '1.0.0', input, dependsOn };
}
function resource(toolName: string) {
  return { name: toolName, version: '1.0.0', type: 'tool' as const };
}

const SCENARIOS: Array<(i: number) => ScenarioResult> = [
  i => ({
    task: `查詢料號 ${value(VALUES.parts, i)} 的目前庫存`,
    steps: [step('S1', 'material.queryStock', { partNumber: value(VALUES.parts, i) })],
  }),
  i => ({
    task: `確認機台 ${value(VALUES.machines, i)} 現在是否可用`,
    steps: [step('S1', 'machine.queryStatus', { machineId: value(VALUES.machines, i) })],
  }),
  i => ({
    // machineId 為必填欄位（見 machine.executeOrder 真實 inputSchema），舊版遺漏此欄位
    task: `在機台 ${value(VALUES.machines, i)} 執行工單 ${value(VALUES.orders, i)}，數量 ${10 + (i % 9) * 10}`,
    steps: [step('S1', 'machine.executeOrder', {
      machineId: value(VALUES.machines, i), orderId: value(VALUES.orders, i), quantity: 10 + (i % 9) * 10,
    })],
  }),
  i => ({
    task: `讀取感測器 ${value(VALUES.sensors, i)} 的最新資料`,
    steps: [step('S1', 'env.readSensor', { sensorId: value(VALUES.sensors, i) })],
  }),
  i => ({
    task: `取得 ${value(VALUES.sops, i)} 的${i % 2 ? '英文' : '繁體中文'}版本`,
    steps: [step('S1', 'method.fetchSop', {
      sopCode: value(VALUES.sops, i), language: i % 2 ? 'en-US' : 'zh-TW',
    })],
  }),
  i => ({
    task: `驗證員工 ${value(VALUES.employees, i)} 是否具備 ${value(VALUES.skills, i)} 證照`,
    steps: [step('S1', 'man.verifyOperatorCert', {
      employeeId: value(VALUES.employees, i), skillCode: value(VALUES.skills, i),
    })],
  }),
  i => ({
    task: `先保護檔案 ${value(VALUES.files, i)}，完成後再驗證完整性`,
    steps: [
      step('S1', 'material.protectFile', { filePath: value(VALUES.files, i), keepFile: true }),
      step('S2', 'material.verifyFile', { filePath: value(VALUES.files, i) }, ['S1']),
    ],
  }),
  i => ({
    task: `先查詢機台 ${value(VALUES.machines, i)} 狀態，確認後執行工單 ${value(VALUES.orders, i)}`,
    steps: [
      step('S1', 'machine.queryStatus', { machineId: value(VALUES.machines, i) }),
      step('S2', 'machine.executeOrder', {
        machineId: value(VALUES.machines, i), orderId: value(VALUES.orders, i),
      }, ['S1']),
    ],
  }),
  i => ({
    task: `讀取感測器 ${value(VALUES.sensors, i)}，再設定最高門檻 ${25 + (i % 8)} 度並通知 ops`,
    steps: [
      step('S1', 'env.readSensor', { sensorId: value(VALUES.sensors, i) }),
      step('S2', 'env.alertThreshold', {
        sensorId: value(VALUES.sensors, i),
        thresholdConfig: { max: 25 + (i % 8), alertChannel: 'ops' },
      }, ['S1']),
    ],
  }),
  i => ({
    task: `對新節點送出 ${pick(VALUES.rttMessages, i)} 以測試往返延遲`,
    steps: [step('S1', 'orchestrator.echoRtt', { message: pick(VALUES.rttMessages, i) })],
  }),
  // 結構化輸入（timeRange）：指令內文明講絕對時間，訓練 from/to 欄位名稱與 ISO 8601 格式
  i => ({
    task: `計算機台 ${value(VALUES.machines, i)} 從 ${pick(VALUES.timeRanges, i).from} 到 ${pick(VALUES.timeRanges, i).to} 的 OEE`,
    steps: [step('S1', 'machine.calculateOee', { machineId: value(VALUES.machines, i), timeRange: pick(VALUES.timeRanges, i) })],
  }),
  i => ({
    task: `查詢機台 ${value(VALUES.machines, i)} 從 ${pick(VALUES.timeRanges, i).from} 到 ${pick(VALUES.timeRanges, i).to} 的警報記錄`,
    steps: [step('S1', 'machine.listAlarms', { machineId: value(VALUES.machines, i), timeRange: pick(VALUES.timeRanges, i) })],
  }),
  i => ({
    task: `取得從 ${pick(VALUES.timeRanges, i).from} 到 ${pick(VALUES.timeRanges, i).to} 的稽核執行摘要`,
    steps: [step('S1', 'orchestrator.getAuditSummary', { timeRange: pick(VALUES.timeRanges, i) })],
  }),
  // 複合任務：3 步以上依賴鏈，其一併用 timeRange 讓兩種訓練目標疊加
  i => ({
    task: `先查詢機台 ${value(VALUES.machines, i)} 狀態，確認可用後執行工單 ${value(VALUES.orders, i)}，完成後計算該機台從 ${pick(VALUES.timeRanges, i).from} 到 ${pick(VALUES.timeRanges, i).to} 的 OEE`,
    steps: [
      step('S1', 'machine.queryStatus', { machineId: value(VALUES.machines, i) }),
      step('S2', 'machine.executeOrder', {
        machineId: value(VALUES.machines, i), orderId: value(VALUES.orders, i),
      }, ['S1']),
      step('S3', 'machine.calculateOee', { machineId: value(VALUES.machines, i), timeRange: pick(VALUES.timeRanges, i) }, ['S2']),
    ],
  }),
  i => ({
    task: `讀取感測器 ${value(VALUES.sensors, i)}，設定最高門檻 ${25 + (i % 8)} 度並通知 ops，再取得從 ${pick(VALUES.timeRanges, i).from} 到 ${pick(VALUES.timeRanges, i).to} 的稽核執行摘要`,
    steps: [
      step('S1', 'env.readSensor', { sensorId: value(VALUES.sensors, i) }),
      step('S2', 'env.alertThreshold', {
        sensorId: value(VALUES.sensors, i),
        thresholdConfig: { max: 25 + (i % 8), alertChannel: 'ops' },
      }, ['S1']),
      step('S3', 'orchestrator.getAuditSummary', { timeRange: pick(VALUES.timeRanges, i) }, ['S2']),
    ],
  }),
];

// 只有單步驟情境（steps.length === 1）適合被 delegate pattern 重用：委派時只需要換
// 掉唯一一步的 nodeId，不必處理依賴鏈上下游該落在哪個節點。
const SINGLE_STEP_INDICES = [0, 1, 2, 3, 4, 5, 9, 10, 11, 12];

function resourcesByNode(nodes: NodeEntry[]): Record<string, NodeEntry['resources']> {
  return Object.fromEntries(nodes.map(n => [n.nodeId, n.resources]));
}

// ── 資源缺失決策 pattern：delegate / partial / reject ───────────────────────
// install pattern（先安裝再執行）暫緩：對應的 orchestrator.installTool 尚未實作於
// hiba.tools.ts，訓練資料若引用一個不存在的工具名稱會違反 Data-First（見任務討論）。
// 三種 pattern 都刻意讓指令文字不點名節點（沿用其餘情境的風格），因為要訓練的是
// 「依可用性自動決策」而非「照指令指定的節點執行」。

function buildDelegateRow(index: number): TrainingRow {
  const scenarioIdx = SINGLE_STEP_INDICES[index % SINGLE_STEP_INDICES.length]!;
  const base = SCENARIOS[scenarioIdx]!(index);
  const toolName = base.steps[0]!.toolName;
  const suffix = String(index).padStart(5, '0');
  const offlineId = `vm-ubuntu-${suffix}`;
  const backupId = `raspberry-pi4-${suffix}`;
  const resourceEntry = resource(toolName);
  const nodes: NodeEntry[] = [
    { protocolVersion: PROTOCOL_VERSION, nodeId: offlineId, agentUrl: null, status: 'offline', canInstall: false, resources: [resourceEntry], registeredAt: null, lastSeenAt: null },
    { protocolVersion: PROTOCOL_VERSION, nodeId: backupId, agentUrl: `http://${backupId}:3000`, status: 'online', canInstall: false, resources: [resourceEntry], registeredAt: null, lastSeenAt: null },
  ];
  const context = { protocolVersion: PROTOCOL_VERSION, resources: resourcesByNode(nodes), nodes, tools: TOOLS };
  const plan = {
    protocolVersion: PROTOCOL_VERSION,
    steps: [{ ...base.steps[0]!, nodeId: backupId }],
    supervisorPolicy: 'fail-fast',
  };
  return { instruction: base.task, input: JSON.stringify(context), output: JSON.stringify(plan) };
}

function buildPartialRow(index: number): TrainingRow {
  const suffix = String(index).padStart(5, '0');
  const targets = [0, 1, 2].map(k => value(VALUES.machines, index + k));
  const nodeIds = targets.map((_, k) => `pi-node-${suffix}-${k}`);
  const offlineSlot = index % 3;
  const resourceEntry = resource('machine.queryStatus');
  const nodes: NodeEntry[] = nodeIds.map((id, k) => ({
    protocolVersion: PROTOCOL_VERSION,
    nodeId: id,
    agentUrl: k === offlineSlot ? null : `http://${id}:3000`,
    status: k === offlineSlot ? 'offline' : 'online',
    canInstall: false,
    resources: k === offlineSlot ? [] : [resourceEntry],
    registeredAt: null,
    lastSeenAt: null,
  }));
  const onlineEntries = nodeIds
    .map((id, k) => ({ id, k, target: targets[k]! }))
    .filter(entry => entry.k !== offlineSlot);
  const steps: PlanStep[] = onlineEntries.map((entry, i) => ({
    ...step(`S${i + 1}`, 'machine.queryStatus', { machineId: entry.target }),
    nodeId: entry.id,
  }));
  const context = { protocolVersion: PROTOCOL_VERSION, resources: resourcesByNode(nodes), nodes, tools: TOOLS };
  const plan = { protocolVersion: PROTOCOL_VERSION, steps, supervisorPolicy: 'partial-success' };
  const instruction = `查詢 ${targets.join('、')} 三個機台狀態，能查多少算多少`;
  return { instruction, input: JSON.stringify(context), output: JSON.stringify(plan) };
}

function buildRejectRow(index: number): TrainingRow {
  const suffix = String(index).padStart(5, '0');
  const nodeId = `vm-ubuntu-${suffix}`;
  const restrictedTool = 'machine.executeOrder';
  // 模擬 ScopedToolbox 權限限制（呼應 S18）：呼叫方的可用工具目錄裡完全沒有這個
  // 工具，跟「工具存在但目標節點離線／未安裝」是不同的失敗模式。
  const scopedTools = TOOLS.filter(t => t.name !== restrictedTool);
  const nodes: NodeEntry[] = [{
    protocolVersion: PROTOCOL_VERSION,
    nodeId,
    agentUrl: `http://${nodeId}:3000`,
    status: 'online',
    canInstall: false,
    resources: scopedTools.filter(t => t.name.startsWith('machine.')).map(t => resource(t.name)),
    registeredAt: null,
    lastSeenAt: null,
  }];
  const context = { protocolVersion: PROTOCOL_VERSION, resources: resourcesByNode(nodes), nodes, tools: scopedTools };
  const plan = {
    protocolVersion: PROTOCOL_VERSION,
    steps: [] as PlanStep[],
    supervisorPolicy: 'fail-fast',
    error: `TOOL_NOT_FOUND: 目前可用工具目錄不包含 ${restrictedTool}，無法執行此任務`,
  };
  const instruction = `執行工單 ${value(VALUES.orders, index)}，數量 ${10 + (index % 9) * 10}`;
  return { instruction, input: JSON.stringify(context), output: JSON.stringify(plan) };
}

const DECISION_BUILDERS: Array<(index: number) => TrainingRow> = [buildDelegateRow, buildPartialRow, buildRejectRow];

function buildRow(index: number): TrainingRow {
  const totalSlots = SCENARIOS.length + DECISION_BUILDERS.length;
  const slot = index % totalSlots;
  if (slot >= SCENARIOS.length) {
    return DECISION_BUILDERS[slot - SCENARIOS.length]!(index);
  }

  const scenario = SCENARIOS[slot]!(index);
  const suffix = String(index).padStart(5, '0');
  const vmId = `vm-ubuntu-${suffix}`;
  const piId = `raspberry-pi4-${suffix}`;
  const installerId = `new-node-${suffix}`;
  const selectedTools = [...new Set(scenario.steps.map(item => item.toolName))];
  const installCase = index % 6 === 5;

  for (let i = 0; i < scenario.steps.length; i += 1) {
    scenario.steps[i]!.nodeId = installCase ? installerId : (i % 2 === 0 ? vmId : piId);
  }

  const vmResources = installCase ? [] : selectedTools.filter((_, i) => i % 2 === 0).map(resource);
  const piResources = installCase ? [] : selectedTools.filter((_, i) => i % 2 === 1).map(resource);
  const offlineResources = selectedTools.map(resource);
  const nodes: NodeEntry[] = [
    { protocolVersion: PROTOCOL_VERSION, nodeId: `offline-${suffix}`, agentUrl: null, status: 'offline', canInstall: false, resources: offlineResources, registeredAt: null, lastSeenAt: null },
    { protocolVersion: PROTOCOL_VERSION, nodeId: vmId, agentUrl: `http://${vmId}:3000`, status: 'online', canInstall: false, resources: vmResources, registeredAt: null, lastSeenAt: null },
    { protocolVersion: PROTOCOL_VERSION, nodeId: piId, agentUrl: `http://${piId}:3000`, status: 'online', canInstall: false, resources: piResources, registeredAt: null, lastSeenAt: null },
    { protocolVersion: PROTOCOL_VERSION, nodeId: installerId, agentUrl: `http://${installerId}:3000`, status: 'online', canInstall: true, resources: [], registeredAt: null, lastSeenAt: null },
  ];
  const context = { protocolVersion: PROTOCOL_VERSION, resources: resourcesByNode(nodes), nodes, tools: TOOLS };
  const plan = { protocolVersion: PROTOCOL_VERSION, steps: scenario.steps, supervisorPolicy: 'fail-fast' };

  return { instruction: scenario.task, input: JSON.stringify(context), output: JSON.stringify(plan) };
}

type Args = { outDir: string; train: number; eval: number };

function parseArgs(argv: string[]): Args {
  const args: Args = { outDir: DEFAULT_OUT_DIR, train: 256, eval: 64 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out-dir') args.outDir = argv[++i]!;
    else if (argv[i] === '--train') args.train = Number(argv[++i]);
    else if (argv[i] === '--eval') args.eval = Number(argv[++i]);
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (!Number.isInteger(args.train) || args.train < 1 || !Number.isInteger(args.eval) || args.eval < 1) {
    throw new Error('--train and --eval must be positive integers');
  }
  return args;
}

function writeJsonl(filePath: string, count: number, offset: number): void {
  const rows = Array.from({ length: count }, (_, i) => JSON.stringify(buildRow(i + offset)));
  fs.writeFileSync(filePath, `${rows.join('\n')}\n`, 'utf8');
}

const args = parseArgs(process.argv.slice(2));
const outDir = path.resolve(process.cwd(), args.outDir);
fs.mkdirSync(outDir, { recursive: true });
writeJsonl(path.join(outDir, 'hiba-v1-train.jsonl'), args.train, 0);
writeJsonl(path.join(outDir, 'hiba-v1-eval.jsonl'), args.eval, 10_000);
console.log(`[gen] wrote ${args.train} train and ${args.eval} eval rows to ${outDir} (tool catalog: ${TOOLS.length})`);
