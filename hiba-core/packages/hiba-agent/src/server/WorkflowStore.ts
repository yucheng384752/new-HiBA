import type { ExecutionPlan, ToolContext } from '../types/hiba.types';
import type { RunResult, StepResult } from './OrchestratorRunner';

type WorkflowStatus =
  | 'planned' | 'approved' | 'queued' | 'running' | 'succeeded'
  | 'partial_success' | 'failed' | 'interrupted';
type StepStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'interrupted';

interface SqliteStatement {
  run(...params: unknown[]): { changes: number };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

interface WorkflowRow {
  workflow_id: string;
  task: string;
  trace_id: string;
  status: WorkflowStatus;
  plan_json: string;
  result_json: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  approved_by: string | null;
  approved_at: string | null;
}

interface StepRow {
  step_id: string;
  status: StepStatus;
  node_id: string;
  tool_name: string;
  input_json: string;
  result_json: string | null;
  attempt: number;
  started_at: string | null;
  completed_at: string | null;
}

export interface StoredWorkflow {
  workflowId: string;
  task: string;
  traceId: string;
  status: WorkflowStatus;
  plan: ExecutionPlan;
  result: RunResult | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  approvedBy: string | null;
  approvedAt: string | null;
  steps: Array<{
    stepId: string;
    status: StepStatus;
    nodeId: string;
    toolName: string;
    input: Record<string, unknown>;
    result: StepResult | null;
    attempt: number;
    startedAt: string | null;
    completedAt: string | null;
  }>;
}

export class WorkflowStore {
  private readonly db: SqliteDatabase;

