import type { SkillConfig } from './storage';
import { matchSkillForInput, type ResolvedSkillMatch } from './skills';
import { isLocalActionQuery, isRealtimeFactQuery, shouldUseWebSearchForQuery, extractMathExpression } from './queryRouting';

function shouldUseAgentTools(message: string): boolean {
  return isLocalActionQuery(message);
}

function shouldUseRealtimeTool(message: string): boolean {
  return isRealtimeFactQuery(message);
}

function shouldUseWebSearchTool(message: string): boolean {
  return shouldUseWebSearchForQuery(message);
}

function shouldUseCalculatorTool(message: string): boolean { return extractMathExpression(message) !== null; }

function shouldUseAdvancedModel(message: string): boolean {
  const text = message.toLowerCase();
  const advancedIntentRegex =
    /(代码|编程|函数|组件|报错|错误|bug|调试|修复|重构|优化|架构|设计|分析|方案|总结|脚本|sql|正则|code|debug|fix|refactor|optimi[sz]e|architecture|analy[sz]e|plan)/;

  return (
    advancedIntentRegex.test(text) || message.length > 120 || /\n/.test(message)
  );
}

export type RouteDecision = {
  matchedSkill: ResolvedSkillMatch | null;
  skillAttachmentPaths: string[];
  useSkillAttachments: boolean;
  preferredScene: SkillConfig["preferredScene"] | "auto";
  useRealtimeTool: boolean;
  useWebSearchTool: boolean;
  useCalculatorTool: boolean;
  useTools: boolean;
  useAdvancedModel: boolean;
};

export function resolveRouteDecision(
  message: string,
  options?: {
    suppressToolsForRag?: boolean;
    useRag?: boolean;
    forceAgent?: boolean;
  },
  skills: SkillConfig[] = [],
): RouteDecision {
  const useRag = options?.useRag ?? false;
  const suppressToolsForRag = options?.suppressToolsForRag ?? useRag;
  const matchedSkill = matchSkillForInput(message, skills);
  const skillAttachmentPaths =
    matchedSkill?.skill.attachments
      ?.map((item) => item.path?.trim())
      .filter(Boolean) ?? [];
  const useSkillAttachments = !useRag && skillAttachmentPaths.length > 0;
  const preferredScene = matchedSkill?.skill.preferredScene ?? "auto";
  const toolChecksEnabled = !suppressToolsForRag;
  const useRealtimeTool = toolChecksEnabled && shouldUseRealtimeTool(message);
  const useWebSearchTool = toolChecksEnabled && shouldUseWebSearchTool(message);
  const useCalculatorTool =
    toolChecksEnabled && shouldUseCalculatorTool(message);

  let useTools =
    toolChecksEnabled &&
    (Boolean(options?.forceAgent) ||
      useRealtimeTool ||
      useWebSearchTool ||
      useCalculatorTool ||
      shouldUseAgentTools(message));
  let useAdvancedModel =
    !useRag &&
    (useTools ||
      Boolean(options?.forceAgent) ||
      shouldUseAdvancedModel(message));

  if (
    !useRag &&
    preferredScene === "chat" &&
    !useRealtimeTool &&
    !useWebSearchTool &&
    !useCalculatorTool &&
    !options?.forceAgent
  ) {
    useTools = false;
    useAdvancedModel = false;
  } else if (!useRag && (preferredScene === "agent" || options?.forceAgent)) {
    useTools = true;
    useAdvancedModel = true;
  }

  return {
    matchedSkill,
    skillAttachmentPaths,
    useSkillAttachments,
    preferredScene,
    useRealtimeTool,
    useWebSearchTool,
    useCalculatorTool,
    useTools,
    useAdvancedModel,
  };
}
