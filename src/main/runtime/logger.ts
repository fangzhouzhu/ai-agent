import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";

export type LogLevel = "info" | "warn" | "error";

type LogEntry = {
  at: string;
  level: LogLevel;
  scope: string;
  message: string;
  extra?: unknown;
};

function getLogRootDir(): string {
  const dir = join(app.getPath("userData"), "ai-agent", "logs");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function getDailyLogFileName(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `app-${year}-${month}-${day}.log`;
}

export function getLogDirectory(): string {
  return getLogRootDir();
}

export function getCurrentLogFilePath(): string {
  return join(getLogRootDir(), getDailyLogFileName());
}

export function writeAppLog(
  level: LogLevel,
  scope: string,
  message: string,
  extra?: unknown,
): void {
  const entry: LogEntry = {
    at: new Date().toISOString(),
    level,
    scope,
    message,
    ...(extra === undefined ? {} : { extra }),
  };

  try {
    appendFileSync(getCurrentLogFilePath(), `${JSON.stringify(entry)}\n`, "utf-8");
  } catch (error) {
    console.error("Failed to write local log", error);
  }
}
