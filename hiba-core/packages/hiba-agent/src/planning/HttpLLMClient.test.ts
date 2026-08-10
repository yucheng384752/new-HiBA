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
    // Rough token proxy: ~4 chars/token. Must clear headroom under a 4096-token
    // local context window even with 36 tools registered.
    expect(systemPrompt.length / 4).toBeLessThan(3500);
  });
});
