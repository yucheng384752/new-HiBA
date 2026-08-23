import http from 'node:http';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { NLPlanningService, NodeResourceMap } from '../planning/NLPlanningService';
import type { HiBAToolbox } from '../core/HiBAToolbox';
import type { ToolContext } from '../types/hiba.types';
import type { TrustRegistry, AgentRecord } from '../trust/TrustRegistry';
import type { OrchestratorRunner } from './OrchestratorRunner';
import type { ExecutionPlan } from '../types/hiba.types';
import type { WorkflowStore } from './WorkflowStore';
import { verifyCriticalEvent } from '../audit/AuditTrail';
import type { AuditTrail, CriticalEventType } from '../audit/AuditTrail';
import { validatePlan } from '../planning/validatePlan';
import { toToolSpec } from '../core/defineTool';
import { createToolFailure } from '../core/errors';
import type { HiBAErrorCode } from '../types/hiba.types';

// ── CORS ───────────────────────────────────────────────────────────────────────

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Trace-Id, X-Agent-Id, X-Depth, X-Node-Id, X-User-Id',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', ...CORS });
  res.end(JSON.stringify(body));
}

function jsonError(
  res: http.ServerResponse,
  status: number,
  code: HiBAErrorCode,
  message: string,
): void {
  json(res, status, createToolFailure(code, message));
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function txHashFor(scope: string, payload: unknown): string {
  return `0x${sha256Hex(`${scope}:${JSON.stringify(payload)}`)}`;
}

interface BlockchainFileRecord {
  filePath: string;
  fileHash: string;
  txHash: string;
  blockHash: string;
  blockNumber: number;
  contractAddress: string;
  chainId: number;
  protectedAt: string;
  metadata: Record<string, unknown>;
}

interface AuditAnchorRecord {
  anchoredAt: string;
  traceId: string;
  txHash: string;
  blockHash: string;
  blockNumber: number;
  contractAddress: string;
  chainId: number;
  records: unknown[];
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
  workflowStore?: WorkflowStore;
  auditTrail?: AuditTrail;
}

/**
 * Minimal HTTP server that exposes NLPlanningService over HTTP.
 * Designed for browser (Claw Dashboard) access with CORS enabled.
 *
 * Routes:
 *   GET  /health           → { status, service }
 *   GET  /api/resources    → NodeResourceMap (proxied from AccountingClient)
 *   POST /api/plan         → ExecutionPlan
 *   POST /api/summarize    → natural-language execution summary
 */
export class AgentServer {
  private readonly server: http.Server;
  private readonly blockchainFiles = new Map<string, BlockchainFileRecord>();
  private readonly auditAnchors: AuditAnchorRecord[] = [];
  private blockchainBlockNumber = 1;

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

      if (method === 'POST' && urlPath === '/api/update') {
        const body = (await readBody(req)) as { fileName?: string; content?: string; encoding?: 'utf8' | 'base64' };
        if (!body.fileName || basename(body.fileName) !== body.fileName) {
          jsonError(res, 400, 'REQUEST_INVALID', '"fileName" must be a plain file name');
          return;
        }
        if (typeof body.content !== 'string') {
          jsonError(res, 400, 'REQUEST_INVALID', '"content" is required');
          return;
        }

        const dir = process.env['HIBA_UPDATE_DIR'] ?? '.node-updates';
        const data = Buffer.from(body.content, body.encoding === 'base64' ? 'base64' : 'utf8');
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, body.fileName), data);
        json(res, 200, { accepted: true, fileName: body.fileName, bytes: data.byteLength });
        return;
      }

      if (method === 'POST' && urlPath === '/api/blockchain/protect') {
        const body = (await readBody(req)) as {
          filePath?: string;
          fileHash?: string;
          metadata?: Record<string, unknown>;
        };
        if (!body.filePath?.trim()) {
          jsonError(res, 400, 'REQUEST_INVALID', '"filePath" is required');
          return;
        }

        const fileHash = body.fileHash ?? sha256Hex(body.filePath);
        const txHash = txHashFor('file-protect', {
          filePath: body.filePath,
          fileHash,
          traceId: req.headers['x-trace-id'] ?? null,
        });
        const record: BlockchainFileRecord = {
          filePath: body.filePath,
          fileHash,
          txHash,
          blockHash: txHashFor('block', txHash),
          blockNumber: this.blockchainBlockNumber++,
          contractAddress: process.env['FILE_PROTECTION_CONTRACT_ADDRESS'] ?? 'mock-file-protection-contract',
          chainId: Number(process.env['BLOCKCHAIN_CHAIN_ID'] ?? 31337),
          protectedAt: new Date().toISOString(),
          metadata: body.metadata ?? {},
        };
        this.blockchainFiles.set(body.filePath, record);
        json(res, 200, { success: true, mode: 'mock', ...record });
        return;
      }

      if (method === 'POST' && urlPath === '/api/blockchain/verify') {
        const body = (await readBody(req)) as {
          filePath?: string;
          expectedHash?: string;
          fileHash?: string;
        };
        if (!body.filePath?.trim()) {
          jsonError(res, 400, 'REQUEST_INVALID', '"filePath" is required');
          return;
        }

        const record = this.blockchainFiles.get(body.filePath);
        const expectedHash = body.expectedHash ?? body.fileHash;
        const valid = record !== undefined && (expectedHash === undefined || record.fileHash === expectedHash);
        json(res, 200, {
          valid,
          isValid: valid,
          filePath: body.filePath,
          fileHash: record?.fileHash ?? null,
          expectedHash: expectedHash ?? null,
          txHash: record?.txHash ?? '',
          blockHash: record?.blockHash ?? '',
          blockNumber: record?.blockNumber ?? null,
          contractAddress: record?.contractAddress ?? null,
          chainId: record?.chainId ?? Number(process.env['BLOCKCHAIN_CHAIN_ID'] ?? 31337),
          mode: 'mock',
        });
        return;
      }

      if (method === 'POST' && urlPath === '/api/audit/anchor') {
        const body = (await readBody(req)) as { records?: unknown[] };
        if (!Array.isArray(body.records)) {
          jsonError(res, 400, 'REQUEST_INVALID', '"records" array is required');
          return;
        }

        const traceId = (req.headers['x-trace-id'] as string | undefined) ?? 'unknown';
        const txHash = txHashFor('audit-anchor', { traceId, records: body.records });
        const anchor: AuditAnchorRecord = {
          anchoredAt: new Date().toISOString(),
          traceId,
          txHash,
          blockHash: txHashFor('block', txHash),
          blockNumber: this.blockchainBlockNumber++,
          contractAddress: process.env['FILE_PROTECTION_CONTRACT_ADDRESS'] ?? 'mock-file-protection-contract',
          chainId: Number(process.env['BLOCKCHAIN_CHAIN_ID'] ?? 31337),
          records: body.records,
        };
        this.auditAnchors.push(anchor);
        json(res, 200, {
          anchored: body.records.length,
          traceId,
          txHash: anchor.txHash,
          blockHash: anchor.blockHash,
          blockNumber: anchor.blockNumber,
          contractAddress: anchor.contractAddress,
          chainId: anchor.chainId,
          mode: 'mock',
        });
        return;
      }

      if (method === 'GET' && urlPath === '/api/audit/anchor') {
        const params = new URLSearchParams((req.url ?? '').split('?')[1] ?? '');
        const traceId = params.get('traceId');
        json(res, 200, traceId ? this.auditAnchors.filter(a => a.traceId === traceId) : this.auditAnchors);
        return;
      }

      if (method === 'GET' && urlPath === '/api/audit/events') {
        if (!this.options.auditTrail) {
          jsonError(res, 503, 'SERVICE_UNAVAILABLE', 'Critical event audit is not configured');
          return;
        }
        const params = new URLSearchParams((req.url ?? '').split('?')[1] ?? '');
        const records = await this.options.auditTrail.queryEvents({
          ...(params.get('traceId') ? { traceId: params.get('traceId')! } : {}),
          ...(params.get('subjectId') ? { subjectId: params.get('subjectId')! } : {}),
          ...(params.get('eventType') ? { eventType: params.get('eventType') as CriticalEventType } : {}),
        });
        json(res, 200, records.map(record => ({
          ...record,
          integrityValid: verifyCriticalEvent(record),
        })));
        return;
      }

      // ── /api/agents ──────────────────────────────────────────────────────────

      if (urlPath === '/api/agents') {
        if (!this.options.registry) {
          jsonError(res, 503, 'SERVICE_UNAVAILABLE', 'Trust registry not configured on this server');
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
            jsonError(res, 400, 'REQUEST_INVALID', '"agentId", "role", and "publicKeyPem" are required');
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
          jsonError(res, 503, 'SERVICE_UNAVAILABLE', 'Trust registry not configured on this server');
          return;
        }
        if (method === 'GET') {
          const agent = await this.options.registry.lookup(agentId);
          if (!agent) { jsonError(res, 404, 'RESOURCE_NOT_FOUND', `Agent '${agentId}' not found`); return; }
          json(res, 200, agent);
          return;
        }
        if (method === 'DELETE') {
          try {
            await this.options.registry.revoke(agentId);
            json(res, 200, { agentId, status: 'revoked' });
          } catch {
            jsonError(res, 404, 'RESOURCE_NOT_FOUND', `Agent '${agentId}' not found`);
          }
          return;
        }
      }

      // ── /api/intent ──────────────────────────────────────────────────────────

      if (method === 'POST' && urlPath === '/api/intent') {
        const body = (await readBody(req)) as { text?: string };
        if (!body.text?.trim()) {
          jsonError(res, 400, 'REQUEST_INVALID', '"text" is required');
          return;
        }
        const resources = await this.planning.getResources();
        json(res, 200, parseIntent(body.text, resources));
        return;
      }

      if (method === 'GET' && urlPath === '/api/tools') {
        if (!this.options.toolbox) {
          jsonError(res, 503, 'SERVICE_UNAVAILABLE', 'Toolbox not configured on this server');
          return;
        }
        const tools = this.options.toolbox.list().map(toToolSpec);
        json(res, 200, tools);
        return;
      }

      if (method === 'POST' && urlPath === '/api/execute') {
        if (!this.options.toolbox) {
          jsonError(res, 503, 'SERVICE_UNAVAILABLE', 'Toolbox not configured on this server');
          return;
        }
        const body = (await readBody(req)) as { toolName?: string; input?: unknown };
        if (!body.toolName) {
          jsonError(res, 400, 'REQUEST_INVALID', '"toolName" is required');
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
          jsonError(res, 400, 'REQUEST_INVALID', '"task" is required and must be non-empty');
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
        if (this.options.workflowStore && !plan.error) {
          const workflow = this.options.workflowStore.create(body.task.trim(), plan, ctx);
          const event = await this.options.auditTrail?.recordEvent({
            eventType: 'WORKFLOW_CREATED',
            traceId: workflow.traceId,
            actorId: ctx.agentId,
            subjectId: workflow.workflowId,
            payload: workflow.plan,
            metadata: { stepCount: workflow.plan.steps.length },
          });
          json(res, 200, {
            ...plan,
            workflowId: workflow.workflowId,
            status: workflow.status,
            createdAt: workflow.createdAt,
            ...(event ? { eventHash: event.eventHash } : {}),
          });
        } else {
          json(res, 200, plan);
        }
        return;
      }

      if (method === 'POST' && urlPath === '/api/summarize') {
        const body = (await readBody(req)) as { task?: string; run?: unknown };
        if (!body.task?.trim() || body.run === undefined) {
          jsonError(res, 400, 'REQUEST_INVALID', '"task" and "run" are required');
          return;
        }
        json(res, 200, await this.planning.summarize(body.task.trim(), body.run));
        return;
      }

      const workflowMatch = urlPath.match(/^\/api\/workflows\/([^/]+)$/);
      if (method === 'GET' && workflowMatch) {
        const workflow = this.options.workflowStore?.get(decodeURIComponent(workflowMatch[1]!));
        json(res, workflow ? 200 : 404, workflow ?? { error: 'Workflow not found' });
        return;
      }

      const workflowApprovalMatch = urlPath.match(/^\/api\/workflows\/([^/]+)\/approve$/);
      if (method === 'POST' && workflowApprovalMatch) {
        const store = this.options.workflowStore;
        const audit = this.options.auditTrail;
        if (!store || !audit) {
          jsonError(res, 503, 'SERVICE_UNAVAILABLE', 'Workflow approval audit is not configured');
          return;
        }
        const workflowId = decodeURIComponent(workflowApprovalMatch[1]!);
        const workflow = store.get(workflowId);
        if (!workflow) { jsonError(res, 404, 'RESOURCE_NOT_FOUND', 'Workflow not found'); return; }
        if (workflow.status !== 'planned') { jsonError(res, 409, 'CONFLICT', `Workflow is '${workflow.status}'`); return; }
        const approvedBy = (req.headers['x-user-id'] as string | undefined)?.trim();
        if (!approvedBy) { jsonError(res, 400, 'REQUEST_INVALID', 'X-User-Id is required'); return; }
        const body = (await readBody(req)) as { plan?: ExecutionPlan };
        const candidatePlan = body.plan ?? workflow.plan;
        if (!Array.isArray(candidatePlan?.steps) || !this.options.toolbox) {
          jsonError(res, 400, 'REQUEST_INVALID', 'A valid workflow plan and toolbox are required');
          return;
        }
        const validation = validatePlan(candidatePlan, {
          tools: this.options.toolbox.list(),
          nodes: await this.planning.getNodes(),
        });
        if (!validation.valid) {
          json(res, 422, {
            ...createToolFailure('REQUEST_INVALID', 'Workflow plan validation failed'),
            validationIssues: validation.issues,
            missingInputs: validation.missingInputs,
          });
          return;
        }
        if (body.plan) store.updatePlan(workflowId, body.plan);
        const approved = store.approve(workflowId, approvedBy);
        const ctx = { ...this.contextFor(req, approvedBy), traceId: approved.traceId, agentId: approvedBy };
        const event = await audit.recordEvent({
          eventType: 'WORKFLOW_APPROVED',
          traceId: approved.traceId,
          actorId: approvedBy,
          subjectId: workflowId,
          payload: approved.plan,
          metadata: { stepCount: approved.plan.steps.length },
        });
        let anchor;
        let anchorError: string | undefined;
        try {
          anchor = await audit.batchUploadToChain([approved.traceId], ctx);
        } catch (error) {
          anchorError = error instanceof Error ? error.message : String(error);
        }
        json(res, 200, {
          workflowId,
          status: approved.status,
          approvedBy,
          approvedAt: approved.approvedAt,
          eventHash: event.eventHash,
          blockchain: anchor
            ? { ...anchor, anchored: true }
            : { anchored: false, ...(anchorError ? { error: anchorError } : {}) },
        });
        return;
      }

      const workflowRunMatch = urlPath.match(/^\/api\/workflows\/([^/]+)\/run$/);
      if (method === 'POST' && workflowRunMatch) {
        const workflowId = decodeURIComponent(workflowRunMatch[1]!);
        const store = this.options.workflowStore;
        if (!store || !this.options.orchestrator) {
          jsonError(res, 503, 'SERVICE_UNAVAILABLE', 'Persistent workflow execution is not configured');
          return;
        }
        const workflow = store.get(workflowId);
        if (!workflow) { jsonError(res, 404, 'RESOURCE_NOT_FOUND', 'Workflow not found'); return; }
        if (workflow.status !== 'approved') { jsonError(res, 409, 'CONFLICT', `Workflow must be approved before run; current status is '${workflow.status}'`); return; }
        const body = (await readBody(req)) as { plan?: ExecutionPlan };
        if (body.plan) { jsonError(res, 409, 'CONFLICT', 'Approved workflow plan cannot be changed during run'); return; }
        store.setStatus(workflowId, 'queued');
        this.executeWorkflow(workflowId, this.contextFor(req, 'orchestrator'));
        json(res, 202, { workflowId, status: 'queued' });
        return;
      }

      const workflowRetryMatch = urlPath.match(/^\/api\/workflows\/([^/]+)\/retry$/);
      if (method === 'POST' && workflowRetryMatch) {
        const workflowId = decodeURIComponent(workflowRetryMatch[1]!);
        const store = this.options.workflowStore;
        const workflow = store?.get(workflowId);
        if (!store || !this.options.orchestrator) { jsonError(res, 503, 'SERVICE_UNAVAILABLE', 'Persistent workflow execution is not configured'); return; }
        if (!workflow) { jsonError(res, 404, 'RESOURCE_NOT_FOUND', 'Workflow not found'); return; }
        if (!['failed', 'partial_success', 'interrupted'].includes(workflow.status)) {
          jsonError(res, 409, 'CONFLICT', `Workflow '${workflow.status}' cannot be retried`);
          return;
        }
        store.prepareRetry(workflowId);
        this.executeWorkflow(workflowId, this.contextFor(req, 'orchestrator'));
        json(res, 202, { workflowId, status: 'queued' });
        return;
      }

      // ── /api/run ─────────────────────────────────────────────────────────────

      if (method === 'POST' && urlPath === '/api/run') {
        if (!this.options.orchestrator) {
          jsonError(res, 503, 'SERVICE_UNAVAILABLE', 'Orchestrator not configured on this server');
          return;
        }
        const body = (await readBody(req)) as { plan?: ExecutionPlan; ctx?: Partial<ToolContext> };
        if (!body.plan || !Array.isArray(body.plan.steps)) {
          jsonError(res, 400, 'REQUEST_INVALID', '"plan" with a "steps" array is required');
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

      jsonError(res, 404, 'RESOURCE_NOT_FOUND', `${method} ${urlPath} not found`);
    } catch (e) {
      jsonError(res, 500, 'INTERNAL_ERROR', e instanceof Error ? e.message : String(e));
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

  private contextFor(req: http.IncomingMessage, defaultAgentId: string): ToolContext {
    return {
      agentId: (req.headers['x-agent-id'] as string | undefined) ?? this.options.defaultCtx?.agentId ?? defaultAgentId,
      traceId: (req.headers['x-trace-id'] as string | undefined) ?? `trace-${Date.now()}`,
      depth: Number(req.headers['x-depth'] ?? 0),
      hibaBaseUrl: this.options.defaultCtx?.hibaBaseUrl ?? 'http://localhost:9090',
      permissions: this.options.defaultCtx?.permissions ?? [],
    };
  }

  private executeWorkflow(workflowId: string, ctx: ToolContext): void {
    const store = this.options.workflowStore!;
    const orchestrator = this.options.orchestrator!;
    const workflow = store.get(workflowId)!;
    const completedSteps = workflow.steps
      .filter(step => step.status === 'succeeded' && step.result)
      .map(step => step.result!);
    store.setStatus(workflowId, 'running');
    void orchestrator.run(workflow.plan, { ...ctx, traceId: workflow.traceId }, {
      runId: workflowId,
      completedSteps,
      onStepStart: step => store.startStep(workflowId, step.stepId),
      onStepComplete: step => store.finishStep(workflowId, step),
      onStepSkipped: step => store.skipStep(workflowId, step.stepId),
    }).then(result => {
      const status = result.failed === 0
        ? 'succeeded'
        : result.succeeded > 0 ? 'partial_success' : 'failed';
      store.setStatus(workflowId, status, result, result.error);
    }).catch(error => {
      store.setStatus(workflowId, 'failed', undefined, error instanceof Error ? error.message : String(error));
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.close(err => (err ? reject(err) : resolve()));
    });
  }
}
