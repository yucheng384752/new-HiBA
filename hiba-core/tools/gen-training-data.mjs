#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const PROTOCOL_VERSION = '1.0';
const DEFAULT_OUT_DIR = 'training/data';

const string = { type: 'string' };
const number = { type: 'number' };
const boolean = { type: 'boolean' };
const timeRangeProp = {
  type: 'object',
  properties: { from: string, to: string },
  required: ['from', 'to'],
  additionalProperties: false,
};

function tool(name, description, properties, required = [], action = 'read') {
  const domain = name.split('.')[0];
  return {
    protocolVersion: PROTOCOL_VERSION,
    name,
    version: '1.0.0',
    description,
    tags: [domain, action],
    inputSchema: { type: 'object', properties, required, additionalProperties: false },
    outputSchema: { type: 'object' },
    permissions: action === 'read' ? [] : [`${domain}.${action}`],
    timeoutMs: 10_000,
  };
}

const TOOLS = [
  tool('material.queryStock', '依料號查詢庫存', { partNumber: string }, ['partNumber']),
  tool('machine.queryStatus', '查詢機台狀態', { machineId: string }, ['machineId']),
  tool('machine.executeOrder', '執行生產工單', { orderId: string, quantity: number }, ['orderId'], 'write'),
  tool('env.readSensor', '讀取環境感測器', { sensorId: string }),
  tool('env.alertThreshold', '設定感測器告警門檻', {
    sensorId: string,
    thresholdConfig: {
      type: 'object',
      properties: { min: number, max: number, alertChannel: string },
      additionalProperties: false,
    },
  }, ['sensorId', 'thresholdConfig'], 'write'),
  tool('method.fetchSop', '取得標準作業程序', {
    sopCode: string,
    language: { type: 'string', enum: ['zh-TW', 'en-US'] },
  }, ['sopCode']),
  tool('man.verifyOperatorCert', '驗證操作員技能證照', { employeeId: string, skillCode: string }, ['employeeId', 'skillCode']),
  tool('material.protectFile', '保護檔案並建立稽核紀錄', { filePath: string, keepFile: boolean }, ['filePath'], 'write'),
  tool('material.verifyFile', '驗證檔案完整性', { filePath: string }, ['filePath']),
  tool('orchestrator.echoRtt', '測試節點往返延遲', { message: string, sentAt: string }),
  tool('machine.calculateOee', '計算指定時間區間的 OEE（稼動率 × 效能率 × 良品率）', { machineId: string, timeRange: timeRangeProp }, ['machineId', 'timeRange']),
  tool('machine.listAlarms', '查詢指定時間區間內的機台警報記錄', { machineId: string, timeRange: timeRangeProp }, ['machineId', 'timeRange']),
  tool('orchestrator.getAuditSummary', '取得指定時間區間的 AuditTrail 摘要統計', { timeRange: timeRangeProp }, ['timeRange']),
];

const VALUES = {
  parts: ['P-1001', 'P-2048', 'PCB-A7', 'MAT-88'],
  machines: ['CNC-03', 'LATHE-02', 'PRESS-07', 'AOI-01'],
  orders: ['WO-2026-001', 'WO-2026-107', 'WO-2026-315', 'WO-2026-808'],
  sensors: ['TEMP-A1', 'HUM-B2', 'ENV-C3', 'ROOM-D4'],
  sops: ['SOP-CNC-01', 'SOP-QC-07', 'SOP-PACK-03', 'SOP-SAFE-02'],
  employees: ['E1007', 'E2031', 'E4410', 'E5502'],
  skills: ['CNC-L2', 'QC-AOI', 'FORKLIFT', 'PACK-L1'],
  files: ['/data/report.csv', '/data/batch.json', '/var/lib/hiba/audit.log', '/srv/share/result.pdf'],
  // 皆為指令內文明講的絕對區間，訓練目標是「照抄成 from/to」，不要求模型自行推算「現在」
  timeRanges: [
    { from: '2026-08-20T00:00:00Z', to: '2026-08-21T00:00:00Z' },
    { from: '2026-08-15T08:00:00Z', to: '2026-08-15T20:00:00Z' },
    { from: '2026-07-01T00:00:00Z', to: '2026-07-31T23:59:59Z' },
    { from: '2026-08-22T09:00:00Z', to: '2026-08-23T09:00:00Z' },
  ],
};

const pick = (items, i) => items[i % items.length];
const value = (items, i) => `${pick(items, i)}-${i}`;
const step = (stepId, toolName, input, dependsOn = []) => ({
  stepId, toolName, nodeId: '', version: '1.0.0', input, dependsOn,
});

