import { describe, it, expect, jest, afterEach } from '@jest/globals';
import { HttpLLMClient, summarizeInputSchema, repairBracketBalance, buildPlanJsonSchema } from './HttpLLMClient';
import type { LLMPayload } from './NLPlanningService';
import { HIBA_PROTOCOL_VERSION } from '../types/hiba.types';
import type { ToolSpec } from '../types/hiba.types';

// ── summarizeInputSchema ─────────────────────────────────────────────────────
// Regression coverage for the context-window bug: the planner's system prompt
// dumps every registered tool's inputSchema into one request. Full raw
// zod-to-json-schema JSON (with $schema/additionalProperties boilerplate) for
// 36 tools pushed the prompt to ~8.4k tokens against the local LLM's 4096
// context window, so every /api/plan call failed. summarizeInputSchema must
// keep the fields the LLM actually needs (name/type/required/description)
// while staying far more compact than the raw schema.

describe('summarizeInputSchema', () => {
  it('renders required and optional fields with type and description', () => {
    const schema = {
      type: 'object',
      properties: {
        orderId:  { type: 'string', description: '工單 ID' },
        quantity: { type: 'number', description: '執行數量' },
      },
      required: ['orderId'],
      additionalProperties: false,
      $schema: 'http://json-schema.org/draft-07/schema#',
    };

    const result = summarizeInputSchema(schema);

    expect(result).toBe('orderId: string (required) — 工單 ID; quantity: number (optional) — 執行數量');
  });

  it('returns a placeholder when the schema has no properties', () => {
    expect(summarizeInputSchema({ type: 'object' })).toBe('(no parameters)');
  });

  it('falls back to "any" when a property has no declared type', () => {
    const schema = { properties: { note: {} }, required: [] };
    expect(summarizeInputSchema(schema)).toBe('note: any (optional)');
  });
});

// ── repairBracketBalance ─────────────────────────────────────────────────────
// Both malformed strings below are verbatim hiba-planner:latest output captured
// live (fix/planner-prompt-context-overflow diagnosis), not hand-crafted.

describe('repairBracketBalance', () => {
  it('is a no-op on already-valid JSON', () => {
    const valid = '{"steps":[{"stepId":"S1","toolName":"a.b","input":{"x":1}}],"supervisorPolicy":"fail-fast"}';
    expect(repairBracketBalance(valid)).toBe(valid);
  });

  it('inserts a step object\'s missing closing brace before the array/object closers', () => {
    const broken = '{"steps":[{"stepId":"S1","toolName":"env.readTemperature","nodeId":"m2","version":"1.0.0",'
      + '"input":{"sensorId":"temperature_sensor"},"dependsOn":[]},{"stepId":"S2","toolName":"material.recordAudit",'
      + '"nodeId":"m3","version":"1.0.0","input":{"auditType":"temperature_log","result":"env.readTemperature(S1)",'
      + '"notes":"溫度記錄"}],"supervisorPolicy":"fail-fast"}';

    const repaired = repairBracketBalance(broken);

    expect(() => JSON.parse(repaired)).not.toThrow();
    const parsed = JSON.parse(repaired) as { steps: unknown[]; supervisorPolicy: string };
    expect(parsed.steps).toHaveLength(2);
    expect(parsed.supervisorPolicy).toBe('fail-fast');
  });

  it('substitutes a stray ")" for the "}" it was meant to be, without touching parens inside strings', () => {
    const broken = '{"steps":[{"stepId":"S1","toolName":"orchestrator.getAuditSummary","nodeId":"m2",'
      + '"version":"1.0.0","input":{"timeRange":{"start":"now-24h","end":"now"}),"dependsOn":[]}],'
      + '"supervisorPolicy":"fail-fast"}';

    const repaired = repairBracketBalance(broken);

    expect(() => JSON.parse(repaired)).not.toThrow();
    const parsed = JSON.parse(repaired) as { steps: Array<{ input: { timeRange: { start: string; end: string } } }> };
    expect(parsed.steps[0]!.input.timeRange).toEqual({ start: 'now-24h', end: 'now' });
  });

  it('leaves parentheses inside string values untouched', () => {
    const withParenInString = '{"note":"call fn(x)"}';
    expect(repairBracketBalance(withParenInString)).toBe(withParenInString);
  });

  it('drops a stray ")" that has nothing open left to close', () => {
    expect(repairBracketBalance('{})')).toBe('{}');
  });
});

