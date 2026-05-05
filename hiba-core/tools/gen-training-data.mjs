#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const ACCOUNTING_URL = process.env.ACCOUNTING_URL || 'http://localhost:9090';
const ANTHROPIC_MODEL = 'claude-sonnet-4-6';
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const SYSTEM_PROMPT = '你是 HiBA 工作流程規劃師，根據節點資源清單將使用者的繁體中文任務拆解成 ExecutionPlan JSON。只回傳純 JSON，不加任何說明。';

const MATERIALS = [
  '鋁合金板',
  '不鏽鋼管',
  '碳纖維片',
  '銅線',
  'ABS 外殼',
  '玻璃基板',
  '矽晶圓',
  'PCB 板',
  '鈦合金零件',
  '壓克力面板',
  '陶瓷片',
  '橡膠墊片',
];

const SOURCES = [
  '倉庫 A',
  '節點入口',
  'QC 暫存區',
  '產線 1',
  '冷藏區',
  'raw-bucket',
  'sensor-stream',
  'batch-queue',
];

const TARGETS = [
  '倉庫 B',
  '出貨區',
  'QC 報告區',
  '產線 2',
  'archive-bucket',
  'dashboard',
  'report-service',
  'manual-review',
];

const FORMATS = ['JSON', 'CSV', 'XLSX', 'PDF', 'Parquet', 'Markdown', 'HTML', 'SQLite'];
const THRESHOLDS = ['0.75', '0.8', '0.85', '0.9', '95', '100', '120', '150'];
const WEIGHTS = ['1kg', '2.5kg', '5kg', '8kg', '10kg', '15kg', '20kg', '25kg'];
const QUANTITIES = ['10', '20', '30', '50', '80', '100', '150', '200'];

const TASK_TEMPLATES = [
  '請在 {nodeId} 使用 {script} 處理 {quantity} 件 {material}，重量上限 {weight}，結果輸出成 {format}。',
  '從 {source} 讀取 {material} 批次資料，交給 {nodeId} 的 {script} 清理後送到 {target}。',
  '幫我把 {source} 的檢測紀錄轉成 {format}，只保留信心值高於 {threshold} 的 {material} 項目。',
  '請安排 {nodeId} 執行 {script}，分析 {quantity} 筆 {material} 數據並產生 {format} 報告。',
  '把 {material} 從 {source} 搬移到 {target}，每批不可超過 {weight}，需要使用 {script}。',
  '針對 {material} 做品質檢查，門檻設為 {threshold}，由 {nodeId} 產出 {format} 摘要。',
  '請用 {script} 將 {source} 的即時資料彙整到 {target}，格式為 {format}。',
  '安排節點 {nodeId} 對 {quantity} 個 {material} 樣本進行分類，低於 {threshold} 的送人工複核。',
  '請把 {material} 的批次追蹤資料從 {source} 匯入 {target}，並轉為 {format}。',
  '用 {nodeId} 的 {script} 先驗證 {material} 重量是否小於 {weight}，再輸出 {format}。',
  '請規劃流程，將 {source} 中 {quantity} 筆 {material} 記錄去重、排序，最後送到 {target}。',
  '幫我產生 {material} 的每日產線報表，來源是 {source}，輸出格式要是 {format}。',
  '請讓 {nodeId} 執行 {script}，把異常分數超過 {threshold} 的項目標記後送 {target}。',
  '需要把 {quantity} 件 {material} 依重量 {weight} 分批，並產生 {format} 作業清單。',
  '請從 {source} 擷取 {material} 狀態，透過 {script} 轉換欄位名稱後寫入 {target}。',
  '安排 {nodeId} 檢查 {material} 的版本一致性，門檻 {threshold}，輸出 {format}。',
  '請將 {source} 的 {format} 檔案解析後，找出 {material} 相關資料並送到 {target}。',
  '用可用工具把 {material} 的庫存從 {source} 同步到 {target}，同步數量 {quantity}。',
  '請建立 {material} 的抽樣任務，抽樣數 {quantity}，由 {nodeId} 回傳 {format} 結果。',
  '針對 {source} 的資料流，使用 {script} 監控 {material} 門檻 {threshold} 並通知 {target}。',
  '請把 {material} 的測試結果合併成 {format}，來源 {source}，目的地 {target}。',
  '讓 {nodeId} 先執行 {script} 清洗資料，再依 {threshold} 過濾 {material} 異常值。',
  '請將 {quantity} 筆 {material} 任務排入 {nodeId}，每件預估重量 {weight}。',
  '從 {source} 匯入 {material} 清單，轉成 {format} 後用 {script} 發佈到 {target}。',
  '請規劃 {material} 的生產前檢查流程，檢查數量 {quantity}，合格門檻 {threshold}。',
  '使用 {nodeId} 的資源處理 {source} 到 {target} 的 {material} 轉運，產出 {format} 憑證。',
  '請用 {script} 比對 {material} 的新舊資料，差異超過 {threshold} 時輸出 {format}。',
  '安排流程將 {source} 的 {material} 批號標準化，數量 {quantity}，再寫到 {target}。',
  '請在 {nodeId} 上把 {material} 測量值轉換為 {format}，忽略低於 {threshold} 的紀錄。',
  '幫我把 {quantity} 個 {material} 工單分派到可用節點，最後彙整到 {target}。',
  '請取得 {source} 的 {material} 影像索引，使用 {script} 萃取特徵並輸出 {format}。',
  '將 {material} 的品檢資料以 {format} 封存，來源 {source}，封存目的地 {target}。',
  '請檢查 {material} 是否符合重量 {weight} 與門檻 {threshold}，結果送到 {target}。',
  '用 {nodeId} 處理 {source} 的 {quantity} 筆紀錄，找出 {material} 風險項目並輸出 {format}。',
  '請將 {material} 的服務紀錄從 {source} 轉送至 {target}，若分數低於 {threshold} 要標記。',
  '建立 {material} 的 ETL 流程：讀取 {source}、執行 {script}、輸出 {format} 到 {target}。',
  '請使用可用節點完成 {quantity} 件 {material} 的資料驗證，錯誤報告格式為 {format}。',
  '將 {source} 裡 {material} 的欄位補齊，使用 {script}，完成後推送到 {target}。',
  '請把 {material} 的事件資料依 {threshold} 分級，並輸出 {format} 給 {target}。',
  '安排 {nodeId} 對 {material} 做批次壓縮，來源 {source}，目標 {target}，格式 {format}。',
];