  constructor(dbPath: string) {
    const Database = require('better-sqlite3') as new (path: string) => SqliteDatabase;
    this.db = new Database(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workflows (
        workflow_id TEXT PRIMARY KEY,
        task TEXT NOT NULL,
        trace_id TEXT NOT NULL,
        status TEXT NOT NULL,
        plan_json TEXT NOT NULL,
        result_json TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        approved_by TEXT,
        approved_at TEXT
      );
      CREATE TABLE IF NOT EXISTS workflow_steps (
        workflow_id TEXT NOT NULL,
        step_id TEXT NOT NULL,
        status TEXT NOT NULL,
        node_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        input_json TEXT NOT NULL,
        result_json TEXT,
        attempt INTEGER NOT NULL DEFAULT 0,
        started_at TEXT,
        completed_at TEXT,
        PRIMARY KEY (workflow_id, step_id)
      );
    `);
    for (const sql of [
      'ALTER TABLE workflows ADD COLUMN approved_by TEXT',
      'ALTER TABLE workflows ADD COLUMN approved_at TEXT',
    ]) {
      try { this.db.exec(sql); } catch { /* column already exists */ }
    }
    const now = new Date().toISOString();
    this.db.prepare(`UPDATE workflows SET status = 'interrupted', updated_at = ? WHERE status IN ('queued','running')`).run(now);
    this.db.prepare(`UPDATE workflow_steps SET status = 'interrupted', completed_at = ? WHERE status = 'running'`).run(now);
  }

  create(task: string, plan: ExecutionPlan, ctx: ToolContext): StoredWorkflow {
    const now = new Date().toISOString();
    const workflowId = `wf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.db.prepare(`
      INSERT INTO workflows (workflow_id, task, trace_id, status, plan_json, result_json, error, created_at, updated_at)
      VALUES (?, ?, ?, 'planned', ?, NULL, NULL, ?, ?)
    `).run(
      workflowId, task, ctx.traceId, JSON.stringify(plan), now, now,
    );
    const insert = this.db.prepare(`
      INSERT INTO workflow_steps
        (workflow_id, step_id, status, node_id, tool_name, input_json)
      VALUES (?, ?, 'queued', ?, ?, ?)
    `);
    for (const step of plan.steps) {
      insert.run(workflowId, step.stepId, step.nodeId, step.toolName, JSON.stringify(step.input));
    }
    return this.get(workflowId)!;
  }

  get(workflowId: string): StoredWorkflow | null {
    const row = this.db.prepare('SELECT * FROM workflows WHERE workflow_id = ?').get(workflowId) as WorkflowRow | undefined;
    if (!row) return null;
    const steps = this.db.prepare('SELECT * FROM workflow_steps WHERE workflow_id = ? ORDER BY rowid').all(workflowId) as StepRow[];
    return {
      workflowId: row.workflow_id,
      task: row.task,
      traceId: row.trace_id,
      status: row.status,
      plan: JSON.parse(row.plan_json) as ExecutionPlan,
      result: row.result_json ? JSON.parse(row.result_json) as RunResult : null,
      error: row.error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      approvedBy: row.approved_by,
      approvedAt: row.approved_at,
      steps: steps.map(step => ({
        stepId: step.step_id,
        status: step.status,
        nodeId: step.node_id,
        toolName: step.tool_name,
        input: JSON.parse(step.input_json) as Record<string, unknown>,
        result: step.result_json ? JSON.parse(step.result_json) as StepResult : null,
        attempt: step.attempt,
        startedAt: step.started_at,
        completedAt: step.completed_at,
      })),
    };
  }

  setStatus(workflowId: string, status: WorkflowStatus, result?: RunResult, error?: string): void {
    this.db.prepare(`UPDATE workflows SET status = ?, result_json = ?, error = ?, updated_at = ? WHERE workflow_id = ?`).run(
      status, result ? JSON.stringify(result) : null, error ?? null, new Date().toISOString(), workflowId,
    );
  }

  updatePlan(workflowId: string, plan: ExecutionPlan): void {
    const workflow = this.get(workflowId);
    if (!workflow || workflow.status !== 'planned') throw new Error('Only planned workflows can be edited');
    this.db.prepare('UPDATE workflows SET plan_json = ?, updated_at = ? WHERE workflow_id = ?').run(
      JSON.stringify(plan), new Date().toISOString(), workflowId,
    );
    this.db.prepare('DELETE FROM workflow_steps WHERE workflow_id = ?').run(workflowId);
    const insert = this.db.prepare(`
      INSERT INTO workflow_steps
        (workflow_id, step_id, status, node_id, tool_name, input_json)
      VALUES (?, ?, 'queued', ?, ?, ?)
    `);
    for (const step of plan.steps) {
      insert.run(workflowId, step.stepId, step.nodeId, step.toolName, JSON.stringify(step.input));
    }
  }

  approve(workflowId: string, approvedBy: string): StoredWorkflow {
    const workflow = this.get(workflowId);
    if (!workflow) throw new Error('Workflow not found');
    if (workflow.status !== 'planned') throw new Error(`Workflow is '${workflow.status}'`);
    const approvedAt = new Date().toISOString();
    this.db.prepare(`
      UPDATE workflows SET status = 'approved', approved_by = ?, approved_at = ?, updated_at = ?
      WHERE workflow_id = ?
    `).run(approvedBy, approvedAt, approvedAt, workflowId);
    return this.get(workflowId)!;
  }

  startStep(workflowId: string, stepId: string): void {
    this.db.prepare(`
      UPDATE workflow_steps
      SET status = 'running', attempt = attempt + 1, started_at = ?, completed_at = NULL
      WHERE workflow_id = ? AND step_id = ?
    `).run(new Date().toISOString(), workflowId, stepId);
  }

  finishStep(workflowId: string, step: StepResult): void {
    this.db.prepare(`
      UPDATE workflow_steps
      SET status = ?, node_id = ?, result_json = ?, completed_at = ?
      WHERE workflow_id = ? AND step_id = ?
    `).run(
      step.result.success ? 'succeeded' : 'failed', step.nodeId, JSON.stringify(step),
      new Date().toISOString(), workflowId, step.stepId,
    );
  }

  skipStep(workflowId: string, stepId: string): void {
    this.db.prepare(`UPDATE workflow_steps SET status = 'skipped', completed_at = ? WHERE workflow_id = ? AND step_id = ?`).run(
      new Date().toISOString(), workflowId, stepId,
    );
  }

  prepareRetry(workflowId: string): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE workflow_steps SET status = 'queued', result_json = NULL, started_at = NULL, completed_at = NULL
      WHERE workflow_id = ? AND status IN ('failed','skipped','interrupted')
    `).run(workflowId);
    this.db.prepare(`UPDATE workflows SET status = 'queued', result_json = NULL, error = NULL, updated_at = ? WHERE workflow_id = ?`).run(now, workflowId);
  }

  close(): void {
    this.db.close();
  }
}
