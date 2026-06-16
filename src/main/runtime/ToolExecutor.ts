import { allTools } from "../tools";
import { toolPolicies, type ToolPolicy } from "../tools/policy";
import { toAppError } from "./errors";
import { createTraceId, previewTraceValue, recordTrace } from "./trace";

export type ToolApprovalRequest = {
  toolName: string;
  args: unknown;
  policy?: ToolPolicy;
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

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} 超时（${ms / 1000}s）`)), ms),
    ),
  ]);
}

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
    const tool = allTools.find((item) => item.name === toolName);
    if (!tool) {
      throw new Error(`工具 ${toolName} 不存在`);
    }

    if (policy?.requiresConfirmation && options.confirm) {
      const approved = await options.confirm({ toolName, args, policy });
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
    }

    const rawResult = await withTimeout(
      tool.invoke(args as Record<string, unknown>, { signal: options.signal }),
      options.timeoutMs ?? 45_000,
      `工具 ${toolName}`,
    );
    const result = String(rawResult);
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
