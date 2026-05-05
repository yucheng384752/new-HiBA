import { HttpAccountingClient } from '../planning/HttpAccountingClient';
import { HttpLLMClient }        from '../planning/HttpLLMClient';
import { NLPlanningService }    from '../planning/NLPlanningService';
import { AgentServer }          from './AgentServer';

const env = (key: string, fallback: string): string => process.env[key] ?? fallback;

async function main(): Promise<void> {
  const accounting = new HttpAccountingClient(
    env('ACCOUNTING_URL', 'http://localhost:9090'),
  );

  const llm = new HttpLLMClient(
    env('LLM_URL', 'http://localhost:11434/v1/chat/completions'),
    {
      model:  env('LLM_MODEL',  'hiba-planner'),
      format: env('LLM_FORMAT', 'openai') as 'openai' | 'ollama',
    },
  );

  const planning = new NLPlanningService(llm, accounting);

  const server = new AgentServer(planning, {
    port: Number(env('AGENT_PORT', '8090')),
    defaultCtx: {
      hibaBaseUrl: env('HIBA_BASE_URL', 'http://localhost:8092'),
      permissions: ['material.write', 'machine.read', 'material.read'],
    },
  });

  await server.start();

  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, async () => {
      console.log(`\n[AgentServer] ${sig} — shutting down…`);
      await server.stop();
      process.exit(0);
    });
  }
}

main().catch(err => {
  console.error('[AgentServer] startup failed:', err);
  process.exit(1);
});
