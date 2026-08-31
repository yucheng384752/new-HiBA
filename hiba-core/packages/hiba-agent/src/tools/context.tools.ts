import { z } from 'zod';
import { defineTool } from '../core/defineTool';
import type { HiBAToolbox } from '../core/HiBAToolbox';
import type { AuditTrail } from '../audit/AuditTrail';
import type { TopologyRegistry } from '../topology/TopologyRegistry';
import type { AccountingClient } from '../planning/NLPlanningService';

const DOMAINS = ['material', 'machine', 'man', 'method', 'env', 'orchestrator'] as const;

/**
 * 規格：實作規格/plan()_LLM生成品質改善與輕量RAG檢索設計.md §三。
 *
 * 目前狀態（規格階段基礎設施，尚未接進 plan()）：
 * - tools/nodes 候選集合尚未做真正的語意窄化——embedding 模型選型
 *   （nomic-embed-text vs bge-m3）與 36-tool 分布下的安全性驗證都還沒完成
 *   （見 plan_LLM_訓練清單.md §十七的限制、RAG 規格 §三/待確認清單）。
 *   這裡誠實回傳「依 domain 過濾、不裁切」的完整候選集，不假裝有窄化能力。
 * - exemplars 走 §六 定案的結構化 AuditTrail 查詢（域內最近成功案例），
 *   不是 §三 outputSchema 草案設想的 embedding-based {task, plan, score}
 *   形狀——現有 audit_trail 表本來就沒有保存原始 task 文字或完整 plan，
 *   無法重建那個形狀。這裡改用 AuditTrail.queryExemplars() 實際能提供的
 *   {traceId, toolName, toolDomain, executedAt}，語意相似任務檢索留給
 *   未來的 embedding-based ExemplarIndex。
 * - sopSnippets 不在本次範圍內（§五 SOP 全文擷取管線需要新增 PDF 解析依賴，
 *   須另外走安全基準線審查），此工具目前不回傳這個欄位。
 * - 呼叫方（未來的 plan()）在把這個工具接進 prompt 組裝之前，仍需要在
 *   candidate 數量過少時 fallback 回完整目錄——這是呼叫方的責任，不是這個
 *   工具本身要做的事（見 §三「plan() 的呼叫流程修正」）。
 */
export function registerContextRetrievalTools(
  toolbox: HiBAToolbox,
  deps: {
    topology: TopologyRegistry;
    audit: AuditTrail;
    accounting: AccountingClient;
  },
): void {
  const retrieveContext = defineTool({
    name: 'orchestrator.retrieveContext',
    version: '1.0.0',
    tags: ['orchestrator', 'read'],
    description: '依任務意圖動態檢索相關的工具/節點候選集合、產線拓樸關係與'
      + '歷史成功範例，供 plan() 縮小 LLM prompt 的候選範圍',
    inputSchema: z.object({
      intent: z.string().min(1).describe('使用者原始任務意圖文字（plan() 收到的 task）'),
      domains: z.array(z.enum(DOMAINS)).optional().describe('限定檢索的域，省略時全域檢索'),
      topK: z.object({
        tools: z.number().int().min(1).max(36).default(10),
        nodes: z.number().int().min(1).max(20).default(5),
        exemplars: z.number().int().min(0).max(10).default(3),
      }).optional(),
    }),
    outputSchema: z.object({
      tools: z.array(z.object({ name: z.string(), score: z.number() })),
      nodes: z.array(z.object({ nodeId: z.string(), score: z.number() })),
      topology: z.array(z.object({
        from: z.string(), relation: z.string(), to: z.string(),
      })),
      exemplars: z.array(z.object({
        traceId: z.string(), toolName: z.string(), toolDomain: z.string(), executedAt: z.string(),
      })),
    }),
    permissions: ['orchestrator.read'],
    timeout: 5_000,
    handler: async (input, _ctx) => {
      const topK = {
        tools: 10, nodes: 5, exemplars: 3,
        ...input.topK,
      };
      const domains = input.domains;

      const tools = toolbox.list()
        .filter(tool => domains === undefined || domains.includes(tool.name.split('.')[0] as typeof DOMAINS[number]))
        .map(tool => ({ name: tool.name, score: 1 }));

      const allNodes = await deps.accounting.listNodes();
      const nodes = allNodes
        .filter(node => node.status === 'online')
        .map(node => ({ nodeId: node.nodeId, score: 1 }));

      const topology = deps.topology.listApproved()
        .map(edge => ({ from: edge.fromNodeId, relation: edge.relation, to: edge.toNodeId }));

      const exemplars = topK.exemplars === 0
        ? []
        : domains === undefined
          ? await deps.audit.queryExemplars({ limit: topK.exemplars })
          : (await Promise.all(
              domains.map(domain => deps.audit.queryExemplars({
                toolDomain: domain,
                limit: Math.max(1, Math.ceil(topK.exemplars / domains.length)),
              })),
            )).flat().slice(0, topK.exemplars);

      return { tools, nodes, topology, exemplars };
    },
  });

  toolbox.register(retrieveContext);
}
