import type { NodeDescriptor, ToolSpec } from '../types/hiba.types';
import type { LLMClient, LLMPayload, NodeResourceMap } from './NLPlanningService';

// ── Options ───────────────────────────────────────────────────────────────────

export interface HttpLLMClientOptions {
  /** Model identifier forwarded to the LLM server */
  model?: string;
  timeoutMs?: number;
  /**
   * 'openai' → POST /v1/chat/completions with messages[] (vLLM, LM Studio, compatible servers)
   * 'ollama' → POST /api/generate with prompt string
   */
  format?: 'openai' | 'ollama';
  /**
   * Sampling temperature forwarded to the LLM. Lower values make tool-name
   * selection more deterministic and less likely to hallucinate names outside
   * the provided catalog (e.g. "cnc_job.sh" instead of a registered tool).
   * Default: 0.1.
   */
  temperature?: number;
  /** Replace the entire system prompt builder — gives maximum flexibility */
  systemPromptTemplate?: (
    resources: NodeResourceMap,
    nodes: NodeDescriptor[],
    tools: ToolSpec[],
    requestedAt: string,
  ) => string;
}

// ── HttpLLMClient ─────────────────────────────────────────────────────────────

export class HttpLLMClient implements LLMClient {
  constructor(
    private readonly endpoint: string,
    private readonly options: HttpLLMClientOptions = {},
  ) {}

  async complete(payload: LLMPayload): Promise<{ rawJson: unknown }> {
    const system = payload.systemPrompt
      ?? (this.options.systemPromptTemplate
          ? this.options.systemPromptTemplate(payload.resources, payload.nodes, payload.tools, payload.requestedAt)
          : buildDefaultSystemPrompt(payload.resources, payload.nodes, payload.tools, payload.requestedAt));

    const first = await this.fetchAndParse(system, payload.task, payload.tools);
    if (typeof first.parsed !== 'string') return { rawJson: first.parsed };

    // hiba-planner occasionally emits syntactically broken JSON (mismatched
    // braces/parens) that fails both JSON.parse and the fenced-code-block
    // fallback in tryParseJson, which returns the raw string as-is. Handing
    // that string downstream just produces a confusing "expected object,
    // received string" validation error, so retry once with the bad output
    // shown back to the model and an explicit correction request.
    const retry = await this.fetchAndParse(system, payload.task, payload.tools, first.raw);
    return { rawJson: retry.parsed };
  }

  private async fetchAndParse(
    system: string,
    task: string,
    tools: ToolSpec[],
    previousInvalidOutput?: string,
  ): Promise<{ raw: string; parsed: unknown }> {
    const body = this.options.format === 'ollama'
      ? this.ollamaBody(system, task, tools, previousInvalidOutput)
      : this.openaiBody(system, task, tools, previousInvalidOutput);

    const res = await fetch(this.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 30_000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`LLM ${this.endpoint} → HTTP ${res.status}: ${text.slice(0, 200)}`);
    }

    const data = await res.json() as Record<string, unknown>;
    const raw = extractText(data, this.options.format ?? 'openai');
    return { raw, parsed: tryParseJson(raw) };
  }

  private openaiBody(system: string, task: string, tools: ToolSpec[], previousInvalidOutput?: string) {
    const messages = [
      { role: 'system', content: system },
      { role: 'user',   content: task   },
    ];
    if (previousInvalidOutput !== undefined) {
      messages.push(
        { role: 'assistant', content: previousInvalidOutput },
        { role: 'user',      content: JSON_CORRECTION_MESSAGE },
      );
    }
    return {
      model: this.options.model ?? 'hiba-planner',
      messages,
      // OpenAI Structured Outputs (also honored by Ollama's OpenAI-compatible
      // endpoint, and by vLLM — verified live against Ollama 0.32.9): same
      // grammar-constrained decoding as ollamaBody's format, so this is the
      // path production actually exercises by default (LLM_FORMAT=openai).
      response_format: { type: 'json_schema', json_schema: { name: 'execution_plan', schema: buildPlanJsonSchema(tools) } },
      temperature: this.options.temperature ?? 0.1,
    };
  }

  private ollamaBody(system: string, task: string, tools: ToolSpec[], previousInvalidOutput?: string) {
    const prompt = previousInvalidOutput === undefined
      ? `${system}\n\nUser task: ${task}`
      : `${system}\n\nUser task: ${task}\n\nYour previous response:\n${previousInvalidOutput}\n\n${JSON_CORRECTION_MESSAGE}`;
    return {
      model:  this.options.model ?? 'hiba-planner',
      prompt,
      // A JSON Schema (rather than the bare string 'json') turns on Ollama's
      // grammar-constrained decoding: toolName is restricted to an enum of the
      // tools actually on offer, so the model cannot emit a hallucinated name
      // (e.g. "env.readTemperature") — it's rejected at the token level, not
      // caught after the fact by validatePlan's TOOL_NOT_FOUND retry.
      format: buildPlanJsonSchema(tools),
      stream: false,
      options: { temperature: this.options.temperature ?? 0.1 },
    };
  }
}

