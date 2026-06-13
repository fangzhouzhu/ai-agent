import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { app } from "electron";

type OpenClawConfig = Record<string, unknown>;

type WeixinAccountData = {
  token?: string;
  baseUrl?: string;
  userId?: string;
  savedAt?: string;
};

type GatewayState = {
  running: boolean;
  installing: boolean;
  runtimeReady: boolean;
  lastError?: string;
  logs: string[];
};

const OPENCLAW_GATEWAY_PORT = 18789;
const OPENCLAW_GATEWAY_TOKEN = "centibot-openclaw-local";
const OPENCLAW_RUNTIME_PACKAGES = ["openclaw", "@tencent-weixin/openclaw-weixin"] as const;
const DEFAULT_WEIXIN_BASE_URL = "https://ilinkai.weixin.qq.com";
const MAX_LOG_LINES = 200;

let installPromise: Promise<void> | null = null;
let gatewayProcess: ChildProcessWithoutNullStreams | null = null;
let gatewayStartPromise: Promise<void> | null = null;
let gatewayState: GatewayState = {
  running: false,
  installing: false,
  runtimeReady: false,
  logs: [],
};

function windowsCommandShell(): string {
  return process.env.ComSpec || "C:\\Windows\\System32\\cmd.exe";
}

function windowsCommandArgs(command: string, args: string[]): string[] {
  const quoted = [command, ...args]
    .map((part) => {
      if (!part.includes(" ") && !part.includes('"')) return part;
      return `"${part.replace(/"/g, '\\"')}"`;
    })
    .join(" ");

  return ["/d", "/s", "/c", quoted];
}