// ── buildPlanJsonSchema ──────────────────────────────────────────────────────
// Turns on Ollama's grammar-constrained decoding: toolName must be one of the
// tools actually on offer, so a hallucinated name is rejected at the token
// level instead of caught after the fact by validatePlan's TOOL_NOT_FOUND retry.

function tool(name: `env.${string}` | `machine.${string}`): ToolSpec {
  return {
    protocolVersion: HIBA_PROTOCOL_VERSION,
    name,
    version: '1.0.0',
    description: name,
    tags: ['env', 'read'],
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    outputSchema: { type: 'object' },
    permissions: [],
    timeoutMs: 5000,
  };
}

describe('buildPlanJsonSchema', () => {
  it('restricts steps[].toolName to an enum of the supplied tool names', () => {
    const schema = buildPlanJsonSchema([tool('machine.queryStatus'), tool('env.readSensor')]);
    const steps = schema['properties'] as Record<string, any>;
    expect(steps['steps'].items.properties.toolName).toEqual({
      type: 'string',
      enum: ['machine.queryStatus', 'env.readSensor'],
    });
  });

  it('falls back to an unconstrained string when no tools are supplied', () => {
    const schema = buildPlanJsonSchema([]);
    const steps = schema['properties'] as Record<string, any>;
    expect(steps['steps'].items.properties.toolName).toEqual({ type: 'string' });
  });

  it('constrains supervisorPolicy to the two valid values', () => {
    const schema = buildPlanJsonSchema([]);
    const props = schema['properties'] as Record<string, any>;
    expect(props['supervisorPolicy']).toEqual({ type: 'string', enum: ['fail-fast', 'partial-success'] });
  });
});

// ── HttpLLMClient prompt size ────────────────────────────────────────────────

describe('HttpLLMClient system prompt', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('omits outputSchema so the prompt does not balloon past the context window', async () => {
    const manyTools: ToolSpec[] = Array.from({ length: 36 }, (_, i) => ({
      protocolVersion: HIBA_PROTOCOL_VERSION,
      name: `env.tool${i}`,
      version: '1.0.0',
      description: `Tool number ${i}`,
      tags: ['env', 'read'],
      inputSchema: {
        type: 'object',
        properties: { field: { type: 'string', description: 'a field' } },
        required: ['field'],
        additionalProperties: false,
        $schema: 'http://json-schema.org/draft-07/schema#',
      },
      outputSchema: {
        type: 'object',
        properties: { result: { type: 'string' } },
        required: ['result'],
        additionalProperties: false,
        $schema: 'http://json-schema.org/draft-07/schema#',
      },
      permissions: ['env.read'],
      timeoutMs: 5000,
    }));

    const payload: LLMPayload = { task: 'do something', resources: {}, nodes: [], tools: manyTools };

    let capturedBody: { messages: Array<{ content: string }> } | undefined;
    jest.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
      capturedBody = JSON.parse((init as RequestInit).body as string);
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"steps":[]}' } }] }));
    });

    const client = new HttpLLMClient('http://localhost:11434/v1/chat/completions', { format: 'openai' });
    await client.complete(payload);

    const systemPrompt = capturedBody!.messages[0]!.content;
    expect(systemPrompt).not.toContain('outputSchema');
    expect(systemPrompt).toContain('Use the minimum number of steps');
    expect(systemPrompt).toContain('machine.executeOrder step');
    // Rough token proxy: ~4 chars/token. Must clear headroom under a 4096-token
    // local context window even with 36 tools registered.
    expect(systemPrompt.length / 4).toBeLessThan(3500);
  });
});

// ── HttpLLMClient malformed-JSON retry ──────────────────────────────────────
// Regression coverage: hiba-planner occasionally emits output that isn't
// JSON at all (e.g. plain prose), which repairBracketBalance can't fix since
// there's nothing bracket-shaped to repair. complete() must retry once with
// the bad output shown back to the model in that case, instead of silently
// handing the raw string downstream. (A merely bracket-broken — but
// otherwise JSON-shaped — response is now recovered inline by
// repairBracketBalance without needing a network round-trip at all; see the
// 'repairBracketBalance' describe block above.)

