import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { toToolSpec } from '../packages/hiba-agent/src/core/defineTool';
import { allHibaTools } from '../packages/hiba-agent/src/tools/hiba.tools';

type JsonSchemaLike = {
  properties?: Record<string, unknown>;
};

function propDef(schema: JsonSchemaLike | undefined, key: string): { type?: unknown; enum?: unknown[] } | undefined {
  return schema?.properties?.[key] as { type?: unknown; enum?: unknown[] } | undefined;
}

type OldEntry = {
  name: string;
  toolName?: string;
  scriptName?: string;
  renderHint?: string;
  inputSchema?: JsonSchemaLike;
  outputSchema?: JsonSchemaLike;
  /** 見 4270c1e：meta-tool 刻意不進 allHibaTools 註冊，只能被直接 API/腳本
   *  呼叫、不透過 NL planner 挑選。這類條目沒有對應的 canonical ToolSpec。 */
  plannerVisible?: boolean;
  [key: string]: unknown;
};

// ToolSpec（toToolSpec() 的輸出欄位）以外的一切都是 manifest 專屬 metadata
// （如 summaryHints、metadataSchemaVersion），regenerate 時必須保留，不能
// 被 canonical ToolSpec 覆寫掉——這兩個欄位是 Dashboard／NLPlanningService
// 組裝 LLM 執行摘要用的展示 metadata，canonical Tool 定義本來就不該有。
const TOOLSPEC_KEYS = new Set([
  'protocolVersion', 'name', 'version', 'description', 'tags',
  'inputSchema', 'outputSchema', 'permissions', 'timeoutMs', 'retryPolicy',
]);

function extraManifestFields(entry: OldEntry): Record<string, unknown> {
  const extras: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry)) {
    if (key === 'scriptName' || key === 'renderHint' || key === 'toolName') continue;
    if (!TOOLSPEC_KEYS.has(key)) extras[key] = value;
  }
  return extras;
}

/**
 * Pi 端稽核自報慣例（sub_web_server.js 的 anchorResult()）：Python 腳本可
 * 選擇性在自己的輸出加上 toolName/domain 給 Pi 本地 SQLite 稽核用，跟
 * HiBAToolbox 的稽核機制無關（那邊已經有 ctx/tool.tags[0] 可用）。canonical
 * outputSchema 正確地不宣告這兩個欄位，但 regenerate 時不該把 manifest 裡
 * 既有的宣告砍掉——兩邊都對，只是服務不同層的稽核機制。
 */
function preserveAuditSelfReportFields(
  generated: JsonSchemaLike,
  previous: JsonSchemaLike | undefined,
): JsonSchemaLike {
  const previousProps = previous?.properties ?? {};
  const carried: Record<string, unknown> = {};
  for (const key of ['toolName', 'domain']) {
    if (key in previousProps) carried[key] = previousProps[key];
  }
  if (Object.keys(carried).length === 0) return generated;
  return { ...generated, properties: { ...(generated.properties ?? {}), ...carried } };
}

const manifestPath = resolve(__dirname, '..', '..', 'scripts_pi', 'deploy_http', 'scripts', 'manifest.json');
const current = JSON.parse(readFileSync(manifestPath, 'utf8')) as OldEntry[];
const tools = new Map(allHibaTools.map(tool => [tool.name, tool]));

const manifest = current.map(entry => {
  const toolName = entry.toolName ?? entry.name;
  const scriptName = entry.scriptName ?? (entry.toolName ? entry.name : undefined);
  if (!scriptName) throw new Error(`No canonical ToolSpec or scriptName for '${toolName}'`);

  const scriptsDir = dirname(manifestPath);
  if (![resolve(scriptsDir, `${scriptName}.py`), resolve(scriptsDir, '..', `${scriptName}.py`)].some(existsSync)) {
    throw new Error(`Script artifact '${scriptName}.py' does not exist`);
  }

  const tool = tools.get(toolName as typeof allHibaTools[number]['name']);
  if (tool === undefined) {
    if (entry.plannerVisible === false) {
      // plannerVisible=false 的 meta-tool 沒有 allHibaTools 註冊，維持原樣，
      // 不套用 toToolSpec() 重建。
      return entry;
    }
    throw new Error(`No canonical ToolSpec or scriptName for '${toolName}'`);
  }

  const spec = toToolSpec(tool);
  return {
    scriptName,
    renderHint: entry.renderHint ?? 'table',
    ...spec,
    outputSchema: preserveAuditSelfReportFields(spec.outputSchema, entry.outputSchema),
    ...extraManifestFields(entry),
  };
});

// ── input/output 主要欄位型別相容性檢查 ─────────────────────────────────────
// 只驗證共同欄位的 type/enum 是否相容——不要求 required 清單或 description
// 文字逐字一致。manifest 常年手工加了 summaryHints/toolName/domain 這類
// canonical Tool 定義原本就沒有、也不需要有的欄位，逐字比對只會製造出跟
// 實際契約無關的假陽性（詳見 2026-08-31 討論的落差分類 A/B/C）。
function schemaTypeIncompatibilities(
  label: string,
  current: JsonSchemaLike | undefined,
  generated: JsonSchemaLike | undefined,
): string[] {
  const currentProps = current?.properties ?? {};
  const errors: string[] = [];
  for (const key of Object.keys(currentProps)) {
    const currentDef = propDef(current, key);
    const generatedDef = propDef(generated, key);
    if (!generatedDef) continue; // manifest 可以有 canonical 沒有的欄位（如自報稽核用的 toolName/domain）
    if (JSON.stringify(currentDef?.type) !== JSON.stringify(generatedDef.type)) {
      errors.push(`${label}.${key}: type ${JSON.stringify(currentDef?.type)} !== ${JSON.stringify(generatedDef.type)}`);
    }
    if (currentDef?.enum && JSON.stringify(currentDef.enum) !== JSON.stringify(generatedDef.enum)) {
      errors.push(`${label}.${key}: enum ${JSON.stringify(currentDef.enum)} !== ${JSON.stringify(generatedDef.enum)}`);
    }
  }
  return errors;
}

if (process.argv.includes('--check')) {
  const errors: string[] = [];
  manifest.forEach((generated, i) => {
    const entry = current[i]!;
    const name = entry.toolName ?? entry.name;
    if (entry.scriptName !== undefined && entry.scriptName !== (generated as OldEntry).scriptName) {
      errors.push(`${name}: scriptName ${entry.scriptName} !== ${(generated as OldEntry).scriptName}`);
    }
    errors.push(...schemaTypeIncompatibilities(`${name}.inputSchema`, entry.inputSchema, (generated as OldEntry).inputSchema as JsonSchemaLike | undefined));
    errors.push(...schemaTypeIncompatibilities(`${name}.outputSchema`, entry.outputSchema, (generated as OldEntry).outputSchema as JsonSchemaLike | undefined));
  });
  if (errors.length > 0) {
    throw new Error(`Pi manifest has incompatible schemas:\n${errors.join('\n')}`);
  }
  console.log(`Tool manifest is structurally compatible (${manifest.length} entries)`);
} else {
  const output = `${JSON.stringify(manifest, null, 2)}\n`;
  writeFileSync(manifestPath, output, 'utf8');
  console.log(`Wrote ${manifest.length} ToolSpec v1 entries to ${manifestPath}`);
}
