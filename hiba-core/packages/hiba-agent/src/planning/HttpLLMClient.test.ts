import { describe, it, expect, jest, afterEach } from '@jest/globals';
import { HttpLLMClient, summarizeInputSchema } from './HttpLLMClient';
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
// Regression coverage: hiba-planner occasionally emits syntactically broken
// JSON (observed: a step's `input` object missing its closing brace before
// the enclosing `]`). JSON.parse and the fenced-code-block fallback both fail
// in that case, so complete() must retry once with the bad output shown back
// to the model, instead of silently handing the raw string downstream.

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
        ? '{"steps":[{"stepId":"S1","toolName":"a.b","nodeId":"n1","version":"1.0.0","input":{"x":1}]' // broken: missing }
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