async function loadZod() {
  try {
    return await import('zod');
  } catch {
    try {
      return await import('https://esm.sh/zod');
    } catch {
      return null;
    }
  }
}

function createPlanValidator(zodModule) {
  const z = zodModule?.z || zodModule?.default || zodModule;
  if (z?.object && z?.array && z?.record && z?.unknown && z?.enum && z?.string) {
    const stepSchema = z.object({
      nodeId: z.string(),
      tool: z.string(),
      script: z.string(),
      args: z.record(z.string(), z.unknown()),
    });
    const planSchema = z.object({
      steps: z.array(stepSchema),
      supervisorPolicy: z.enum(['fail-fast', 'partial-success']),
    });
    return (value) => {
      const result = planSchema.safeParse(value);
      return { success: result.success, error: result.error };
    };
  }

  return (value) => {
    const issues = [];
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      issues.push('plan must be an object');
    } else {
      if (!Array.isArray(value.steps)) {
        issues.push('steps must be an array');
      } else {
        value.steps.forEach((step, index) => {
          if (!step || typeof step !== 'object' || Array.isArray(step)) {
            issues.push(`steps[${index}] must be an object`);
            return;
          }
          for (const key of ['nodeId', 'tool', 'script']) {
            if (typeof step[key] !== 'string') issues.push(`steps[${index}] missing ${key}`);
          }
          if (!step.args || typeof step.args !== 'object' || Array.isArray(step.args)) {
            issues.push(`steps[${index}] args must be an object`);
          }
        });
      }
      if (!['fail-fast', 'partial-success'].includes(value.supervisorPolicy)) {
        issues.push('missing supervisorPolicy');
      }
    }
    return { success: issues.length === 0, error: issues };
  };
}

function parseArgs(argv) {
  const args = { out: null, count: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out') {
      args.out = argv[++i];
    } else if (arg === '--count') {
      args.count = Number.parseInt(argv[++i], 10);
    } else if (arg === '--esm') {
      continue;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!args.out) throw new Error('Missing required argument: --out');
  if (!Number.isInteger(args.count) || args.count <= 0) throw new Error('Missing or invalid required argument: --count');
  return args;
}