function dataRoot(): string {
  const dir = join(app.getPath("userData"), "openclaw-runtime");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function getOpenClawRuntimeDir(): string {
  const dir = join(dataRoot(), "runtime");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function getOpenClawStateDir(): string {
  const dir = join(dataRoot(), "state");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function runtimePackageJsonPath(): string {
  return join(getOpenClawRuntimeDir(), "package.json");
}

function openClawEntryPath(): string {
  return join(getOpenClawRuntimeDir(), "node_modules", "openclaw", "openclaw.mjs");
}

function weixinPluginPath(): string {
  return join(
    getOpenClawRuntimeDir(),
    "node_modules",
    "@tencent-weixin",
    "openclaw-weixin",
  );
}

function openClawConfigPath(): string {
  return join(getOpenClawStateDir(), "openclaw.json");
}

function weixinStateDir(): string {
  const dir = join(getOpenClawStateDir(), "openclaw-weixin");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function weixinAccountsDir(): string {
  const dir = join(weixinStateDir(), "accounts");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function weixinAccountsIndexPath(): string {
  return join(weixinStateDir(), "accounts.json");
}

function appendGatewayLog(line: string): void {
  const text = line.trim();
  if (!text) return;

  gatewayState.logs.push(text);
  if (gatewayState.logs.length > MAX_LOG_LINES) {
    gatewayState.logs.splice(0, gatewayState.logs.length - MAX_LOG_LINES);
  }
}

function setGatewayError(message: string): void {
  gatewayState.lastError = message;
  appendGatewayLog(message);
}

function readJsonFile<T>(filePath: string, fallback: T): T {
  try {
    if (!existsSync(filePath)) return fallback;
    return JSON.parse(readFileSync(filePath, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

function writeJsonFile(filePath: string, data: unknown): void {
  writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}

function normalizeAccountId(value?: string | null): string {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return "default";

  const lowered = trimmed.toLowerCase();
  const valid = /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(trimmed);
  if (valid) return lowered;

  const normalized = lowered
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+/g, "")
    .replace(/-+$/g, "")
    .slice(0, 64);

  return normalized || "default";
}

function ensureRuntimePackageJson(): void {
  const filePath = runtimePackageJsonPath();
  if (existsSync(filePath)) return;

  writeJsonFile(filePath, {
    name: "centibot-openclaw-runtime",
    private: true,
  });
}

function spawnCommand(
  command: string,
  args: string[],
  options: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    onStdout?: (text: string) => void;
    onStderr?: (text: string) => void;
  },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(windowsCommandShell(), windowsCommandArgs(command, args), {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      windowsHide: true,
    });

    let stderr = "";

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      options.onStdout?.(text);
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      options.onStderr?.(text);
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new Error(
          stderr.trim() || `${command} ${args.join(" ")} failed with exit code ${code ?? -1}`,
        ),
      );
    });
  });
}

export async function ensureOpenClawRuntimeInstalled(): Promise<void> {
  if (existsSync(openClawEntryPath()) && existsSync(weixinPluginPath())) {
    gatewayState.runtimeReady = true;
    return;
  }

  if (installPromise) return installPromise;

  installPromise = (async () => {
    gatewayState.installing = true;
    ensureRuntimePackageJson();

    await spawnCommand(
      "npm.cmd",
      ["install", "--no-package-lock", "--silent", ...OPENCLAW_RUNTIME_PACKAGES],
      {
        cwd: getOpenClawRuntimeDir(),
        onStdout: appendGatewayLog,
        onStderr: appendGatewayLog,
      },
    );

    gatewayState.runtimeReady = true;
  })()
    .catch((error) => {
      gatewayState.runtimeReady = false;
      const message =
        error instanceof Error ? error.message : "Failed to install OpenClaw runtime";
      setGatewayError(message);
      throw error;
    })
    .finally(() => {
      gatewayState.installing = false;
      installPromise = null;
    });

  return installPromise;
}

function buildOpenClawConfig(): OpenClawConfig {
  const current = readJsonFile<OpenClawConfig>(openClawConfigPath(), {});
  const currentGateway = (current.gateway as Record<string, unknown> | undefined) ?? {};
  const currentModels = (current.models as Record<string, unknown> | undefined) ?? {};
  const currentProviders =
    (currentModels.providers as Record<string, unknown> | undefined) ?? {};
  const currentAgents = (current.agents as Record<string, unknown> | undefined) ?? {};
  const currentDefaults =
    (currentAgents.defaults as Record<string, unknown> | undefined) ?? {};
  const currentPlugins = (current.plugins as Record<string, unknown> | undefined) ?? {};
  const currentPluginLoad =
    (currentPlugins.load as Record<string, unknown> | undefined) ?? {};
  const currentPluginEntries =
    (currentPlugins.entries as Record<string, unknown> | undefined) ?? {};
  const currentChannels = (current.channels as Record<string, unknown> | undefined) ?? {};
  const currentWeixin =
    (currentChannels["openclaw-weixin"] as Record<string, unknown> | undefined) ?? {};

  return {
    ...current,
    gateway: {
      ...currentGateway,
      mode: "local",
      auth: {
        mode: "token",
        token: OPENCLAW_GATEWAY_TOKEN,
      },
      port: OPENCLAW_GATEWAY_PORT,
    },
    models: {
      ...currentModels,
      providers: {
        ...currentProviders,
        centibot: {
          api: "openai-completions",
          baseUrl: "http://127.0.0.1:18790/v1",
          apiKey: "centibot-local",
          contextWindow: 128000,
          maxTokens: 32000,
          models: [
            {
              id: "centibot-current",
              name: "Centibot Current",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128000,
              contextTokens: 96000,
              maxTokens: 32000,
            },
          ],
        },
      },
    },
    agents: {
      ...currentAgents,
      defaults: {
        ...currentDefaults,
        model: {
          primary: "centibot/centibot-current",
          fallbacks: [],
        },
      },
    },
    session: {
      dmScope: "per-account-channel-peer",
    },
    plugins: {
      ...currentPlugins,
      load: {
        ...currentPluginLoad,
        paths: [weixinPluginPath()],
      },
      entries: {
        ...currentPluginEntries,
        "openclaw-weixin": {
          ...(currentPluginEntries["openclaw-weixin"] as Record<string, unknown> | undefined),
          enabled: true,
        },
      },
    },
    channels: {
      ...currentChannels,
      "openclaw-weixin": {
        ...currentWeixin,
        dmPolicy: "open",
        allowFrom: ["*"],
      },
    },
  };
}

export function writeOpenClawConfig(): void {
  writeJsonFile(openClawConfigPath(), buildOpenClawConfig());
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function isOpenClawGatewayHealthy(): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${OPENCLAW_GATEWAY_PORT}/health`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) return false;

    const payload = (await response.json().catch(() => null)) as
      | { ok?: unknown; status?: unknown }
      | null;
    return payload?.ok === true || payload?.status === "live";
  } catch {
    return false;
  }
}

async function waitForOpenClawGatewayHealthy(timeoutMs = 25_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await isOpenClawGatewayHealthy()) return;
    await delay(500);
  }

  throw new Error("OpenClaw gateway did not become healthy in time");
}

function buildGatewayEnv(): NodeJS.ProcessEnv {
  const runtimeDir = getOpenClawRuntimeDir();
  const pathParts = [
    join(runtimeDir, "node_modules", ".bin"),
    process.env.PATH ?? "",
  ].filter(Boolean);

  return {
    ...process.env,
    OPENCLAW_STATE_DIR: getOpenClawStateDir(),
    OPENCLAW_CONFIG_PATH: openClawConfigPath(),
    OPENCLAW_GATEWAY_TOKEN,
    PATH: pathParts.join(";"),
  };
}

export async function startOpenClawGateway(): Promise<void> {
  if (gatewayProcess && !gatewayProcess.killed) return;
  if (gatewayStartPromise) return gatewayStartPromise;

  gatewayStartPromise = (async () => {
    await ensureOpenClawRuntimeInstalled();
    writeOpenClawConfig();

    if (await isOpenClawGatewayHealthy()) {
      gatewayState.running = true;
      gatewayState.lastError = undefined;
      appendGatewayLog("OpenClaw gateway already healthy; reusing existing process.");
      return;
    }

    gatewayProcess = spawn(
      windowsCommandShell(),
      windowsCommandArgs("npx.cmd", [
        "-y",
        "node@22",
        openClawEntryPath(),
        "gateway",
        "run",
        "--allow-unconfigured",
        "--port",
        String(OPENCLAW_GATEWAY_PORT),
        "--token",
        OPENCLAW_GATEWAY_TOKEN,
        "--force",
      ]),
      {
        cwd: getOpenClawRuntimeDir(),
        env: buildGatewayEnv(),
        windowsHide: true,
      },
    );

    gatewayProcess.stdout.on("data", (chunk) => {
      appendGatewayLog(chunk.toString());
    });

    gatewayProcess.stderr.on("data", (chunk) => {
      appendGatewayLog(chunk.toString());
    });

    gatewayProcess.on("error", (error) => {
      gatewayState.running = false;
      setGatewayError(error.message);
    });

    gatewayProcess.on("close", (code) => {
      gatewayState.running = false;
      gatewayProcess = null;
      if (code && code !== 0) {
        setGatewayError(`OpenClaw gateway exited with code ${code}`);
      }
    });

    await waitForOpenClawGatewayHealthy();
    gatewayState.running = true;
    gatewayState.lastError = undefined;
  })().finally(() => {
    gatewayStartPromise = null;
  });

  return gatewayStartPromise;
}

export function stopOpenClawGateway(): void {
  if (!gatewayProcess) return;
  gatewayProcess.kill();
  gatewayProcess = null;
  gatewayState.running = false;
}

export async function restartOpenClawGateway(): Promise<void> {
  stopOpenClawGateway();
  await startOpenClawGateway();
}

export function getOpenClawGatewayState(): GatewayState {
  return {
    ...gatewayState,
    logs: [...gatewayState.logs],
  };
}

export function listLocalBotTokens(): string[] {
  const ids = readJsonFile<string[]>(weixinAccountsIndexPath(), []);
  const tokens: string[] = [];

  for (let i = ids.length - 1; i >= 0 && tokens.length < 10; i -= 1) {
    const account = readJsonFile<WeixinAccountData | null>(
      join(weixinAccountsDir(), `${ids[i]}.json`),
      null,
    );
    const token = account?.token?.trim();
    if (token) tokens.push(token);
  }

  return tokens;
}

function saveWeixinAccountRecord(accountId: string, update: WeixinAccountData): void {
  mkdirSync(weixinAccountsDir(), { recursive: true });
  const normalizedId = normalizeAccountId(accountId);
  const filePath = join(weixinAccountsDir(), `${normalizedId}.json`);
  const existing = readJsonFile<WeixinAccountData>(filePath, {});
  const data: WeixinAccountData = {
    token: update.token?.trim() || existing.token,
    baseUrl: update.baseUrl?.trim() || existing.baseUrl || DEFAULT_WEIXIN_BASE_URL,
    userId: update.userId?.trim() || existing.userId,
    savedAt: new Date().toISOString(),
  };

  writeJsonFile(filePath, data);

  const ids = readJsonFile<string[]>(weixinAccountsIndexPath(), []);
  if (!ids.includes(normalizedId)) {
    writeJsonFile(weixinAccountsIndexPath(), [...ids, normalizedId]);
  }
}

function clearStaleAccountsForUser(currentAccountId: string, userId?: string): void {
  const trimmedUserId = userId?.trim();
  if (!trimmedUserId) return;

  const ids = readJsonFile<string[]>(weixinAccountsIndexPath(), []);
  const keptIds: string[] = [];

  for (const id of ids) {
    if (id === currentAccountId) {
      keptIds.push(id);
      continue;
    }

    const filePath = join(weixinAccountsDir(), `${id}.json`);
    const account = readJsonFile<WeixinAccountData | null>(filePath, null);
    if (account?.userId?.trim() === trimmedUserId) {
      try {
        unlinkSync(filePath);
      } catch {
        // ignore
      }
      continue;
    }

    keptIds.push(id);
  }

  writeJsonFile(weixinAccountsIndexPath(), keptIds);
}

export function saveOfficialWeixinLogin(params: {
  accountId: string;
  token?: string;
  userId?: string;
  baseUrl?: string;
}): { normalizedAccountId: string } {
  const normalizedAccountId = normalizeAccountId(params.accountId);

  saveWeixinAccountRecord(normalizedAccountId, {
    token: params.token,
    userId: params.userId,
    baseUrl: params.baseUrl,
  });
  clearStaleAccountsForUser(normalizedAccountId, params.userId);

  const config = buildOpenClawConfig();
  const channels = (config.channels as Record<string, unknown> | undefined) ?? {};
  const currentWeixin =
    (channels["openclaw-weixin"] as Record<string, unknown> | undefined) ?? {};

  writeJsonFile(openClawConfigPath(), {
    ...config,
    channels: {
      ...channels,
      "openclaw-weixin": {
        ...currentWeixin,
        channelConfigUpdatedAt: new Date().toISOString(),
      },
    },
  });

  return { normalizedAccountId };
}

export function clearOfficialWeixinState(): void {
  rmSync(weixinStateDir(), { recursive: true, force: true });
}

export function loadOfficialWeixinAccounts(): Array<{
  accountId: string;
  token?: string;
  userId?: string;
  baseUrl?: string;
}> {
  const ids = readJsonFile<string[]>(weixinAccountsIndexPath(), []);
  return ids.map((accountId) => {
    const data = readJsonFile<WeixinAccountData | null>(
      join(weixinAccountsDir(), `${accountId}.json`),
      null,
    );
    return {
      accountId,
      token: data?.token,
      userId: data?.userId,
      baseUrl: data?.baseUrl,
    };
  });
}

export { OPENCLAW_GATEWAY_PORT, OPENCLAW_GATEWAY_TOKEN };
