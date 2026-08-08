import { afterEach, expect, test } from '@jest/globals';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkflowStore } from './WorkflowStore';
import type { ExecutionPlan, ToolContext } from '../types/hiba.types';

const files: string[] = [];

afterEach(() => {
  for (const file of files.splice(0)) rmSync(file, { force: true });
});

test('reopening the store marks an active workflow interrupted without retrying it', () => {
  const file = join(tmpdir(), `hiba-workflow-${Date.now()}-${Math.random()}.db`);
  files.push(file, `${file}-shm`, `${file}-wal`);
  const plan: ExecutionPlan = {
    steps: [{
      stepId: 'S1', toolName: 'material.protectFile', nodeId: 'local', version: '1.0.0',
      input: { filePath: '/tmp/a' }, dependsOn: [],
    }],
    supervisorPolicy: 'fail-fast',
  };
  const ctx: ToolContext = {
    agentId: 'test', traceId: 'trace-restart', depth: 0,
    hibaBaseUrl: 'http://localhost:9090', permissions: [],
  };
  const first = new WorkflowStore(file);
  const workflow = first.create('test restart', plan, ctx);
  first.setStatus(workflow.workflowId, 'running');
  first.startStep(workflow.workflowId, 'S1');
  first.close();

  const second = new WorkflowStore(file);
  const reopened = second.get(workflow.workflowId);
  expect(reopened?.status).toBe('interrupted');
  expect(reopened?.steps[0]?.status).toBe('interrupted');
  expect(reopened?.steps[0]?.attempt).toBe(1);
  second.close();
});

test('workflow must be explicitly approved and records the approving user', () => {
  const store = new WorkflowStore(':memory:');
  const plan: ExecutionPlan = {
    steps: [],
    supervisorPolicy: 'fail-fast',
  };
  const ctx: ToolContext = {
    agentId: 'planner', traceId: 'trace-approval', depth: 0,
    hibaBaseUrl: 'http://localhost:9090', permissions: [],
  };
  const workflow = store.create('approval test', plan, ctx);

  const approved = store.approve(workflow.workflowId, 'user-42');

  expect(approved.status).toBe('approved');
  expect(approved.approvedBy).toBe('user-42');
  expect(approved.approvedAt).toBeTruthy();
  expect(() => store.approve(workflow.workflowId, 'user-43')).toThrow("Workflow is 'approved'");
  store.close();
});