const SCENARIOS = [
  i => ({
    task: `查詢料號 ${value(VALUES.parts, i)} 的目前庫存`,
    steps: [step('S1', 'material.queryStock', { partNumber: value(VALUES.parts, i) })],
  }),
  i => ({
    task: `確認機台 ${value(VALUES.machines, i)} 現在是否可用`,
    steps: [step('S1', 'machine.queryStatus', { machineId: value(VALUES.machines, i) })],
  }),
  i => ({
    task: `執行工單 ${value(VALUES.orders, i)}，數量 ${10 + (i % 9) * 10}`,
    steps: [step('S1', 'machine.executeOrder', { orderId: value(VALUES.orders, i), quantity: 10 + (i % 9) * 10 })],
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
      step('S2', 'machine.executeOrder', { orderId: value(VALUES.orders, i) }, ['S1']),
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
    task: `對新節點送出 ${value(['hello', 'health-check', 'pairing-test', 'ready'], i)} 以測試往返延遲`,
    steps: [step('S1', 'orchestrator.echoRtt', { message: value(['hello', 'health-check', 'pairing-test', 'ready'], i) })],
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
      step('S2', 'machine.executeOrder', { orderId: value(VALUES.orders, i) }, ['S1']),
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

function resource(toolName) {
  return { name: toolName, version: '1.0.0', type: 'tool' };
}

function buildRow(index) {
  const scenario = SCENARIOS[index % SCENARIOS.length](index);
  const suffix = String(index).padStart(5, '0');
  const vmId = `vm-ubuntu-${suffix}`;
  const piId = `raspberry-pi4-${suffix}`;
  const installerId = `new-node-${suffix}`;
  const selectedTools = [...new Set(scenario.steps.map(item => item.toolName))];
  const installCase = index % 6 === 5;

  for (let i = 0; i < scenario.steps.length; i += 1) {
    scenario.steps[i].nodeId = installCase ? installerId : (i % 2 === 0 ? vmId : piId);
  }

  const vmResources = installCase ? [] : selectedTools.filter((_, i) => i % 2 === 0).map(resource);
  const piResources = installCase ? [] : selectedTools.filter((_, i) => i % 2 === 1).map(resource);
  const offlineResources = selectedTools.map(resource);
  const nodes = [
    { protocolVersion: PROTOCOL_VERSION, nodeId: `offline-${suffix}`, agentUrl: null, status: 'offline', canInstall: false, resources: offlineResources, registeredAt: null, lastSeenAt: null },
    { protocolVersion: PROTOCOL_VERSION, nodeId: vmId, agentUrl: `http://${vmId}:3000`, status: 'online', canInstall: false, resources: vmResources, registeredAt: null, lastSeenAt: null },
    { protocolVersion: PROTOCOL_VERSION, nodeId: piId, agentUrl: `http://${piId}:3000`, status: 'online', canInstall: false, resources: piResources, registeredAt: null, lastSeenAt: null },
    { protocolVersion: PROTOCOL_VERSION, nodeId: installerId, agentUrl: `http://${installerId}:3000`, status: 'online', canInstall: true, resources: [], registeredAt: null, lastSeenAt: null },
  ];
  const resources = Object.fromEntries(nodes.map(node => [node.nodeId, node.resources]));
  const context = { protocolVersion: PROTOCOL_VERSION, resources, nodes, tools: TOOLS };
  const plan = { protocolVersion: PROTOCOL_VERSION, steps: scenario.steps, supervisorPolicy: 'fail-fast' };

  return { instruction: scenario.task, input: JSON.stringify(context), output: JSON.stringify(plan) };
}

function parseArgs(argv) {
  const args = { outDir: DEFAULT_OUT_DIR, train: 256, eval: 64 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out-dir') args.outDir = argv[++i];
    else if (argv[i] === '--train') args.train = Number(argv[++i]);
    else if (argv[i] === '--eval') args.eval = Number(argv[++i]);
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (!Number.isInteger(args.train) || args.train < 1 || !Number.isInteger(args.eval) || args.eval < 1) {
    throw new Error('--train and --eval must be positive integers');
  }
  return args;
}

function writeJsonl(filePath, count, offset) {
  const rows = Array.from({ length: count }, (_, i) => JSON.stringify(buildRow(i + offset)));
  fs.writeFileSync(filePath, `${rows.join('\n')}\n`, 'utf8');
}

const args = parseArgs(process.argv.slice(2));
const outDir = path.resolve(process.cwd(), args.outDir);
fs.mkdirSync(outDir, { recursive: true });
writeJsonl(path.join(outDir, 'hiba-v1-train.jsonl'), args.train, 0);
writeJsonl(path.join(outDir, 'hiba-v1-eval.jsonl'), args.eval, 10_000);
console.log(`[gen] wrote ${args.train} train and ${args.eval} eval rows to ${outDir}`);
