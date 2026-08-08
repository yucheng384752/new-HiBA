import { HttpAccountingClient } from '../planning/HttpAccountingClient';
import { HttpLLMClient }        from '../planning/HttpLLMClient';
import { NLPlanningService }    from '../planning/NLPlanningService';
import { HiBAToolbox }          from '../core/HiBAToolbox';
import { AuditTrail }           from '../audit/AuditTrail';
import { TrustRegistry }        from '../trust/TrustRegistry';
import { OrchestratorRunner, parseNodeAddresses } from './OrchestratorRunner';
import { AgentServer }          from './AgentServer';
import { WorkflowStore }        from './WorkflowStore';
import { registerHibaTools }    from '../tools/hiba.tools';
import { registerAuditTools }   from '../tools/audit.tools';
import type { ToolPermission }  from '../types/hiba.types';

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

  const permissions: ToolPermission[] = [
    'material.write', 'material.read',
    'machine.write',  'machine.read',
    'man.write',      'man.read',
    'method.write',   'method.read',
    'env.write',      'env.read',
    'orchestrator.write', 'orchestrator.read',
  ];

  const audit    = new AuditTrail(env('AUDIT_DB', './hiba-audit.db'));
  const toolbox  = new HiBAToolbox({ auditWriter: audit, permissions });
  const registry = new TrustRegistry(env('TRUST_DB', './hiba-trust.db'));
  const workflowStore = new WorkflowStore(env('WORKFLOW_DB', './hiba-workflows.db'));

  registerHibaTools(toolbox);
  registerAuditTools(toolbox, audit);

  const planning = new NLPlanningService(llm, accounting, { toolbox });

  const nodeAddresses = process.env['NODE_ADDRESSES']
    ? parseNodeAddresses(process.env['NODE_ADDRESSES'])
    : new Map<string, string>();

  const orchestrator = new OrchestratorRunner(toolbox, audit, {
    nodeAddresses,
    accountingUrl: env('ACCOUNTING_URL', 'http://localhost:9090'),
  });

  const server = new AgentServer(planning, {
    port: Number(env('AGENT_PORT', '8090')),
    toolbox,
    registry,
    orchestrator,
    workflowStore,
    auditTrail: audit,
    defaultCtx: {
      hibaBaseUrl: env('HIBA_BASE_URL', 'http://localhost:9090'),
      permissions,
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
