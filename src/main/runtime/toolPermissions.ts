import { AsyncLocalStorage } from 'node:async_hooks';
import type { AgentProfile } from '../storage';
import { toolPolicies } from '../tools/policy';
import { describeWorkspaces } from './workspaces';

export type AgentToolPermissions = AgentProfile['tools'];
const permissions = new AsyncLocalStorage<AgentToolPermissions>();

// Empty allowlists admit all registered tools, subject to category gates.
export const defaultToolPermissions: AgentToolPermissions = {
  enabledToolNames: [], allowNetwork: true, allowWrite: true, allowDelete: true,
  requireConfirmationForRisky: true,
};

export function withToolPermissions<T>(value: AgentToolPermissions | undefined, work: () => Promise<T>): Promise<T> {
  const source = value ?? defaultToolPermissions;
  // Snapshot each run; never share mutable permission state across requests.
  return permissions.run({
    enabledToolNames: [...source.enabledToolNames],
    allowNetwork: source.allowNetwork === true,
    allowWrite: source.allowWrite === true,
    allowDelete: source.allowDelete === true,
    requireConfirmationForRisky: source.requireConfirmationForRisky !== false,
  }, work);
}

export function getToolPermissions(): AgentToolPermissions {
  return permissions.getStore() ?? defaultToolPermissions;
}

export function isToolAllowed(name: string): boolean {
  if (!Object.prototype.hasOwnProperty.call(toolPolicies, name)) return false;
  const policy = toolPolicies[name];
  if (!policy) return false;
  const current = getToolPermissions();
  if (current.enabledToolNames.length && !current.enabledToolNames.includes(name)) return false;
  return !(policy.risk ?? []).some(risk =>
    (risk === 'network' && !current.allowNetwork) ||
    (risk === 'write' && !current.allowWrite) ||
    (risk === 'delete' && !current.allowDelete));
}

export function assertToolAllowed(name: string): void {
  if (!isToolAllowed(name)) throw new Error(`当前智能体权限禁止调用工具：${name}`);
}

export function filterAllowedTools<T>(tools: T[], nameOf: (tool: T) => string): T[] {
  return tools.filter(tool => isToolAllowed(nameOf(tool)));
}

export function requiresToolConfirmation(name: string): boolean {
  const policy = toolPolicies[name];
  return Boolean(policy?.requiresConfirmation ||
    (getToolPermissions().requireConfirmationForRisky &&
      policy?.risk?.some(risk => ['write', 'delete', 'system'].includes(risk))));
}

export function describeAllowedTools(): string {
  const allowed = Object.values(toolPolicies).filter(policy => isToolAllowed(policy.name));
  if (!allowed.length) return '当前智能体没有获准的工具。请说明能力限制，不得声称已执行操作。';
  return '当前智能体获准的工具（未列出的工具禁止调用）：\n' + allowed.map(policy =>
    `- ${policy.name}: ${policy.risk.join(', ')}; ${requiresToolConfirmation(policy.name) ? '需要用户确认' : '可自动执行'}`,
  ).join('\n') + '\n' + describeWorkspaces();
}
