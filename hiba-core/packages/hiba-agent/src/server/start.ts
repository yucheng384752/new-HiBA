import { HttpAccountingClient } from '../planning/HttpAccountingClient';
import { HttpLLMClient }        from '../planning/HttpLLMClient';
import { NLPlanningService }    from '../planning/NLPlanningService';
import { HiBAToolbox }          from '../core/HiBAToolbox';
import { AuditTrail }           from '../audit/AuditTrail';
import { TrustRegistry }        from '../trust/TrustRegistry';
import { OrchestratorRunner, parseNodeAddresses } from './OrchestratorRunner';
import { AgentServer }          from './AgentServer';
import { WorkflowStore }        from './WorkflowStore';
import { TopologySequenceDetector } from '../topology/TopologySequenceDetector';
import { registerHibaTools }    from '../tools/hiba.tools';
import { registerAuditTools }   from '../tools/audit.tools';
import { registerContextRetrievalTools } from '../tools/context.tools';
import type { ToolPermission }  from '../types/hiba.types';

const env = (key: string, fallback: string): string => process.env[key] ?? fallback;

async function main(): Promise<void> {
  const accounting = new HttpAccountingClient(
    env('ACCOUNTING_URL', 'http://localhost:9090'),
  );

  const llm = new HttpLLMClient(
    env('LLM_URL', 'http://localhost:11434/v1/chat/completions'),
    {
      model:       env('LLM_MODEL',  'hiba-planner'),
      format:      env('LLM_FORMAT', 'openai') as 'openai' | 'ollama',
      timeoutMs:   Number(env('LLM_TIMEOUT_MS', '120000')),
      temperature: process.env['LLM_TEMPERATURE'] !== undefined ? Number(process.env['LLM_TEMPERATURE']) : undefined,
    },
  );

  const summaryLLM = new HttpLLMClient(
    env('LLM_URL', 'http://localhost:11434/v1/chat/completions'),
    {
      model:       env('SUMMARY_LLM_MODEL', 'llama3.1:latest'),
      format:      env('LLM_FORMAT', 'openai') as 'openai' | 'ollama',
      timeoutMs:   Number(env('LLM_TIMEOUT_MS', '120000')),
      temperature: Number(env('SUMMARY_LLM_TEMPERATURE', '0')),
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
  registerContextRetrievalTools(toolbox, { audit, accounting });

  const planning = new NLPlanningService(llm, accounting, { toolbox, summaryLLM });

  const nodeAddresses = process.env['NODE_ADDRESSES']
    ? parseNodeAddresses(process.env['NODE_ADDRESSES'])
    : new Map<string, string>();

  const orchestrator = new OrchestratorRunner(toolbox, audit, {
    nodeAddresses,
    accountingUrl: env('ACCOUNTING_URL', 'http://localhost:9090'),
    dispatchTimeoutMs: Number(env('DISPATCH_TIMEOUT_MS', '30000')),
    reconnectAttempts: Number(env('RECONNECT_ATTEMPTS', '1')),
    reconnectDelayMs: Number(env('RECONNECT_DELAY_MS', '1000')),
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

  // ── 拓樸序列偵測背景排程（規格 §四；門檻/頻率留給實作階段決定，見
  // TopologySequenceDetector 的說明）────────────────────────────────────────
  // 寫入目標是 accounting-server 管理的場域檔案（見 hiba-core/facilities/），
  // 透過 accounting client 呼叫，不是本機資料庫。
  const topologyDetector = new TopologySequenceDetector(audit, accounting, {
    minOccurrences: Number(env('TOPOLOGY_MIN_OCCURRENCES', '3')),
    lookbackMs: Number(env('TOPOLOGY_LOOKBACK_MS', String(7 * 24 * 60 * 60 * 1000))),
  });
  const runTopologyScan = (): void => {
    topologyDetector.run().catch(error => {
      console.error('[TopologySequenceDetector] scan failed:', error);
    });
  };
  runTopologyScan();
  const topologyScanTimer = setInterval(runTopologyScan, Number(env('TOPOLOGY_SCAN_INTERVAL_MS', String(30 * 60 * 1000))));

  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, async () => {
      console.log(`\n[AgentServer] ${sig} — shutting down…`);
      clearInterval(topologyScanTimer);
      await server.stop();
      process.exit(0);
    });
  }
}

main().catch(err => {
  console.error('[AgentServer] startup failed:', err);
  process.exit(1);
});