const JSON_CORRECTION_MESSAGE = 'Your previous response was not valid JSON, or did not match the '
  + 'required shape. Return ONLY a single valid JSON object matching the schema above — no markdown '
  + 'wrapper, no commentary, and make sure every brace/bracket/parenthesis is correctly matched.';

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractText(data: Record<string, unknown>, format: 'openai' | 'ollama'): string {
  if (format === 'ollama' && typeof data['response'] === 'string') return data['response'];
  // OpenAI-compatible: choices[0].message.content
  const choices = data['choices'] as Array<{ message?: { content?: string } }> | undefined;
  if (choices?.[0]?.message?.content) return choices[0].message.content;
  return JSON.stringify(data);
}

function tryParseJson(text: string): unknown {
  try { return JSON.parse(text); } catch { /* try extracting code fence */ }
  const m = /```(?:json)?\s*([\s\S]+?)\s*```/.exec(text);
  const candidate = m?.[1] ?? text;
  if (m?.[1]) { try { return JSON.parse(m[1]); } catch { /* fall through */ } }
  const repaired = repairBracketBalance(candidate);
  if (repaired !== candidate) {
    try { return JSON.parse(repaired); } catch { /* fall through */ }
  }
  return text;
}

/**
 * Mechanically repairs the two malformed-JSON patterns observed from
 * hiba-planner under the full production prompt: a step object missing its
 * closing `}` before the enclosing `]`/`}`, and a stray `)` used where a
 * `}` was meant (valid JSON never contains a bare parenthesis outside a
 * string value, so any `)` seen outside a string is always a mistake here).
 *
 * Tracks a stack of the closer each open `{`/`[` expects. A `}` or `]` that
 * doesn't match the current top first pops and emits whatever closer(s) are
 * actually pending (repairing a missing closer), then consumes the matching
 * one; a `)` always closes exactly one pending scope. Never touches string
 * content, and is a no-op on already-balanced JSON, so callers can attempt
 * it unconditionally.
 */
export function repairBracketBalance(text: string): string {
  const stack: Array<'}' | ']'> = [];
  let out = '';
  let inString = false;
  let escaped = false;

  for (const ch of text) {
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') { inString = true; out += ch; continue; }
    if (ch === '{') { stack.push('}'); out += ch; continue; }
    if (ch === '[') { stack.push(']'); out += ch; continue; }

    if (ch === '}' || ch === ']') {
      while (stack.length > 0 && stack[stack.length - 1] !== ch) out += stack.pop();
      out += stack.length > 0 ? stack.pop()! : ch;
      continue;
    }

    if (ch === ')') {
      if (stack.length > 0) out += stack.pop();
      continue; // a stray ')' with nothing open left to close is dropped
    }

    out += ch;
  }

  while (stack.length > 0) out += stack.pop();
  return out;
}

/**
 * Builds the JSON Schema handed to Ollama's `format` field (in place of the
 * bare string `'json'`) to turn on grammar-constrained decoding. Only
 * `toolName` is restricted to the tools actually on offer for this request —
 * step `input` is deliberately left as a generic object rather than a
 * per-tool conditional schema (would need an `if`/`then` branch per tool and
 * grows with the catalog); malformed `input` is still caught by
 * validatePlan's existing schema check and retry. Passed via `format`, this
 * does not add to the prompt's token budget the way spelling it out in text
 * would (see summarizeInputSchema above for why that budget is tight).
 */
