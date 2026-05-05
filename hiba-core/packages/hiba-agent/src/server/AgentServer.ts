import http from 'node:http';
import type { NLPlanningService } from '../planning/NLPlanningService';
import type { ToolContext } from '../types/hiba.types';

// ── CORS ───────────────────────────────────────────────────────────────────────

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
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

// ── AgentServer ───────────────────────────────────────────────────────────────

export interface AgentServerOptions {
  port?: number;
  /** Injected into ToolContext for each /api/plan call */
  defaultCtx?: Partial<ToolContext>;
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
    const { method, url } = req;

    if (method === 'OPTIONS') {
      res.writeHead(204, CORS);
      res.end();
      return;
    }

    try {
      if (method === 'GET' && url === '/health') {
        json(res, 200, { status: 'ok', service: 'hiba-agent' });
        return;
      }

      if (method === 'GET' && url === '/api/resources') {
        const resources = await this.planning.getResources();
        json(res, 200, resources);
        return;
      }

      if (method === 'POST' && url === '/api/plan') {
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

      json(res, 404, { error: 'Not found' });
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
