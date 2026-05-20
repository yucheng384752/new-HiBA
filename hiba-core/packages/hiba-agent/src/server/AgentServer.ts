import http from 'node:http';
import type { NLPlanningService, NodeResourceMap } from '../planning/NLPlanningService';
import type { HiBAToolbox } from '../core/HiBAToolbox';
import type { ToolContext } from '../types/hiba.types';
import type { TrustRegistry, AgentRecord } from '../trust/TrustRegistry';
import type { OrchestratorRunner } from './OrchestratorRunner';
import type { ExecutionPlan } from '../types/hiba.types';

// ── CORS ───────────────────────────────────────────────────────────────────────

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Trace-Id, X-Agent-Id, X-Depth',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', ...CORS });
  res.end(JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.setEncoding('utf8');
    req.on('data', c => { buf += c; });
    req.on('end', () => {
      try { resolve(buf ? JSON.parse(buf) : {}); }
      catch { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

// ── Intent Parsing ────────────────────────────────────────────────────────────

export interface IntentResult {
  intentClass: string;
  keywords: string[];
  mentionedNodes: string[];
  confidence: number;
  canHandle: boolean;
}

const INTENT_KEYWORDS: Record<string, string[]> = {
  cut:       ['切割', '裁切', 'cut'],
  qc:        ['品質', '檢測', 'qc', '合格', '不合格', 'quality'],
  cnc:       ['cnc', '精密', '加工'],
  transport: ['搬運', '傳送', '送到', 'transfer'],
  report:    ['報告', '日報', '報表', 'report', 'pdf'],
};

function parseIntent(text: string, resources: NodeResourceMap): IntentResult {
  const lower = text.toLowerCase();

  let intentClass = 'unknown';
  let maxMatches = 0;
  for (const [cls, kws] of Object.entries(INTENT_KEYWORDS)) {
    const matches = kws.filter(kw => lower.includes(kw)).length;
    if (matches > maxMatches) { maxMatches = matches; intentClass = cls; }
  }

  const keywords: string[] = [];
  const mentionedNodes: string[] = [];
  for (const [nodeId, items] of Object.entries(resources)) {
    for (const item of items) {
      if (lower.includes(item.name.toLowerCase())) {
        keywords.push(item.name);
        if (!mentionedNodes.includes(nodeId)) mentionedNodes.push(nodeId);
      }
    }
  }

  const confidence = Math.min(1, (maxMatches * 0.4) + (mentionedNodes.length > 0 ? 0.3 : 0));
  return { intentClass, keywords, mentionedNodes, confidence, canHandle: mentionedNodes.length > 0 };
}

// ── AgentServer ───────────────────────────────────────────────────────────────

export interface AgentServerOptions {
  port?: number;
  /** Injected into ToolContext for each /api/plan and /api/execute call */
  defaultCtx?: Partial<ToolContext>;
  /**
   * When provided, enables:
   *   GET  /api/tools            → registered tool metadata list
   *   POST /api/execute          → direct tool execution with audit
   */
  toolbox?: HiBAToolbox;
  /**
   * When provided, enables:
   *   GET    /api/agents         → list all agents
   *   GET    /api/agents/:id     → lookup agent
   *   POST   /api/agents         → register agent
   *   DELETE /api/agents/:id     → revoke agent
   */
  registry?: TrustRegistry;
  /**
   * When provided, enables:
   *   POST /api/run → execute an ExecutionPlan via topological step scheduling
   */
  orchestrator?: OrchestratorRunner;
}

/**
 * Minimal HTTP server that exposes NLPlanningService over HTTP.
 * Designed for browser (Claw Dashboard) access with CORS enabled.
 *
 * Routes:
 *   GET  /health           → { status, service }
 *   GET  /api/resources    → NodeResourceMap (proxied from AccountingClient)
 *   POST /api/plan         → ExecutionPlan
 */
export class AgentServer {
  private readonly server: http.Server;

  constructor(
    private readonly planning: NLPlanningService,
    private readonly options: AgentServerOptions = {},
  ) {
    this.server = http.createServer(this.handle.bind(this));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const { method } = req;
    const urlPath = (req.url ?? '/').split('?')[0] ?? '/';

    if (method === 'OPTIONS') {
      res.writeHead(204, CORS);
      res.end();
      return;
    }

    try {
      if (method === 'GET' && urlPath === '/health') {
        json(res, 200, { status: 'ok', service: 'hiba-agent' });
        return;
      }

      if (method === 'GET' && urlPath === '/api/resources') {
        const resources = await this.planning.getResources();
        json(res, 200, resources);
        return;
      }

      // ── /api/agents ──────────────────────────────────────────────────────────

      if (urlPath === '/api/agents') {
        if (!this.options.registry) {
          json(res, 503, { error: 'Trust registry not configured on this server' });
          return;
        }
        if (method === 'GET') {
          const agents = await this.options.registry.listAll();
          json(res, 200, agents);
          return;
        }
        if (method === 'POST') {
          const body = (await readBody(req)) as Partial<AgentRecord>;
          if (!body.agentId || !body.role || !body.publicKeyPem) {
            json(res, 400, { error: '"agentId", "role", and "publicKeyPem" are required' });
            return;
          }
          await this.options.registry.register({
            agentId:       body.agentId,
            role:          body.role,
            permissions:   body.permissions   ?? [],
            parentAgentId: body.parentAgentId ?? null,
            publicKeyPem:  body.publicKeyPem,
            registeredAt:  Date.now(),
            status:        'active',
          });
          json(res, 201, { agentId: body.agentId, status: 'registered' });
          return;
        }
      }

      const agentIdMatch = urlPath.match(/^\/api\/agents\/(.+)$/);
      if (agentIdMatch) {
        const agentId = decodeURIComponent(agentIdMatch[1]!);
        if (!this.options.registry) {
          json(res, 503, { error: 'Trust registry not configured on this server' });
          return;
        }
        if (method === 'GET') {
          const agent = await this.options.registry.lookup(agentId);
          if (!agent) { json(res, 404, { error: `Agent '${agentId}' not found` }); return; }
          json(res, 200, agent);
          return;
        }
        if (method === 'DELETE') {
          try {
            await this.options.registry.revoke(agentId);
            json(res, 200, { agentId, status: 'revoked' });
          } catch {
            json(res, 404, { error: `Agent '${agentId}' not found` });
          }
          return;
        }
      }

      // ── /api/intent ──────────────────────────────────────────────────────────

      if (method === 'POST' && urlPath === '/api/intent') {
        const body = (await readBody(req)) as { text?: string };
        if (!body.text?.trim()) {
          json(res, 400, { error: '"text" is required' });
          return;
        }
        const resources = await this.planning.getResources();
        json(res, 200, parseIntent(body.text, resources));
        return;
      }

      if (method === 'GET' && urlPath === '/api/tools') {
        if (!this.options.toolbox) {
          json(res, 503, { error: 'Toolbox not configured on this server' });
          return;
        }
        const tools = this.options.toolbox.list().map(t => ({
          name:        t.name,
          version:     t.version,
          description: t.description,
          tags:        t.tags,
          permissions: t.permissions,
          timeout:     t.timeout,
        }));
        json(res, 200, tools);
        return;
      }

      if (method === 'POST' && urlPath === '/api/execute') {
        if (!this.options.toolbox) {
          json(res, 503, { error: 'Toolbox not configured on this server' });
          return;
        }
        const body = (await readBody(req)) as { toolName?: string; input?: unknown };
        if (!body.toolName) {
          json(res, 400, { error: '"toolName" is required' });
          return;
        }
        const ctx: ToolContext = {
          agentId:     (req.headers['x-agent-id'] as string | undefined) ?? this.options.defaultCtx?.agentId ?? 'api-caller',
          traceId:     (req.headers['x-trace-id'] as string | undefined) ?? `trace-${Date.now()}`,
          depth:       Number(req.headers['x-depth'] ?? 0),
          hibaBaseUrl: this.options.defaultCtx?.hibaBaseUrl ?? 'http://localhost:8092',
          permissions: this.options.defaultCtx?.permissions ?? [],
        };
        const result = await this.options.toolbox.execute(
          body.toolName as never,
          body.input ?? {},
          ctx,
        );
        json(res, result.success ? 200 : 422, result);
        return;
      }

      if (method === 'POST' && urlPath === '/api/plan') {
        const body = (await readBody(req)) as { task?: string; ctx?: Partial<ToolContext> };
        if (!body.task?.trim()) {
          json(res, 400, { error: '"task" is required and must be non-empty' });
          return;
        }
        const ctx: ToolContext = {
          agentId:     (req.headers['x-agent-id'] as string | undefined) ?? this.options.defaultCtx?.agentId ?? 'claw-dashboard',
          traceId:     (req.headers['x-trace-id'] as string | undefined) ?? `trace-${Date.now()}`,
          depth:       Number(req.headers['x-depth'] ?? 0),
          hibaBaseUrl: this.options.defaultCtx?.hibaBaseUrl ?? 'http://localhost:8092',
          permissions: this.options.defaultCtx?.permissions ?? [],
          ...body.ctx,
        };
        const plan = await this.planning.plan(body.task, ctx);
        json(res, 200, plan);
        return;
      }

      // ── /api/run ─────────────────────────────────────────────────────────────

      if (method === 'POST' && urlPath === '/api/run') {
        if (!this.options.orchestrator) {
          json(res, 503, { error: 'Orchestrator not configured on this server' });
          return;
        }
        const body = (await readBody(req)) as { plan?: ExecutionPlan; ctx?: Partial<ToolContext> };
        if (!body.plan || !Array.isArray(body.plan.steps)) {
          json(res, 400, { error: '"plan" with a "steps" array is required' });
          return;
        }
        const ctx: ToolContext = {
          agentId:     (req.headers['x-agent-id'] as string | undefined) ?? this.options.defaultCtx?.agentId ?? 'orchestrator',
          traceId:     (req.headers['x-trace-id'] as string | undefined) ?? `trace-${Date.now()}`,
          depth:       Number(req.headers['x-depth'] ?? 0),
          hibaBaseUrl: this.options.defaultCtx?.hibaBaseUrl ?? 'http://localhost:9090',
          permissions: this.options.defaultCtx?.permissions ?? [],
          ...body.ctx,
        };
        const result = await this.options.orchestrator.run(body.plan, ctx);
        const status = result.failed > 0 && body.plan.supervisorPolicy === 'fail-fast' ? 422 : 200;
        json(res, status, result);
        return;
      }

      json(res, 404, { error: `${method} ${urlPath} not found` });
    } catch (e) {
      json(res, 500, { error: e instanceof Error ? e.message : String(e) });
    }
  }

  start(): Promise<void> {
    const port = this.options.port ?? 8090;
    return new Promise(resolve => {
      this.server.listen(port, () => {
        console.log(`[AgentServer] http://localhost:${port}`);
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.close(err => (err ? reject(err) : resolve()));
    });
  }
}