export function buildPlanJsonSchema(tools: ToolSpec[]): Record<string, unknown> {
  const toolNames = tools.map(tool => tool.name);
  return {
    type: 'object',
    properties: {
      protocolVersion: { type: 'string', const: '1.0' },
      steps: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            stepId:    { type: 'string' },
            toolName:  toolNames.length ? { type: 'string', enum: toolNames } : { type: 'string' },
            nodeId:    { type: 'string' },
            version:   { type: 'string' },
            input:     { type: 'object' },
            dependsOn: { type: 'array', items: { type: 'string' } },
          },
          required: ['stepId', 'toolName', 'nodeId', 'version', 'input', 'dependsOn'],
        },
      },
      supervisorPolicy: { type: 'string', enum: ['fail-fast', 'partial-success'] },
      error: { type: 'string' },
    },
    required: ['protocolVersion', 'steps', 'supervisorPolicy'],
  };
}

// Exported so the training-data generator can build system prompts identical
// to what production actually sends (single source of truth for the prompt
// format — see plan_LLM_訓練清單.md §十四 for why training/eval previously
// diverged from this).
export function buildDefaultSystemPrompt(
  resources: NodeResourceMap,
  nodes: NodeDescriptor[],
  tools: ToolSpec[],
  requestedAt: string,
): string {
  const resourceBlock = Object.entries(resources).length
    ? Object.entries(resources)
        .map(([id, items]) =>
          `  ${id}: ${items.map(i => `${i.name}(${i.type}${i.version ? '@' + i.version : ''})`).join(', ')}`)
        .join('\n')
    : '  (no nodes registered)';

  const nodeBlock = nodes.length
    ? nodes.map(node =>
        `  ${node.nodeId}: status=${node.status}, canInstall=${String(node.canInstall)}, tools=${node.resources.map(resource => `${resource.name}@${resource.version}`).join(', ')}`,
      ).join('\n')
    : '  (no nodes registered)';

  const toolBlock = tools.length
    ? tools.map(tool => [
        `  - ${tool.name}@${tool.version}: ${tool.description}`,
        `    input: ${summarizeInputSchema(tool.inputSchema)}`,
      ].join('\n')).join('\n')
    : '  (no tools registered)';

  return `You are a HiBA workflow planner for a hierarchical distributed AI agent system.
Convert the user's natural language task into a structured JSON execution plan.

## Current Time
${requestedAt} (ISO 8601). This is your only source for "now" — use it as the
reference point for any relative time expression in the task (e.g. "過去24小時",
"本月", "上週"). Never guess or invent a timestamp; compute from this value.

## Available Nodes and Resources
${resourceBlock}

## Live Node Descriptors
${nodeBlock}

## Available Tools
${toolBlock}

## Output — return ONLY valid JSON, no markdown wrapper, no explanation. This
## shows the required shape only — toolName/version below are placeholders,
## NOT real tools; always pick real ones from "Available Tools" above:
{
  "protocolVersion": "1.0",
  "steps": [
    {
      "stepId":    "S1",
      "toolName":  "<copied verbatim from Available Tools>",
      "nodeId":    "<an online node from Live Node Descriptors>",
      "version":   "<copied verbatim from the same Available Tools entry>",
      "input":     { "...": "must match that tool's input fields" },
      "dependsOn": []
    }
  ],
  "supervisorPolicy": "fail-fast"
}

## Worked examples (illustrate the rules below — tool/field names shown are
## NOT fixed, always pick real ones from "Available Tools" for the actual task)

Example 1 — single tool:
Task: "查詢 CNC-01 機台狀態"
Given "Available Tools" contains: machine.queryStatus@1.0.0 — 機台狀態查詢
(input: machineId: string (required))
Correct plan:
{"protocolVersion":"1.0","steps":[{"stepId":"S1","toolName":"machine.queryStatus","nodeId":"node1","version":"1.0.0","input":{"machineId":"CNC-01"},"dependsOn":[]}],"supervisorPolicy":"fail-fast"}

Example 2 — dependsOn chain ("先...再..." / "然後" means the later step depends on the earlier one):
Task: "先驗證 node1 上檔案 a.xml 的完整性，通過後再保護上鏈"
Given "Available Tools" contains: material.verifyFile@1.0.0 — 驗證檔案完整性 (input: filePath: string (required)),
material.protectFile@1.0.0 — 保護檔案並建立稽核紀錄 (input: filePath: string (required); keepFile: boolean (optional))
Correct plan:
{"protocolVersion":"1.0","steps":[{"stepId":"S1","toolName":"material.verifyFile","nodeId":"node1","version":"1.0.0","input":{"filePath":"a.xml"},"dependsOn":[]},{"stepId":"S2","toolName":"material.protectFile","nodeId":"node1","version":"1.0.0","input":{"filePath":"a.xml","keepFile":true},"dependsOn":["S1"]}],"supervisorPolicy":"fail-fast"}

Example 3 — nested structured input, computed from Current Time (a time-range field is
always an object with "from"/"to" ISO 8601 strings — never "start"/"end", never a
placeholder string like "now-24h"):
Task: "取得過去24小時的稽核執行摘要"（assume Current Time above is 2026-08-24T12:00:00Z）
Given "Available Tools" contains: orchestrator.getAuditSummary@1.0.0 — 取得稽核摘要
(input: timeRange: object (required) — { from: string, to: string })
Correct plan:
{"protocolVersion":"1.0","steps":[{"stepId":"S1","toolName":"orchestrator.getAuditSummary","nodeId":"node1","version":"1.0.0","input":{"timeRange":{"from":"2026-08-23T12:00:00Z","to":"2026-08-24T12:00:00Z"}},"dependsOn":[]}],"supervisorPolicy":"fail-fast"}

## Rules
1. toolName MUST be copied character-for-character from an "Available Tools"
   entry above. NEVER invent, translate, abbreviate, or guess a plausible-
   sounding name (e.g. "cnc_job.sh", "run_cnc", "qc_check.sh" are all
   WRONG — they are not in the list). If no tool in the list fits the task,
   return {"steps": [], "supervisorPolicy": "fail-fast", "error": "no matching tool for task"}.
2. version must be copied from the same Available Tools entry as toolName.
3. nodeId must be an online node that advertises the tool, or an online node with canInstall=true
4. stepId must be unique: S1, S2, S3, ...
5. dependsOn lists stepIds that must complete before this step
6. input must validate against the tool's inputSchema; never invent parameter names
7. protocolVersion must be "1.0"
8. Use the minimum number of steps that directly satisfy the task. Do not add
   status checks, material/attachment operations, or orchestration helpers
   unless the user explicitly requests them.
9. Each explicitly requested machine/order execution maps to exactly one
   machine.executeOrder step. Preserve its nodeId, machineId, and orderId.
   Words such as "接續", "然後", or "after" mean the later step dependsOn the
   preceding step.
10. If the task is ambiguous, prefer "fail-fast" supervisorPolicy
11. Any time-range input field is an object {"from": ISO8601, "to": ISO8601},
    computed from "## Current Time" above — see Example 3. Never use
    "start"/"end" as field names, and never emit a non-ISO placeholder like
    "now" or "now-24h"`;
}