describe('HttpLLMClient malformed-JSON retry', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  const payload: LLMPayload = { task: 'do something', resources: {}, nodes: [], tools: [] };

  it('retries once and returns the parsed object when the retry is valid JSON', async () => {
    const calls: Array<{ messages: Array<{ role: string; content: string }> }> = [];
    jest.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse((init as RequestInit).body as string);
      calls.push(body);
      const content = calls.length === 1
        ? 'sorry, I cannot determine a plan for that task' // not JSON-shaped at all — unrepairable
        : '{"steps":[]}';
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }));
    });

    const client = new HttpLLMClient('http://localhost:11434/v1/chat/completions', { format: 'openai' });
    const { rawJson } = await client.complete(payload);

    expect(calls).toHaveLength(2);
    expect(calls[1]!.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'assistant' }),
      expect.objectContaining({ role: 'user', content: expect.stringContaining('not valid JSON') }),
    ]));
    expect(rawJson).toEqual({ steps: [] });
  });

  it('recovers a merely bracket-broken response inline, without a retry round-trip', async () => {
    let callCount = 0;
    jest.spyOn(global, 'fetch').mockImplementation(async () => {
      callCount += 1;
      const content = '{"steps":[{"stepId":"S1","toolName":"a.b","nodeId":"n1","version":"1.0.0","input":{"x":1}]'; // missing one }
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }));
    });

    const client = new HttpLLMClient('http://localhost:11434/v1/chat/completions', { format: 'openai' });
    const { rawJson } = await client.complete(payload);

    expect(callCount).toBe(1);
    expect(rawJson).toEqual(expect.objectContaining({
      steps: [expect.objectContaining({ stepId: 'S1', toolName: 'a.b' })],
    }));
  });

  it('does not retry a second time — persistent malformed JSON returns the raw string once', async () => {
    let callCount = 0;
    jest.spyOn(global, 'fetch').mockImplementation(async () => {
      callCount += 1;
      return new Response(JSON.stringify({ choices: [{ message: { content: 'still not json{{{' } }] }));
    });

    const client = new HttpLLMClient('http://localhost:11434/v1/chat/completions', { format: 'openai' });
    const { rawJson } = await client.complete(payload);

    expect(callCount).toBe(2); // one retry attempt, then give up
    expect(rawJson).toBe('still not json{{{');
  });
});

// ── HttpLLMClient ollama format wiring ──────────────────────────────────────

describe('HttpLLMClient ollama format', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('sends the JSON Schema (not the bare string "json") as format, with the tool enum populated', async () => {
    const payload: LLMPayload = {
      task: 'do something',
      resources: {},
      nodes: [],
      tools: [tool('machine.queryStatus')],
    };

    let capturedBody: { format: unknown } | undefined;
    jest.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
      capturedBody = JSON.parse((init as RequestInit).body as string);
      return new Response(JSON.stringify({ response: '{"steps":[]}' }));
    });

    const client = new HttpLLMClient('http://localhost:11434/api/generate', { format: 'ollama' });
    await client.complete(payload);

    expect(capturedBody!.format).not.toBe('json');
    expect(capturedBody!.format).toEqual(buildPlanJsonSchema(payload.tools));
  });

  it('sends the same schema via response_format on the default openai-compatible path (LLM_FORMAT=openai in production)', async () => {
    const payload: LLMPayload = {
      task: 'do something',
      resources: {},
      nodes: [],
      tools: [tool('machine.queryStatus')],
    };

    let capturedBody: { response_format: { type: string; json_schema: { schema: unknown } } } | undefined;
    jest.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
      capturedBody = JSON.parse((init as RequestInit).body as string);
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"steps":[]}' } }] }));
    });

    // format defaults to 'openai' when omitted — this is what start.ts actually constructs in production.
    const client = new HttpLLMClient('http://localhost:11434/v1/chat/completions', {});
    await client.complete(payload);

    expect(capturedBody!.response_format.type).toBe('json_schema');
    expect(capturedBody!.response_format.json_schema.schema).toEqual(buildPlanJsonSchema(payload.tools));
  });
});
