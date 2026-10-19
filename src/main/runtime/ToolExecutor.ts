import { allTools } from "../tools";
import { toolPolicies, type ToolPolicy } from "../tools/policy";
import { toAppError } from "./errors";
import { createTraceId, previewTraceValue, recordTrace } from "./trace";
import { runWithSignal } from './async';
import { withToolSignal } from './toolContext';
import { assertToolAllowed, requiresToolConfirmation } from './toolPermissions';
import { prepareFileOperation, validateFileOperation, backupFileOperation, withFileOperationLock } from './fileOperations';

export type ToolApprovalRequest = {
  toolName: string;
  args: unknown;
  policy?: ToolPolicy;
  preview?: string;
};

export type ToolExecutionOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
  confirm?: (request: ToolApprovalRequest) => Promise<boolean>;
};

export type ToolExecutionResult = {
  toolName: string;
  args: unknown;
  result: string;
  durationMs: number;
  policy?: ToolPolicy;
};

export async function executeTool(
  toolName: string,
  args: unknown,
  options: ToolExecutionOptions = {},
): Promise<ToolExecutionResult> {
  const traceId = createTraceId();
  const startedAt = Date.now();
  const policy = toolPolicies[toolName];

  recordTrace({
    type: "tool_start",
    traceId,
    tool: toolName,
    args,
    at: startedAt,
  });

  try {
    options.signal?.throwIfAborted();
    assertToolAllowed(toolName);
    const tool = allTools.find((item) => item.name === toolName);
    if (!tool) {
      throw new Error(`工具 ${toolName} 不存在`);
    }
    // Bind approval to a validated private copy, rather than mutable model args.
    const snapshot = JSON.parse(JSON.stringify(args ?? {}));
    const validatedArgs = tool.schema && 'parse' in tool.schema && typeof tool.schema.parse === 'function' ? tool.schema.parse(snapshot) : snapshot;
    const filePlan = prepareFileOperation(toolName, validatedArgs);
    const invocationArgs = filePlan?.args ?? validatedArgs;
    const changesExisting = filePlan?.accesses.some((item, index) => item.access !== 'read' && filePlan.states[index] !== 'missing');
    let confirmed = false;

    if (requiresToolConfirmation(toolName) || changesExisting) {
      if (!options.confirm) throw new Error(`工具 ${policy.displayName || toolName} 需要用户确认，当前执行入口不支持确认。`);
      const approved = await runWithSignal(() => options.confirm!({ toolName, args: JSON.parse(JSON.stringify(invocationArgs)), preview: filePlan?.preview, policy: policy && { ...policy, requiresConfirmation: true } }), { signal: options.signal });
      if (!approved) {
        const result = `已取消${policy.displayName || toolName}`;
        const durationMs = Date.now() - startedAt;

        recordTrace({
          type: "tool_end",
          traceId,
          tool: toolName,
          durationMs,
          resultPreview: previewTraceValue(result),
          at: Date.now(),
        });

        return { toolName, args, result, durationMs, policy };
      }
      confirmed = true;
    }

    options.signal?.throwIfAborted();
    let revisions: ReturnType<typeof backupFileOperation> = [];
    const rawResult = await runWithSignal(
      signal => {
        const invoke = async () => {
          signal.throwIfAborted();
          assertToolAllowed(toolName);
          if (requiresToolConfirmation(toolName) && !confirmed) throw new Error('工具确认策略已变化，请重新发起操作。');
          if (filePlan) {
            validateFileOperation(filePlan);
            revisions = backupFileOperation(filePlan, toolName);
          }
          return withToolSignal(signal, () => tool.invoke(invocationArgs as Record<string, unknown>, { signal }));
        };
        return filePlan ? withFileOperationLock(invoke) : invoke();
      },
      { signal: options.signal, timeoutMs: options.timeoutMs ?? 45_000, label: `工具 ${toolName}` },
    );
    const result = String(rawResult) + (revisions.length ? '\n修改前备份已保存，可在设置 → 工具权限 → 文件恢复中还原。' : '');
    const durationMs = Date.now() - startedAt;

    recordTrace({
      type: "tool_end",
      traceId,
      tool: toolName,
      durationMs,
      resultPreview: previewTraceValue(result),
      at: Date.now(),
    });

    return { toolName, args, result, durationMs, policy };
  } catch (error) {
    recordTrace({
      type: "error",
      traceId,
      error: toAppError(error, "tool", "TOOL_EXECUTION_FAILED"),
      at: Date.now(),
    });
    throw error;
  }
}
