import type { SkillConfig } from "./storage";

export interface ResolvedSkillMatch {
  skill: SkillConfig;
  matchedKeywords: string[];
  reason: string;
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase();
}

function uniqueKeywords(keywords: string[]): string[] {
  return Array.from(
    new Set(
      keywords
        .map((item) => item.trim())
        .filter(Boolean)
        .map((item) => item.toLowerCase()),
    ),
  );
}

export function sortSkills(skills: SkillConfig[]): SkillConfig[] {
  return [...skills].sort(
    (a, b) => b.priority - a.priority || b.updatedAt - a.updatedAt,
  );
}

export function buildSkillPrompt(skill?: SkillConfig | null): string {
  if (!skill?.enabled) return "";

  const lines = [`当前已激活本地技能：${skill.name}。`];

  if (skill.description.trim()) {
    lines.push(`技能说明：${skill.description.trim()}`);
  }

  if (skill.systemPrompt.trim()) {
    lines.push(`请额外遵循以下技能要求：\n${skill.systemPrompt.trim()}`);
  }

  lines.push(
    "如果当前问题与该技能直接相关，请优先采用该技能的表达方式、结构和约束；如果不相关，则保持自然、准确、简洁地回答。",
  );

  return lines.join("\n");
}

export function matchSkillForInput(
  message: string,
  skills: SkillConfig[],
): ResolvedSkillMatch | null {
  const text = normalizeText(message);
  if (!text) return null;

  let best: {
    skill: SkillConfig;
    score: number;
    matchedKeywords: string[];
    reason: string;
  } | null = null;

  for (const skill of sortSkills(skills)) {
    if (!skill.enabled) continue;

    const skillName = normalizeText(skill.name);
    const keywords = uniqueKeywords(skill.keywords);
    const matchedKeywords = keywords.filter(
      (keyword) => keyword.length >= 2 && text.includes(keyword),
    );

    const explicitMatch =
      skillName.length >= 2 &&
      [text.includes(`#${skillName}`), text.includes(`【${skillName}】`)].some(
        Boolean,
      );
    const nameMatch = skillName.length >= 2 && text.includes(skillName);

    let score = 0;
    if (explicitMatch) score += 1000;
    if (nameMatch) score += 30;
    score += matchedKeywords.length * 12;

    if (score === 0) continue;

    score += Math.max(0, Math.min(skill.priority, 100)) / 100;

    const reason = explicitMatch
      ? `用户消息中显式指定了技能“${skill.name}”`
      : matchedKeywords.length > 0
        ? `命中关键词：${matchedKeywords.join("、")}`
        : `命中技能名：${skill.name}`;

    if (!best || score > best.score) {
      best = { skill, score, matchedKeywords, reason };
    }
  }

  if (!best) return null;

  return {
    skill: best.skill,
    matchedKeywords: best.matchedKeywords,
    reason: best.reason,
  };
}
