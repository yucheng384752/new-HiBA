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
  /** Replace the entire system prompt builder — gives maximum flexibility */
  systemPromptTemplate?: (resources: NodeResourceMap, tools: string[]) => string;
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
          ? this.options.systemPromptTemplate(payload.resources, payload.availableTools)
          : buildDefaultSystemPrompt(payload.resources, payload.availableTools));

    const body = this.options.format === 'ollama'
      ? this.ollamaBody(system, payload.task)
      : this.openaiBody(system, payload.task);

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
    return { rawJson: tryParseJson(raw) };
  }

  private openaiBody(system: string, task: string) {
    return {
      model: this.options.model ?? 'hiba-planner',
      messages: [
        { role: 'system',  content: system },
        { role: 'user',    content: task   },
      ],
      response_format: { type: 'json_object' },
    };
  }

  private ollamaBody(system: string, task: string) {
    return {
      model:  this.options.model ?? 'hiba-planner',
      prompt: `${system}\n\nUser task: ${task}`,
      format: 'json',
      stream: false,
    };
  }
}

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
  if (m?.[1]) { try { return JSON.parse(m[1]); } catch { /* fall through */ } }
  return text;
}

function buildDefaultSystemPrompt(resources: NodeResourceMap, tools: string[]): string {
  const resourceBlock = Object.entries(resources).length
    ? Object.entries(resources)
        .map(([id, items]) =>
          `  ${id}: ${items.map(i => `${i.name}(${i.type}${i.version ? '@' + i.version : ''})`).join(', ')}`)
        .join('\n')
    : '  (no nodes registered)';

  const toolBlock = tools.length
    ? tools.map(t => `  - ${t}`).join('\n')
    : '  (no tools registered)';

  return `You are a HiBA workflow planner for a hierarchical distributed AI agent system.
Convert the user's natural language task into a structured JSON execution plan.

## Available Nodes and Resources
${resourceBlock}

## Available Tools
${toolBlock}

## Output — return ONLY valid JSON, no markdown wrapper, no explanation:
{
  "steps": [
    {
      "stepId":    "S1",
      "toolName":  "material.protectFile",
      "nodeId":    "node1",
      "version":   "1.0.0",
      "input":     { "filePath": "/path/to/resource" },
      "dependsOn": []
    }
  ],
  "supervisorPolicy": "fail-fast"
}

## Rules
1. toolName must be from the Available Tools list
2. nodeId must be a node from Available Nodes list
3. stepId must be unique: S1, S2, S3, ...
4. dependsOn lists stepIds that must complete before this step
5. input keys must match the tool's expected parameters
6. If the task is ambiguous, prefer "fail-fast" supervisorPolicy`;
}