/**
 * Renders a tool's inputSchema (full zod-to-json-schema output) as one compact
 * line instead of dumping the raw JSON schema. The raw form repeats `$schema`,
 * `additionalProperties`, and nested `type` wrappers for every property on every
 * tool, which was blowing the prompt past the local LLM's 4096-token context
 * window (36 registered tools × input+output schema ≈ 8.4k tokens). The LLM
 * only needs field name / type / required / description to fill `input` — it
 * never reads outputSchema, so that block is dropped entirely (see caller).
 */
export function summarizeInputSchema(schema: Record<string, unknown>): string {
  const properties = schema['properties'];
  if (!properties || typeof properties !== 'object') return '(no parameters)';

  const required = new Set(
    Array.isArray(schema['required']) ? (schema['required'] as unknown[]).filter((r): r is string => typeof r === 'string') : [],
  );

  const fields = Object.entries(properties as Record<string, unknown>).map(([name, propRaw]) => {
    const prop = (propRaw && typeof propRaw === 'object') ? propRaw as Record<string, unknown> : {};
    const type = typeof prop['type'] === 'string' ? prop['type'] : 'any';
    const desc = typeof prop['description'] === 'string' ? ` — ${prop['description']}` : '';
    const req  = required.has(name) ? 'required' : 'optional';
    return `${name}: ${type} (${req})${desc}`;
  });

  return fields.length ? fields.join('; ') : '(no parameters)';
}
