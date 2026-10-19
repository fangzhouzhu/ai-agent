import { getConversationMeta, getAgentProfile, type AgentProfile } from '../storage';

export function getEffectiveAgentProfile(conversationId?: string | null): AgentProfile | null {
  if (!conversationId) return null;
  const conversation = getConversationMeta(conversationId);
  if (!conversation) throw new Error('会话尚未保存，请重试发送。');
  if (!conversation.agentProfileId) return null;
  const agent = getAgentProfile(conversation.agentProfileId);
  if (!agent) throw new Error('当前智能体已被删除，请重新选择智能体。');
  return agent;
}