function randomItem(items) {
  return items[Math.floor(Math.random() * items.length)];
}

function flattenResources(resources) {
  return Object.entries(resources).flatMap(([nodeId, items]) => {
    if (!Array.isArray(items)) return [];
    return items
      .filter((item) => item && typeof item.name === 'string' && typeof item.version === 'string' && ['tool', 'script', 'service'].includes(item.type))
      .map((item) => ({ nodeId, ...item }));
  });
}

function chooseResource(resources) {
  const flat = flattenResources(resources);
  if (flat.length === 0) {
    const nodeIds = Object.keys(resources);
    if (nodeIds.length > 0) {
      return { nodeId: randomItem(nodeIds), name: 'default-tool', version: '0.0.0', type: 'tool' };
    }
    return { nodeId: 'node-0', name: 'default-tool', version: '0.0.0', type: 'tool' };
  }
  return randomItem(flat);
}

function buildInstruction(resources) {
  const resource = chooseResource(resources);
  const variables = {
    material: randomItem(MATERIALS),
    nodeId: resource.nodeId,
    weight: randomItem(WEIGHTS),
    script: resource.name,
    threshold: randomItem(THRESHOLDS),
    source: randomItem(SOURCES),
    target: randomItem(TARGETS),
    format: randomItem(FORMATS),
    quantity: randomItem(QUANTITIES),
  };
  const template = randomItem(TASK_TEMPLATES);
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_, key) => String(variables[key] ?? ''));
}

function extractJson(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed;
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced) return fenced[1].trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
  return trimmed;
}

async function fetchResources() {
  const response = await fetch(`${ACCOUNTING_URL.replace(/\/$/, '')}/api/resources`);
  if (!response.ok) {
    throw new Error(`Failed to fetch resources: HTTP ${response.status}`);
  }
  const resources = await response.json();
  if (!resources || typeof resources !== 'object' || Array.isArray(resources)) {
    throw new Error('Resource response must be an object keyed by nodeId');
  }
  return resources;
}

async function annotateWithClaude({ instruction, resources, apiKey }) {
  const userPrompt = [
    '節點資源清單 JSON:',
    JSON.stringify(resources),
    '',
    '使用者任務:',
    instruction,
    '',
    '請回傳符合此 TypeScript 型別的純 JSON:',
    '{"steps":[{"nodeId":"string","tool":"string","script":"string","args":{}}],"supervisorPolicy":"fail-fast|partial-success"}',
  ].join('\n');

  const response = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 1200,
      temperature: 0.2,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Claude API failed: HTTP ${response.status}${body ? ` ${body}` : ''}`);
  }

  const data = await response.json();
  const text = Array.isArray(data.content)
    ? data.content.filter((part) => part?.type === 'text' && typeof part.text === 'string').map((part) => part.text).join('\n')
    : '';
  if (!text.trim()) throw new Error('Claude API returned no text content');
  return JSON.parse(extractJson(text));
}

async function main() {
  const { out, count } = parseArgs(process.argv.slice(2));
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY env var is required');

  const validatePlan = createPlanValidator(await loadZod());
  const resources = await fetchResources();
  const outPath = path.resolve(process.cwd(), out);
  await fs.promises.mkdir(path.dirname(outPath), { recursive: true });

  const stream = fs.createWriteStream(outPath, { flags: 'w', encoding: 'utf8' });
  let successful = 0;
  let skipped = 0;

  try {
    while (successful < count) {
      const instruction = buildInstruction(resources);
      try {
        const plan = await annotateWithClaude({ instruction, resources, apiKey });
        const validation = validatePlan(plan);
        if (!validation.success) {
          skipped += 1;
          continue;
        }

        const line = {
          instruction,
          input: JSON.stringify(resources),
          output: JSON.stringify(plan),
        };
        stream.write(`${JSON.stringify(line)}\n`);
        successful += 1;

        if (successful % 10 === 0 || successful === count) {
          console.log(`[gen] ${successful}/${count} done (${skipped} skipped)`);
        }
      } catch {
        skipped += 1;
      }
    }
  } finally {
    await new Promise((resolve, reject) => {
      stream.end((error) => (error ? reject(error) : resolve()));
    });
  }
}

main().catch((error) => {
  console.error(`[gen] ${error.message}`);
  process.exitCode = 1;
});
