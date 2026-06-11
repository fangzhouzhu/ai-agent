import { randomUUID } from "node:crypto";
import type { AppError } from "./errors";

export type AgentTraceEvent =
  | { type: "model_start"; traceId: string; model: string; messages: number; at: number }
  | { type: "model_end"; traceId: string; model: string; durationMs: number; at: number }
  | { type: "tool_start"; traceId: string; tool: string; args: unknown; at: number }
  | {
      type: "tool_end";
      traceId: string;
      tool: string;
      durationMs: number;
      resultPreview: string;
      at: number;
    }
  | { type: "error"; traceId: string; error: AppError; at: number };

const traces = new Map<string, AgentTraceEvent[]>();
const MAX_TRACES = 100;

export function createTraceId(): string {
  const traceId = randomUUID();
  traces.set(traceId, []);

  if (traces.size > MAX_TRACES) {
    const firstKey = traces.keys().next().value;
    if (firstKey) traces.delete(firstKey);
  }

  return traceId;
}

export function recordTrace(event: AgentTraceEvent): void {
  const events = traces.get(event.traceId) ?? [];
  events.push(event);
  traces.set(event.traceId, events);
}

export function getTrace(traceId: string): AgentTraceEvent[] {
  return traces.get(traceId) ?? [];
}

export function listTraces(): Array<{
  traceId: string;
  startedAt: number;
  updatedAt: number;
  eventCount: number;
  lastEventType: AgentTraceEvent["type"];
}> {
  return Array.from(traces.entries())
    .map(([traceId, events]) => {
      const first = events[0];
      const last = events[events.length - 1] ?? first;
      return {
        traceId,
        startedAt: first?.at ?? 0,
        updatedAt: last?.at ?? 0,
        eventCount: events.length,
        lastEventType: last?.type ?? "error",
      };
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function previewTraceValue(value: unknown, maxLength = 500): string {
  const text =
    typeof value === "string" ? value : JSON.stringify(value, null, 2) || String(value);
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}
