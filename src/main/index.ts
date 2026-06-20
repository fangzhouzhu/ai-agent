import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  app,
  shell,
  BrowserWindow,
  ipcMain,
  dialog,
  Menu,
  Tray,
  nativeImage,
} from "electron";
import { basename, join } from "path";
import { is } from "@electron-toolkit/utils";
import {
  chatWithAgent,
  chatStream,
  chatWithRag,
  fetchOllamaModels,
  getChatModel,
  getRagProvider,
  getAgentModel,
  getRagModel,
  applyModelSettings,
  getModelSettingsSnapshot,
  getChatProvider,
  getAgentProvider,
  describeRouteModel,
  type ChatMessage,
} from "./agent";
import { registerAppIpcHandlers } from "./ipc/registerAppIpc";
import { registerKnowledgeIpcHandlers } from "./ipc/registerKnowledgeIpc";
import { registerWorkbenchIpcHandlers } from "./ipc/registerWorkbenchIpc";
import {
  ingestFile,
  retrieveRelevantChunksByPaths,
} from "./rag";
import { retrieveFromKbs } from "./ragRetriever";
import { RAG_CITATION_PROMPT } from "./prompts/agentPrompts";
import { recordTrace } from "./runtime/trace";
import { writeAppLog } from "./runtime/logger";
import { executeTool } from "./runtime/ToolExecutor";
import { matchSkillForInput, type ResolvedSkillMatch } from "./skills";
import type { ToolApprovalRequest } from "./runtime/ToolExecutor";
import {
  isDirectCurrentTimeQuery,
  isKnowledgeBaseQuery,
  isLocalActionQuery,
  isRealtimeFactQuery,
  shouldUseWebSearchForQuery,
} from "./queryRouting";
import {
  type Task,
} from "./taskRunner";
import {
  getModelSettings,
  saveModelSettings,
  getSkills,
  getAgentProfile,
  getConversationMeta,
  getWechatBotSettings,
  saveWechatBotSettings,
  loadWechatBotMessages,
  saveWechatBotMessages,
  type AgentProfile,
  type WechatBotPanelMessage,
  type SkillConfig,
} from "./storage";
import {
  clearOfficialWeixinState,
  ensureOpenClawRuntimeInstalled,
  getOpenClawGatewayState,
  listLocalBotTokens,
  loadOfficialWeixinAccounts,
  restartOpenClawGateway,
  saveOfficialWeixinLogin,
  startOpenClawGateway,
  stopOpenClawGateway,
  writeOpenClawConfig,
} from "./openclawRuntime";

// 当前请求的 AbortController 和 WebContents 引用
type ChatRequestState = {
  controller: AbortController;
  webContents: Electron.WebContents;
};

let appTray: Tray | null = null;
let isQuitting = false;

function getTrayIconPath(): string {
  const fileName = process.platform === "win32" ? "icon.ico" : "icon.png";
  const candidates = [
    join(process.resourcesPath, fileName),
    join(app.getAppPath(), "build", fileName),
    join(__dirname, "../../build", fileName),
  ];

  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

function showPrimaryWindow(): void {
  const [mainWindow] = BrowserWindow.getAllWindows();
  if (!mainWindow) {
    createWindow();
    return;
  }

  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }

  mainWindow.show();
  mainWindow.focus();
}

function createTray(): void {
  if (appTray) return;

  const trayIcon = nativeImage.createFromPath(getTrayIconPath());
  appTray = new Tray(trayIcon);
  appTray.setToolTip("Centibot");
  appTray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: "打开",
        click: () => {
          showPrimaryWindow();
        },
      },
      {
        label: "退出",
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ]),
  );
  appTray.on("double-click", () => {
    showPrimaryWindow();
  });
}

function isSafeExternalUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

const chatRequests = new Map<string, ChatRequestState>();

type PendingToolApproval = {
  resolve: (approved: boolean) => void;
  conversationId: string;
};

type ChatModelDiagnostics = {
  routeMs?: number;
  firstToolCallMs?: number;
  toolCount?: number;
  toolTotalMs?: number;
  lastToolFinishedMs?: number;
  finalAnswerStartMs?: number;
  firstTokenMs?: number;
  totalMs?: number;
};

const pendingToolApprovals = new Map<string, PendingToolApproval>();

function resolvePendingApprovalsForConversation(
  conversationId: string,
  approved: boolean,
): void {
  for (const [requestId, pending] of pendingToolApprovals.entries()) {
    if (pending.conversationId !== conversationId) continue;
    pendingToolApprovals.delete(requestId);
    pending.resolve(approved);
  }
}

type WechatBotStatus = {
  status: "idle" | "waiting_scan" | "bound" | "error" | "unbound";
  message: string;
  qrcode?: string;
  qrContent?: string;
  qrDataUrl?: string;
  token?: string;
  botId?: string;
  userId?: string;
  nickname?: string;
  updatedAt: number;
};

type WechatBotMessage = WechatBotPanelMessage;

type ClawBotQrResponse = {
  ret?: number;
  qrcode?: string;
  qrcode_img_content?: string;
  msg?: string;
};

type ClawBotStatusResponse = {
  ret?: number;
  status?: string;
  token?: string;
  bot_id?: string;
  botId?: string;
  user_id?: string;
  userId?: string;
  nickname?: string;
  ilink_bot_id?: string;
  ilink_user_id?: string;
  bot_token?: string;
  baseurl?: string;
  redirect_host?: string;
  msg?: string;
};

type WechatLoginSession = {
  sessionKey: string;
  qrcode: string;
  qrContent: string;
  qrDataUrl: string;
  startedAt: number;
  currentApiBaseUrl: string;
};

let wechatBotStatus: WechatBotStatus = {
  status: "idle",
  message: "尚未绑定微信 ClawBot",
  updatedAt: Date.now(),
};
const wechatBotMessages: WechatBotMessage[] = loadWechatBotMessages();
let activeWechatLogin: WechatLoginSession | null = null;

const runtimeImport = new Function("specifier", "return import(specifier)") as (
  specifier: string,
) => Promise<any>;

function emitWechatBotUpdate(): void {
  const payload = {
    status: wechatBotStatus,
    messages: wechatBotMessages,
  };
  BrowserWindow.getAllWindows().forEach((win) => {
    if (!win.isDestroyed()) {
      win.webContents.send("wechat-bot:update", payload);
    }
  });
}

function updateWechatBotStatus(
  patch: Partial<WechatBotStatus>,
): WechatBotStatus {
  wechatBotStatus = {
    ...wechatBotStatus,
    ...patch,
    updatedAt: Date.now(),
  };
  emitWechatBotUpdate();
  return wechatBotStatus;
}

function appendWechatBotMessage(
  message: Omit<WechatBotMessage, "id" | "createdAt"> & {
    id?: string;
    createdAt?: number;
  },
): WechatBotMessage {
  const next: WechatBotMessage = {
    id: message.id ?? randomUUID(),
    createdAt: message.createdAt ?? Date.now(),
    ...message,
  };
  wechatBotMessages.push(next);
  if (wechatBotMessages.length > 80) {
    wechatBotMessages.splice(0, wechatBotMessages.length - 80);
  }
  saveWechatBotMessages(wechatBotMessages);
  emitWechatBotUpdate();
  return next;
}

function updateWechatBotMessage(
  id: string,
  patch:
    | Partial<WechatBotMessage>
    | ((message: WechatBotMessage) => WechatBotMessage),
): WechatBotMessage | null {
  const index = wechatBotMessages.findIndex((message) => message.id === id);
  if (index < 0) return null;

  const current = wechatBotMessages[index];
  const next =
    typeof patch === "function"
      ? patch(current)
      : {
          ...current,
          ...patch,
        };
  wechatBotMessages[index] = next;
  saveWechatBotMessages(wechatBotMessages);
  emitWechatBotUpdate();
  return next;
}

function getClawBotMessage(status: string): string {
  switch (String(status).toLowerCase()) {
    case "wait":
      return "请使用微信中的 ClawBot 扫描二维码完成绑定";
    case "scan":
    case "scanned":
    case "scaned":
      return "已扫码，请在微信中确认绑定";
    case "scaned_but_redirect":
      return "已扫码，正在跳转绑定服务";
    case "need_verifycode":
      return "绑定需要验证码，请在微信端继续完成";
    case "verify_code_blocked":
      return "验证码次数过多，请稍后重试";
    case "expired":
      return "二维码已过期，请刷新二维码";
    case "binded_redirect":
    case "confirm":
    case "confirmed":
    case "success":
    case "bind":
    case "bound":
      return "微信 ClawBot 已绑定";
    default:
      return status ? `ClawBot 状态：${status}` : "等待扫码绑定";
  }
}

function isClawBotBoundStatus(status?: string): boolean {
  return [
    "binded_redirect",
    "confirm",
    "confirmed",
    "success",
    "bind",
    "bound",
  ].includes(String(status ?? "").toLowerCase());
}

async function buildQrDataUrl(content: string): Promise<string> {
  const qrcode = await runtimeImport("qrcode");
  return qrcode.toDataURL(content, {
    margin: 1,
    scale: 8,
    errorCorrectionLevel: "M",
  });
}

function buildBoundWechatBotStatus(params: {
  token?: string;
  botId?: string;
  userId?: string;
  nickname?: string;
}): WechatBotStatus {
  return updateWechatBotStatus({
    status: "bound",
    message: params.nickname
      ? `微信 ClawBot 已绑定：${params.nickname}`
      : "微信 ClawBot 已绑定",
    token: params.token,
    botId: params.botId,
    userId: params.userId,
    nickname: params.nickname,
    qrcode: undefined,
    qrContent: undefined,
    qrDataUrl: undefined,
  });
}

async function refreshWechatBotQr(): Promise<WechatBotStatus> {
  try {
    writeOpenClawConfig();
    void ensureOpenClawRuntimeInstalled().catch((error) => {
      const message =
        error instanceof Error ? error.message : "OpenClaw 运行时安装失败";
      appendWechatBotMessage({
        role: "system",
        text: `OpenClaw 运行时安装失败：${message}`,
        status: "error",
        source: "system",
      });
    });

    const response = await fetch(
      "https://ilinkai.weixin.qq.com/ilink/bot/get_bot_qrcode?bot_type=3",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          local_token_list: listLocalBotTokens(),
        }),
      },
    );
    const payload = (await response.json()) as ClawBotQrResponse;

    if (
      !response.ok ||
      payload.ret !== 0 ||
      !payload.qrcode ||
      !payload.qrcode_img_content
    ) {
      const message =
        payload.msg || `ClawBot 二维码获取失败：HTTP ${response.status}`;
      saveWechatBotSettings({ status: "error", lastError: message });
      appendWechatBotMessage({
        role: "system",
        text: message,
        status: "error",
        source: "system",
      });
      return updateWechatBotStatus({ status: "error", message });
    }

    const qrDataUrl = await buildQrDataUrl(payload.qrcode_img_content);
    activeWechatLogin = {
      sessionKey: randomUUID(),
      qrcode: payload.qrcode,
      qrContent: payload.qrcode_img_content,
      qrDataUrl,
      startedAt: Date.now(),
      currentApiBaseUrl: "https://ilinkai.weixin.qq.com",
    };

    saveWechatBotSettings({
      enabled: false,
      qrcode: payload.qrcode,
      qrContent: payload.qrcode_img_content,
      token: "",
      botId: "",
      userId: "",
      nickname: "",
      status: "waiting_scan",
      lastError: "",
    });
    appendWechatBotMessage({
      role: "system",
      text: "已刷新微信 ClawBot 绑定二维码",
      status: "received",
      source: "system",
    });

    return updateWechatBotStatus({
      status: "waiting_scan",
      message: "请使用微信中的 ClawBot 扫描二维码完成绑定",
      qrcode: payload.qrcode,
      qrContent: payload.qrcode_img_content,
      qrDataUrl,
      token: undefined,
      botId: undefined,
      userId: undefined,
      nickname: undefined,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "ClawBot 二维码获取失败";
    saveWechatBotSettings({ status: "error", lastError: message });
    appendWechatBotMessage({
      role: "system",
      text: message,
      status: "error",
      source: "system",
    });
    return updateWechatBotStatus({ status: "error", message });
  }
}

async function checkWechatBotBinding(): Promise<WechatBotStatus> {
  const officialAccounts = loadOfficialWeixinAccounts();
  const savedSettings = getWechatBotSettings();

  if (officialAccounts.length > 0) {
    const current = officialAccounts[officialAccounts.length - 1];
    saveWechatBotSettings({
      enabled: true,
      token: current.token ?? savedSettings.token ?? "",
      botId: current.accountId,
      userId: current.userId ?? savedSettings.userId ?? "",
      nickname: savedSettings.nickname ?? "",
      status: "bound",
      lastError: "",
    });
    void startOpenClawGateway().catch((error) => {
      const message =
        error instanceof Error ? error.message : "OpenClaw Gateway 启动失败";
      appendWechatBotMessage({
        role: "system",
        text: message,
        status: "error",
        source: "system",
      });
      updateWechatBotStatus({ status: "error", message });
    });

    return buildBoundWechatBotStatus({
      token: current.token ?? savedSettings.token,
      botId: current.accountId,
      userId: current.userId ?? savedSettings.userId,
      nickname: savedSettings.nickname,
    });
  }

  const qrcode =
    activeWechatLogin?.qrcode || wechatBotStatus.qrcode || savedSettings.qrcode;
  if (!qrcode || !activeWechatLogin) {
    const status = savedSettings.status ?? wechatBotStatus.status ?? "idle";
    return updateWechatBotStatus({
      status,
      message:
        status === "unbound"
          ? "已解除微信 ClawBot 绑定"
          : "进入页面后会自动刷新二维码，请使用微信中的 ClawBot 扫码绑定",
      qrcode: undefined,
      qrContent: undefined,
      qrDataUrl: undefined,
      token: undefined,
      botId: undefined,
      userId: undefined,
      nickname: undefined,
    });
  }

  try {
    const response = await fetch(
      `${activeWechatLogin.currentApiBaseUrl}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}&bot_type=3`,
    );
    const payload = (await response.json()) as ClawBotStatusResponse;
    const remoteStatus = String(payload.status ?? "").toLowerCase();

    if (!response.ok || payload.ret !== 0) {
      const message =
        payload.msg || `ClawBot 状态查询失败：HTTP ${response.status}`;
      saveWechatBotSettings({ status: "error", lastError: message });
      return updateWechatBotStatus({ status: "error", message });
    }

    if (remoteStatus === "scaned_but_redirect" && payload.redirect_host) {
      activeWechatLogin.currentApiBaseUrl = `https://${payload.redirect_host}`;
    }

    if (remoteStatus === "confirmed" || remoteStatus === "binded_redirect") {
      const token = payload.bot_token ?? payload.token ?? savedSettings.token;
      const botId =
        payload.ilink_bot_id ??
        payload.bot_id ??
        payload.botId ??
        savedSettings.botId;
      const userId =
        payload.ilink_user_id ??
        payload.user_id ??
        payload.userId ??
        savedSettings.userId;
      const nickname = savedSettings.nickname;

      if (!botId) {
        const message = "ClawBot 绑定成功，但没有拿到 botId";
        saveWechatBotSettings({ status: "error", lastError: message });
        return updateWechatBotStatus({ status: "error", message });
      }

      saveOfficialWeixinLogin({
        accountId: botId,
        token,
        userId,
        baseUrl: payload.baseurl,
      });
      await restartOpenClawGateway();

      saveWechatBotSettings({
        enabled: true,
        token: token ?? "",
        botId,
        userId: userId ?? "",
        nickname: nickname ?? "",
        status: "bound",
        lastError: "",
      });
      activeWechatLogin = null;
      appendWechatBotMessage({
        role: "system",
        text: "微信 ClawBot 已完成绑定，消息将转发到 Centibot",
        status: "received",
        source: "system",
      });

      return buildBoundWechatBotStatus({
        token,
        botId,
        userId,
        nickname,
      });
    }

    if (isClawBotBoundStatus(remoteStatus)) {
      return buildBoundWechatBotStatus({
        token: savedSettings.token,
        botId: savedSettings.botId,
        userId: savedSettings.userId,
        nickname: savedSettings.nickname,
      });
    }

    return updateWechatBotStatus({
      status: "waiting_scan",
      message: getClawBotMessage(remoteStatus),
      qrcode: activeWechatLogin.qrcode,
      qrContent: activeWechatLogin.qrContent,
      qrDataUrl: activeWechatLogin.qrDataUrl,
      token: undefined,
      botId: undefined,
      userId: undefined,
      nickname: undefined,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "ClawBot 状态查询失败";
    saveWechatBotSettings({ status: "error", lastError: message });
    return updateWechatBotStatus({ status: "error", message });
  }
}

async function unbindWechatBot(): Promise<WechatBotStatus> {
  activeWechatLogin = null;
  clearOfficialWeixinState();
  stopOpenClawGateway();
  wechatBotMessages.splice(0, wechatBotMessages.length);
  saveWechatBotMessages(wechatBotMessages);

  saveWechatBotSettings({
    enabled: false,
    qrcode: "",
    qrContent: "",
    token: "",
    botId: "",
    userId: "",
    nickname: "",
    status: "unbound",
    lastError: "",
  });
  appendWechatBotMessage({
    role: "system",
    text: "已在本机解除微信 ClawBot 绑定",
    status: "received",
    source: "system",
  });
  return updateWechatBotStatus({
    status: "unbound",
    message: "已解除微信 ClawBot 绑定",
    token: undefined,
    botId: undefined,
    userId: undefined,
    nickname: undefined,
    qrcode: undefined,
    qrContent: undefined,
    qrDataUrl: undefined,
  });
}

function shouldUseAgentTools(message: string): boolean {
  return isLocalActionQuery(message);
}

function shouldUseRealtimeTool(message: string): boolean {
  return isRealtimeFactQuery(message);
}

function shouldDirectReturnCurrentTime(message: string): boolean {
  return isDirectCurrentTimeQuery(message);
}

function shouldUseWebSearchTool(message: string): boolean {
  return shouldUseWebSearchForQuery(message);
}

function shouldUseCalculatorTool(message: string): boolean {
  const compact = message.trim().replace(/[＝=？?\s]/g, "");
  return (
    Boolean(compact) &&
    /^[0-9+\-*/%^().,]+$/.test(compact) &&
    /[+\-*/%^]/.test(compact)
  );
}

function shouldUseAdvancedModel(message: string): boolean {
  const text = message.toLowerCase();
  const advancedIntentRegex =
    /(代码|编程|函数|组件|报错|错误|bug|调试|修复|重构|优化|架构|设计|分析|方案|总结|脚本|sql|正则|code|debug|fix|refactor|optimi[sz]e|architecture|analy[sz]e|plan)/;

  return (
    advancedIntentRegex.test(text) || message.length > 120 || /\n/.test(message)
  );
}

function isCasualChat(message: string): boolean {
  const compact = message.trim().toLowerCase();
  return /^(你好|您好|嗨|hi|hello|在吗|早上好|下午好|晚上好|谢谢|好的|ok|嗯|好)$/i.test(
    compact,
  );
}

function shouldUseKnowledgeBase(message: string): boolean {
  return isKnowledgeBaseQuery(message);
}

type RouteDecision = {
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

type KnowledgeRequestOptions = {
  kbIds?: string[];
  ragOnly?: boolean;
  minScore?: number;
  topK?: number;
  fallbackToChat?: boolean;
  citationRequired?: boolean;
};

function resolveRouteDecision(
  message: string,
  options?: {
    suppressToolsForRag?: boolean;
    useRag?: boolean;
    forceAgent?: boolean;
  },
): RouteDecision {
  const useRag = options?.useRag ?? false;
  const suppressToolsForRag = options?.suppressToolsForRag ?? useRag;
  const matchedSkill = matchSkillForInput(message, getSkills());
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

function buildRouteModelInfo(route: RouteDecision): {
  model: string;
  scene: string;
  skill?: string;
} {
  if (route.useSkillAttachments) {
    return {
      model: describeRouteModel("rag"),
      scene: "Skill \u8d44\u6599\u589e\u5f3a",
      skill: route.matchedSkill?.skill.name,
    };
  }

  if (route.useTools) {
    return {
      model: describeRouteModel("agent"),
      scene: "Agent/\u5de5\u5177",
      skill: route.matchedSkill?.skill.name,
    };
  }

  if (route.useAdvancedModel) {
    return {
      model: describeRouteModel("agent"),
      scene: "\u590d\u6742\u4efb\u52a1",
      skill: route.matchedSkill?.skill.name,
    };
  }

  return {
    model: describeRouteModel("chat"),
    scene: "\u666e\u901a\u5bf9\u8bdd",
    skill: route.matchedSkill?.skill.name,
  };
}

function getReadableError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err || "未知错误");
}

function buildKnowledgeBaseFailureMessage(err: unknown): string {
  const reason = getReadableError(err);
  return [
    "知识库检索已经触发，但模型服务没有成功返回回答。",
    "",
    `失败原因：${reason}`,
    "",
    "你可以检查当前模型/API 是否可用，或切换到本地 Ollama 模型后重试。",
  ].join("\n");
}

function getEffectiveAgentProfile(
  conversationId?: string | null,
): AgentProfile | null {
  const conversationMeta = conversationId
    ? getConversationMeta(conversationId)
    : null;
  const candidateId = conversationMeta?.agentProfileId;
  if (!candidateId) return null;
  return getAgentProfile(candidateId);
}

function createWindow(): void {
  const titleBarBackground = "#f4f8ff";
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1000,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: titleBarBackground,
      symbolColor: "#27406f",
      height: 40,
    },
    backgroundColor: "#f0f4ff",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  let windowShown = false;
  const showMainWindow = () => {
    if (windowShown || mainWindow.isDestroyed()) return;
    windowShown = true;
    mainWindow.show();
  };

  mainWindow.once("ready-to-show", showMainWindow);
  mainWindow.webContents.once("did-finish-load", showMainWindow);
  mainWindow.on("close", (event) => {
    if (isQuitting) return;
    event.preventDefault();
    mainWindow.hide();
  });

  mainWindow.webContents.setWindowOpenHandler((details) => {
    if (isSafeExternalUrl(details.url)) {
      void shell.openExternal(details.url);
    } else {
      writeAppLog("warn", "window", "Blocked external URL", {
        url: details.url,
      });
    }
    return { action: "deny" };
  });

  if (is.dev && process.env["ELECTRON_RENDERER_URL"]) {
    mainWindow.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

// IPC: 发送消息（流式）
ipcMain.handle(
  "chat:send",
  async (
    event,
    {
      history,
      message,
      conversationId,
      useAgent,
      fileIds,
      kbIds,
      ragOnly,
      minScore,
      topK,
      fallbackToChat,
      citationRequired,
    }: {
      history: ChatMessage[];
      message: string;
      conversationId?: string | null;
      useAgent: boolean;
      fileIds?: string[];
      kbIds?: string[];
      ragOnly?: boolean;
      minScore?: number;
      topK?: number;
      fallbackToChat?: boolean;
      citationRequired?: boolean;
    },
  ) => {
    const webContents = event.sender;
    const requestStartedAt = Date.now();
    const routeTraceId = randomUUID();

    // 中止上一次未完成的请求
    const requestConversationId = conversationId ?? randomUUID();
    if (chatRequests.has(requestConversationId)) {
      throw new Error("当前对话正在生成中，请先停止当前回复。");
    }
    const controller = new AbortController();
    chatRequests.set(requestConversationId, { controller, webContents });
    const { signal } = controller;
    let latestModelInfo: {
      model: string;
      scene: string;
      skill?: string;
      routeMs?: number;
      diagnostics?: ChatModelDiagnostics;
    } | null = null;
    let firstTokenSent = false;
    let firstToolCallAt: number | null = null;
    let currentToolStartedAt: number | null = null;
    let lastToolFinishedAt: number | null = null;
    let toolCount = 0;
    let toolTotalMs = 0;
    let routeLatencyMs: number | undefined;
    const publishDiagnostics = (patch: ChatModelDiagnostics) => {
      if (!latestModelInfo) return;
      latestModelInfo = {
        ...latestModelInfo,
        routeMs: patch.routeMs ?? latestModelInfo.routeMs,
        diagnostics: {
          ...(latestModelInfo.diagnostics ?? {}),
          ...patch,
        },
      };
      webContents.send("chat:model-info", {
        conversationId: requestConversationId,
        modelInfo: latestModelInfo,
      });
    };
    const emitToken = (token: string) => {
      const isFirstToken = !firstTokenSent && token.length > 0;
      const elapsedMs = isFirstToken
        ? Math.max(0, Date.now() - requestStartedAt)
        : undefined;
      if (isFirstToken) {
        firstTokenSent = true;
        if (latestModelInfo) {
          const finalAnswerStartMs =
            lastToolFinishedAt === null
              ? undefined
              : Math.max(0, Date.now() - lastToolFinishedAt);
          const nextModelInfo = {
            ...latestModelInfo,
            scene: `${latestModelInfo.scene} · 首字 ${elapsedMs} ms`,
          };
          latestModelInfo = nextModelInfo;
          webContents.send("chat:model-info", {
            conversationId: requestConversationId,
            modelInfo: nextModelInfo,
          });
          recordTrace({
            type: "first_token",
            traceId: routeTraceId,
            model: nextModelInfo.model,
            latencyMs: elapsedMs ?? 0,
            at: Date.now(),
          });
        }
      }
      webContents.send("chat:token", {
        conversationId: requestConversationId,
        token,
        ...(isFirstToken ? { isFirstToken: true, elapsedMs } : {}),
      });
    };
    const emitToolCall = (toolName: string, input: unknown) => {
      const now = Date.now();
      toolCount += 1;
      currentToolStartedAt = now;
      if (firstToolCallAt === null) {
        firstToolCallAt = now;
      }
      publishDiagnostics({
        firstToolCallMs:
          firstToolCallAt === null
            ? undefined
            : Math.max(0, firstToolCallAt - requestStartedAt),
        toolCount,
      });
      webContents.send("chat:tool-call", {
        conversationId: requestConversationId,
        toolName,
        input,
      });
    };
    const emitToolResult = (toolName: string, result: string) => {
      const now = Date.now();
      if (currentToolStartedAt !== null) {
        toolTotalMs += Math.max(0, now - currentToolStartedAt);
        currentToolStartedAt = null;
      }
      lastToolFinishedAt = now;
      webContents.send("chat:tool-result", {
        conversationId: requestConversationId,
        toolName,
        result,
      });
      publishDiagnostics({
        toolCount,
        toolTotalMs,
        lastToolFinishedMs: Math.max(0, now - requestStartedAt),
      });
    };
    const emitModelInfo = (modelInfo: {
      model: string;
      scene: string;
      skill?: string;
      routeMs?: number;
      diagnostics?: ChatModelDiagnostics;
    }) => {
      latestModelInfo = {
        ...modelInfo,
        diagnostics: {
          routeMs: modelInfo.routeMs,
          ...(modelInfo.diagnostics ?? {}),
        },
      };
      webContents.send("chat:model-info", {
        conversationId: requestConversationId,
        modelInfo: latestModelInfo,
      });
    };
    const emitDone = (status: "done" | "aborted" = "done") => {
      webContents.send("chat:done", {
        conversationId: requestConversationId,
        status,
      });
    };
    const emitError = (message: string) => {
      webContents.send("chat:error", {
        conversationId: requestConversationId,
        error: message,
      });
    };
    const requestToolApproval = (
      request: ToolApprovalRequest,
    ): Promise<boolean> =>
      new Promise<boolean>((resolve) => {
        const requestId = randomUUID();
        pendingToolApprovals.set(requestId, {
          resolve,
          conversationId: requestConversationId,
        });
        webContents.send("chat:tool-approval-request", {
          requestId,
          conversationId: requestConversationId,
          toolName: request.toolName,
          input: request.args,
          policy: request.policy,
        });
      });

    try {
      const activeAgent = getEffectiveAgentProfile(requestConversationId);
      const knowledgeOptions: KnowledgeRequestOptions = {
        kbIds,
        ragOnly,
        minScore,
        topK,
        fallbackToChat,
        citationRequired,
      };
      const effectiveKbIds =
        activeAgent?.knowledge.defaultKbIds ?? knowledgeOptions.kbIds ?? [];
      const effectiveRagOnly =
        activeAgent?.knowledge.ragOnly ?? knowledgeOptions.ragOnly ?? false;
      const effectiveMinScore =
        activeAgent?.knowledge.minScore ?? knowledgeOptions.minScore ?? 0.6;
      const effectiveTopK =
        activeAgent?.knowledge.topK ?? knowledgeOptions.topK ?? 6;
      const effectiveFallbackToChat =
        activeAgent?.knowledge.fallbackToChat ??
        knowledgeOptions.fallbackToChat ??
        !effectiveRagOnly;
      const forceAgent = useAgent || Boolean(activeAgent?.models.forceAgent);
      const useFileRag = Array.isArray(fileIds) && fileIds.length > 0;
      const hasSelectedKbs =
        Array.isArray(effectiveKbIds) && effectiveKbIds.length > 0;
      const useKbRag = hasSelectedKbs;
      const useRag = useFileRag || useKbRag;
      const route = resolveRouteDecision(message, {
        suppressToolsForRag: useRag,
        useRag,
        forceAgent,
      });
      const routeMs = Math.max(0, Date.now() - requestStartedAt);
      routeLatencyMs = routeMs;
      const {
        matchedSkill,
        skillAttachmentPaths,
        useSkillAttachments,
        useRealtimeTool,
        useTools,
        useAdvancedModel,
      } = route;

      const fallbackRoute = resolveRouteDecision(message, {
        suppressToolsForRag: false,
        useRag: false,
        forceAgent,
      });
      const fallbackRealtimeTool = fallbackRoute.useRealtimeTool;
      const fallbackUseTools = fallbackRoute.useTools;
      const fallbackUseAdvanced = fallbackRoute.useAdvancedModel;

      const effectiveHistory = useRealtimeTool ? [] : history;
      const runFallbackChat = async (reason: string) => {
        const fallbackModelInfo = {
          model: describeRouteModel(
            fallbackUseTools || fallbackUseAdvanced ? "agent" : "chat",
          ),
          scene: fallbackUseTools
            ? `Agent/工具（${reason}）`
            : fallbackUseAdvanced
              ? `复杂任务（${reason}）`
              : `通用（${reason}）`,
          skill: matchedSkill?.skill.name,
        };
        emitModelInfo({
          ...fallbackModelInfo,
          scene: `${fallbackModelInfo.scene} · 路由 ${routeMs} ms`,
          routeMs,
        });

        if (fallbackUseTools) {
          await chatWithAgent(
            fallbackRealtimeTool ? [] : history,
            message,
            emitToken,
            emitToolCall,
            emitToolResult,
            signal,
            matchedSkill?.skill,
            requestToolApproval,
          );
          return;
        }

        await chatStream(
          fallbackRealtimeTool ? [] : history,
          message,
          emitToken,
          signal,
          fallbackUseAdvanced ? getAgentModel() : getChatModel(),
          fallbackUseAdvanced ? getAgentProvider() : getChatProvider(),
          matchedSkill?.skill,
        );
      };

      const modelInfo = useRag
        ? {
            model: describeRouteModel("rag"),
            scene: useKbRag ? "知识库增强" : "RAG",
            skill: matchedSkill?.skill.name,
          }
        : useSkillAttachments
          ? {
              model: describeRouteModel("rag"),
              scene: "Skill 资料增强",
              skill: matchedSkill?.skill.name,
            }
          : useTools
            ? {
                model: describeRouteModel("agent"),
                scene: "Agent/工具",
                skill: matchedSkill?.skill.name,
              }
            : useAdvancedModel
              ? {
                  model: describeRouteModel("agent"),
                  scene: "复杂任务",
                  skill: matchedSkill?.skill.name,
                }
              : {
                  model: describeRouteModel("chat"),
                  scene: "通用",
                  skill: matchedSkill?.skill.name,
                };

      const decoratedModelInfo = {
        ...modelInfo,
        scene: `${modelInfo.scene} · 路由 ${routeMs} ms`,
        routeMs,
      };
      recordTrace({
        type: "route_decision",
        traceId: routeTraceId,
        route: decoratedModelInfo.scene,
        routeMs,
        forcedAgent: forceAgent,
        at: Date.now(),
      });
      emitModelInfo(decoratedModelInfo);
      if (
        !useRag &&
        !useSkillAttachments &&
        shouldDirectReturnCurrentTime(message)
      ) {
        const toolArgs = { timezone: "Asia/Shanghai", locale: "zh-CN" };
        emitToolCall("get_current_time", toolArgs);
        const toolExecution = await executeTool("get_current_time", toolArgs, {
          signal,
          confirm: requestToolApproval,
        });
        emitToolResult("get_current_time", toolExecution.result);
        emitToken(toolExecution.result);
        publishDiagnostics({
          routeMs,
          toolCount,
          toolTotalMs,
          totalMs: Math.max(0, Date.now() - requestStartedAt),
        });
        emitDone();
        return;
      }

      // 自动路由：文档问答 -> RAG 模型；工具/复杂任务 -> Agent 模型；其余 -> 普通对话模型
      if (useRag) {
        if (useKbRag) {
          // KB-based RAG: retrieve from persistent knowledge bases
          const chunks = await retrieveFromKbs(
            effectiveKbIds,
            message,
            effectiveTopK,
            effectiveMinScore,
          );

          // 没有命中时不要再把空上下文交给模型，避免看起来“命中了 RAG 但没有回答”。
          if (chunks.length === 0) {
            if (!effectiveRagOnly || effectiveFallbackToChat) {
              await runFallbackChat("知识库无结果");
            } else {
              emitToken(
                "没有在选中的知识库中找到足够相关的内容。你可以降低相关度阈值、换一种问法，或切换为“知识库优先”让模型在无结果时继续普通回答。",
              );
            }
          } else {
            const context = chunks
              .map(
                (c) =>
                  `[${c.index}] 来源：${c.source}（知识库：${c.kbName}，相关度：${c.score.toFixed(3)}）\n${c.content}`,
              )
              .join("\n\n---\n\n");
            const augmentedUserMessage = `请根据以下知识库内容直接回答问题。

先输出“回答”部分，给出明确、具体的答案，不要只输出依据或来源。
如果问题是在问人物会什么、有哪些技能、做过什么，请优先整理成要点列表。
回答时只使用知识库中能支持的内容，不要编造。

${RAG_CITATION_PROMPT}
“依据”小节必须放在正文之后，并列出每条证据所属的知识库名称。

请严格使用下面结构：
回答：
1. ...
2. ...

依据：
[1] 来源：...

知识库内容：
${context}

---

问题：${message}`;
            // 上下文已内嵌在用户消息中，直接用 chatStream 配合 RAG 模型，
            // 避免 chatWithRag 内部用空 fileIds 再次检索导致“当前没有激活的文档”
            try {
              await chatStream(
                effectiveHistory,
                augmentedUserMessage,
                emitToken,
                signal,
                getRagModel(),
                getRagProvider(),
                matchedSkill?.skill,
              );
            } catch (ragErr) {
              if (!effectiveRagOnly || effectiveFallbackToChat) {
                try {
                  await runFallbackChat("知识库回答失败，已回退");
                } catch {
                  emitToken(buildKnowledgeBaseFailureMessage(ragErr));
                }
              } else {
                emitToken(buildKnowledgeBaseFailureMessage(ragErr));
              }
            }
          }
        } else {
          await chatWithRag(
            effectiveHistory,
            message,
            fileIds ?? [],
            (token) => {
              emitToken(token);
            },
            signal,
            matchedSkill?.skill,
          );
        }
      } else if (useSkillAttachments) {
        try {
          const chunks = await retrieveRelevantChunksByPaths(
            skillAttachmentPaths,
            message,
          );

          if (chunks.length > 0) {
            const context = chunks
              .map(
                (chunk) =>
                  `[${chunk.index}] 来源：${chunk.source}\n${chunk.content}`,
              )
              .join("\n\n---\n\n");
            const augmentedUserMessage = `请优先依据以下 Skill 附带资料回答问题。

${RAG_CITATION_PROMPT}

Skill 资料内容：
${context}

---

问题：${message}`;

            await chatStream(
              effectiveHistory,
              augmentedUserMessage,
              (token) => {
                emitToken(token);
              },
              signal,
              getRagModel(),
              getRagProvider(),
              matchedSkill?.skill,
            );
          } else if (useTools) {
            await chatWithAgent(
              effectiveHistory,
              message,
              (token) => {
                emitToken(token);
              },
              (toolName, input) => {
                emitToolCall(toolName, input);
              },
              (toolName, result) => {
                emitToolResult(toolName, result);
              },
              signal,
              matchedSkill?.skill,
              requestToolApproval,
            );
          } else {
            await chatStream(
              effectiveHistory,
              message,
              (token) => {
                emitToken(token);
              },
              signal,
              useAdvancedModel ? getAgentModel() : getChatModel(),
              useAdvancedModel ? getAgentProvider() : getChatProvider(),
              matchedSkill?.skill,
            );
          }
        } catch {
          if (useTools) {
            await chatWithAgent(
              effectiveHistory,
              message,
              (token) => {
                emitToken(token);
              },
              (toolName, input) => {
                emitToolCall(toolName, input);
              },
              (toolName, result) => {
                emitToolResult(toolName, result);
              },
              signal,
              matchedSkill?.skill,
            );
          } else {
            await chatStream(
              effectiveHistory,
              message,
              (token) => {
                emitToken(token);
              },
              signal,
              useAdvancedModel ? getAgentModel() : getChatModel(),
              useAdvancedModel ? getAgentProvider() : getChatProvider(),
              matchedSkill?.skill,
            );
          }
        }
      } else if (useTools) {
        await chatWithAgent(
          effectiveHistory,
          message,
          (token) => {
            emitToken(token);
          },
          (toolName, input) => {
            emitToolCall(toolName, input);
          },
          (toolName, result) => {
            emitToolResult(toolName, result);
          },
          signal,
          matchedSkill?.skill,
          requestToolApproval,
        );
      } else {
        await chatStream(
          effectiveHistory,
          message,
          (token) => {
            emitToken(token);
          },
          signal,
          useAdvancedModel ? getAgentModel() : getChatModel(),
          useAdvancedModel ? getAgentProvider() : getChatProvider(),
          matchedSkill?.skill,
        );
      }
      publishDiagnostics({
        routeMs: routeLatencyMs,
        toolCount,
        toolTotalMs,
        totalMs: Math.max(0, Date.now() - requestStartedAt),
      });
      emitDone();
    } catch (err: any) {
      // AbortError 不是错误，发送 done 以保留已输出内容
      if (err?.name === "AbortError" || signal.aborted) {
        publishDiagnostics({
          routeMs: routeLatencyMs,
          toolCount,
          toolTotalMs,
          totalMs: Math.max(0, Date.now() - requestStartedAt),
        });
        emitDone("aborted");
      } else {
        emitError(err.message || "未知错误");
      }
    } finally {
      resolvePendingApprovalsForConversation(requestConversationId, false);
      const currentRequest = chatRequests.get(requestConversationId);
      if (currentRequest?.controller === controller) {
        chatRequests.delete(requestConversationId);
      }
    }
  },
);

// IPC: 中断当前请求
ipcMain.on("chat:abort", (_event, conversationId?: string | null) => {
  // 立即通知渲染进程停止，不等待流真正取消
  if (!conversationId) return;
  const request = chatRequests.get(conversationId);
  if (!request) return;
  resolvePendingApprovalsForConversation(conversationId, false);
  if (!request.webContents.isDestroyed()) {
    request.webContents.send("chat:done", {
      conversationId,
      status: "aborted",
    });
  }
  request.controller.abort();
  chatRequests.delete(conversationId);
});

// IPC: 获取模型列表
ipcMain.handle(
  "chat:tool-approval-response",
  (_event, payload: { requestId: string; approved: boolean }) => {
    const pending = pendingToolApprovals.get(payload.requestId);
    if (!pending) return false;
    pendingToolApprovals.delete(payload.requestId);
    pending.resolve(Boolean(payload.approved));
    return true;
  },
);

registerAppIpcHandlers();
registerKnowledgeIpcHandlers();
registerWorkbenchIpcHandlers({
  checkWechatBotBinding,
  refreshWechatBotQr,
  unbindWechatBot,
  wechatBotMessages,
});

// IPC: 获取完整模型/Provider 配置

// IPC: 保存完整模型/Provider 配置

// IPC: 测试在线 API 是否可用








ipcMain.handle("wechat-bot:send-message", async () => {
  throw new Error("微信机器人页面为只读同步视图，请在微信 ClawBot 中发消息。");
});


// IPC: 本地 Skills 配置


ipcMain.handle("skills:pick-files", async () => {
  const result = await dialog.showOpenDialog({
    properties: ["openFile", "multiSelections"],
    filters: [
      {
        name: "Documents",
        extensions: ["txt", "md", "pdf", "docx", "csv", "json", "ts", "js"],
      },
      { name: "All Files", extensions: ["*"] },
    ],
  });

  if (result.canceled || result.filePaths.length === 0) return [];

  return result.filePaths.map((filePath, index) => {
    let size = 0;
    try {
      size = statSync(filePath).size;
    } catch {
      size = 0;
    }

    return {
      id: randomUUID(),
      name: basename(filePath),
      path: filePath,
      size,
      uploadedAt: Date.now() + index,
    };
  });
});









// IPC: 选择并上传文档到 RAG 索引
ipcMain.handle("rag:pick-files", async (event) => {
  const result = await dialog.showOpenDialog({
    properties: ["openFile", "multiSelections"],
    filters: [
      {
        name: "Documents",
        extensions: ["txt", "md", "pdf", "docx", "csv", "json", "ts", "js"],
      },
      { name: "All Files", extensions: ["*"] },
    ],
  });

  if (result.canceled || result.filePaths.length === 0) {
    event.sender.send("rag:status", { status: "idle", message: "" });
    return [];
  }

  const total = result.filePaths.length;
  const uploaded = [];

  try {
    event.sender.send("rag:status", {
      status: "processing",
      current: 0,
      total,
      message:
        total > 1
          ? `已选择 ${total} 个文件，正在依次解析并建立索引...`
          : "文件已选择，正在解析并建立索引...",
    });

    for (let i = 0; i < total; i++) {
      const filePath = result.filePaths[i];
      event.sender.send("rag:status", {
        status: "processing",
        current: i + 1,
        total,
        fileName: basename(filePath),
        message: `正在分析 ${basename(filePath)}（${i + 1}/${total}）...`,
      });
      uploaded.push(await ingestFile(filePath));
    }

    event.sender.send("rag:status", {
      status: "completed",
      current: total,
      total,
      message:
        total > 1
          ? `已完成 ${total} 个文件的分析，现在可以开始提问。`
          : "文件分析完成，现在可以开始提问。",
    });

    return uploaded;
  } catch (error: any) {
    event.sender.send("rag:status", {
      status: "error",
      current: uploaded.length,
      total,
      message: error?.message || "文档分析失败，请稍后重试。",
    });
    throw new Error(
      error?.message ||
        "文档解析或向量化失败，请确认 Ollama 已安装并可用 `nomic-embed-text` 模型。",
    );
  }
});

// IPC: 查询当前已上传文档

// IPC: 删除单个已上传文档

// ---- 知识库 IPC ----

// 列出所有知识库

// 创建知识库

// 更新知识库

// 删除知识库（包含其所有文档和向量）

// 列出知识库中的文档

// 向知识库添加文档（通过文件选择器）

// 删除知识库中的单个文档

// 重建文档索引

// IPC: 切换聊天模型





// IPC: 获取当前聊天模型


// IPC: 切换 Agent / 工具模型

// IPC: 获取当前 Agent / 工具模型

// IPC: 切换 RAG 回答模型

// IPC: 获取当前 RAG 回答模型

// ---- 存储 IPC ----

// 获取对话列表（仅元数据）

// 加载单条对话的消息

// 保存单条对话（元数据 + 消息）

// 仅更新元数据（标题、时间戳）

// 删除对话

// 获取上次活跃 ID

// 保存活跃 ID

// ---- 任务 IPC ----

// 创建并执行任务（立即返回任务 ID，执行进度通过 task:update 事件推送）

// 列出所有任务

// 获取单个任务详情

// 取消运行中的任务

// 暂停运行中的任务

// 继续已暂停的任务

// 重新运行任务（清空步骤重跑）

// 删除任务记录




const CENTIBOT_AGENT_PORT = 18790;
let centibotAgentServer: ReturnType<typeof createServer> | null = null;

function focusPrimaryWindow(): void {
  showPrimaryWindow();
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    focusPrimaryWindow();
  });
}

type OpenAICompatibleMessage = {
  role: "system" | "user" | "assistant";
  content?: unknown;
};

type OpenAICompatibleRequest = {
  model?: string;
  messages?: OpenAICompatibleMessage[];
  stream?: boolean;
};

function normalizeOpenAIContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (!part || typeof part !== "object") return "";

      const record = part as Record<string, unknown>;
      if (typeof record.text === "string") return record.text;
      if (typeof record.content === "string") return record.content;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function stripOpenClawConversationMetadata(content: string): string {
  const text = content.trim();
  if (!text) return text;

  const metadataPattern =
    /^\[[^\]]+\]\s+Conversation info \(untrusted metadata\):\s*```json[\s\S]*?```\s*/i;
  const stripped = text.replace(metadataPattern, "").trim();

  return stripped || text;
}

function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        req.destroy(new Error("Request body too large"));
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function sendJson(
  res: ServerResponse,
  statusCode: number,
  payload: unknown,
): void {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "content-type, authorization",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  });
  res.end(JSON.stringify(payload));
}

function sendSseChunk(res: ServerResponse, payload: unknown): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

async function handleCentibotAgentRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method === "OPTIONS") {
    sendJson(res, 200, {});
    return;
  }

  const url = new URL(
    req.url ?? "/",
    `http://${req.headers.host ?? "127.0.0.1"}`,
  );

  if (req.method === "GET" && url.pathname === "/health") {
    sendJson(res, 200, { ok: true, name: "centibot-agent" });
    return;
  }

  if (
    req.method === "GET" &&
    (url.pathname === "/" || url.pathname === "/openclaw/agent.json")
  ) {
    sendJson(res, 200, {
      name: "Centibot Agent",
      id: "centibot-current",
      type: "openai-compatible",
      baseUrl: `http://127.0.0.1:${CENTIBOT_AGENT_PORT}/v1`,
      chatCompletionsUrl: `http://127.0.0.1:${CENTIBOT_AGENT_PORT}/v1/chat/completions`,
      modelsUrl: `http://127.0.0.1:${CENTIBOT_AGENT_PORT}/v1/models`,
      model: "centibot-current",
      apiKeyRequired: false,
      streaming: true,
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/v1/models") {
    sendJson(res, 200, {
      object: "list",
      data: [
        {
          id: "centibot-current",
          object: "model",
          created: 0,
          owned_by: "centibot",
        },
      ],
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/v1/models/centibot-current") {
    sendJson(res, 200, {
      id: "centibot-current",
      object: "model",
      created: 0,
      owned_by: "centibot",
    });
    return;
  }

  if (req.method !== "POST" || url.pathname !== "/v1/chat/completions") {
    sendJson(res, 404, { error: { message: "Not found" } });
    return;
  }

  try {
    const body = await readRequestBody(req);
    const payload = JSON.parse(body || "{}") as OpenAICompatibleRequest;
    const allMessages = (payload.messages ?? []).map((message) => ({
      role: message.role,
      content: normalizeOpenAIContent(message.content),
    }));
    const lastUser = [...allMessages]
      .reverse()
      .find((message) => message.role === "user");

    if (!lastUser?.content?.trim()) {
      sendJson(res, 400, { error: { message: "Missing user message" } });
      return;
    }

    const history = allMessages
      .slice(0, allMessages.lastIndexOf(lastUser))
      .filter(
        (message) => message.role === "user" || message.role === "assistant",
      )
      .map((message) => ({
        role: message.role,
        content: message.content,
      })) as ChatMessage[];
    const userText = stripOpenClawConversationMetadata(lastUser.content);
    const route = resolveRouteDecision(userText);
    const effectiveHistory = route.useRealtimeTool ? [] : history;
    const assistantMessageId = randomUUID();
    const responseStartedAt = Date.now();
    const wechatSettings = getWechatBotSettings();
    const wechatRouteOverride =
      wechatSettings.chatModel && wechatSettings.chatProvider
        ? {
            model: wechatSettings.chatModel,
            provider: wechatSettings.chatProvider,
          }
        : null;
    const modelInfo = wechatRouteOverride
      ? {
          model: `${wechatRouteOverride.model}（微信 Claw）`,
          scene: route.useTools
            ? "Agent/工具"
            : route.useAdvancedModel
              ? "复杂任务"
              : "通用",
          skill: route.matchedSkill?.skill.name,
        }
      : buildRouteModelInfo(route);

    appendWechatBotMessage({
      role: "user",
      text: userText,
      status: "received",
      source: "wechat",
    });
    appendWechatBotMessage({
      id: assistantMessageId,
      role: "assistant",
      text: "",
      status: "sent",
      source: "wechat",
      isStreaming: true,
      toolCalls: [],
      toolResults: [],
      modelInfo,
    });

    const finalizeWechatAssistant = (
      text: string,
      status: WechatBotMessage["status"] = "sent",
    ) => {
      updateWechatBotMessage(assistantMessageId, {
        text: text || "(空回复)",
        status,
        isStreaming: false,
        durationMs: Math.max(0, Date.now() - responseStartedAt),
      });
    };

    const appendWechatToolCall = (toolName: string, input: unknown) => {
      updateWechatBotMessage(assistantMessageId, (message) => ({
        ...message,
        toolCalls: [...(message.toolCalls ?? []), { toolName, input }],
      }));
    };

    const appendWechatToolResult = (toolName: string, result: string) => {
      updateWechatBotMessage(assistantMessageId, (message) => ({
        ...message,
        toolResults: [...(message.toolResults ?? []), { toolName, result }],
      }));
    };

    if (payload.stream) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "content-type, authorization",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      });

      const id = `chatcmpl-${randomUUID()}`;
      const created = Math.floor(Date.now() / 1000);
      const model = payload.model || "centibot-current";
      let replyText = "";
      const sendStop = () => {
        sendSseChunk(res, {
          id,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: "stop",
            },
          ],
        });
      };

      sendSseChunk(res, {
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [
          {
            index: 0,
            delta: { role: "assistant" },
            finish_reason: null,
          },
        ],
      });

      try {
        if (route.useTools) {
          await chatWithAgent(
            effectiveHistory,
            userText,
            (token) => {
              replyText += token;
              updateWechatBotMessage(assistantMessageId, { text: replyText });
              sendSseChunk(res, {
                id,
                object: "chat.completion.chunk",
                created,
                model,
                choices: [
                  {
                    index: 0,
                    delta: { content: token },
                    finish_reason: null,
                  },
                ],
              });
            },
            appendWechatToolCall,
            appendWechatToolResult,
            undefined,
            route.matchedSkill?.skill,
            undefined,
            wechatRouteOverride ?? undefined,
          );
        } else {
          await chatStream(
            effectiveHistory,
            userText,
            (token) => {
              replyText += token;
              updateWechatBotMessage(assistantMessageId, { text: replyText });
              sendSseChunk(res, {
                id,
                object: "chat.completion.chunk",
                created,
                model,
                choices: [
                  {
                    index: 0,
                    delta: { content: token },
                    finish_reason: null,
                  },
                ],
              });
            },
            undefined,
            wechatRouteOverride?.model ??
              (route.useAdvancedModel ? getAgentModel() : getChatModel()),
            wechatRouteOverride?.provider ??
              (route.useAdvancedModel ? getAgentProvider() : getChatProvider()),
            route.matchedSkill?.skill,
          );
        }

        finalizeWechatAssistant(replyText);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Centibot Agent failed";
        finalizeWechatAssistant(message, "error");
        sendSseChunk(res, {
          id,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [
            {
              index: 0,
              delta: { content: `\n\nCentibot Agent error: ${message}` },
              finish_reason: null,
            },
          ],
        });
      }

      sendStop();
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    let content = "";
    try {
      if (route.useTools) {
        await chatWithAgent(
          effectiveHistory,
          userText,
          (token) => {
            content += token;
            updateWechatBotMessage(assistantMessageId, { text: content });
          },
          appendWechatToolCall,
          appendWechatToolResult,
          undefined,
          route.matchedSkill?.skill,
          undefined,
          wechatRouteOverride ?? undefined,
        );
      } else {
        content = await chatStream(
          effectiveHistory,
          userText,
          () => {},
          undefined,
          wechatRouteOverride?.model ??
            (route.useAdvancedModel ? getAgentModel() : getChatModel()),
          wechatRouteOverride?.provider ??
            (route.useAdvancedModel ? getAgentProvider() : getChatProvider()),
          route.matchedSkill?.skill,
        );
        updateWechatBotMessage(assistantMessageId, { text: content });
      }

      finalizeWechatAssistant(content);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Centibot Agent failed";
      finalizeWechatAssistant(message, "error");
      throw error;
    }

    sendJson(res, 200, {
      id: `chatcmpl-${randomUUID()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: payload.model || "centibot-current",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content },
          finish_reason: "stop",
        },
      ],
    });
  } catch (error) {
    if (res.headersSent) {
      res.end();
      return;
    }

    sendJson(res, 500, {
      error: {
        message:
          error instanceof Error ? error.message : "Centibot Agent failed",
      },
    });
  }
}

function startCentibotAgentServer(): void {
  if (centibotAgentServer) return;

  centibotAgentServer = createServer((req, res) => {
    void handleCentibotAgentRequest(req, res);
  });

  centibotAgentServer.listen(CENTIBOT_AGENT_PORT, "127.0.0.1", () => {
    writeAppLog(
      "info",
      "server",
      `Centibot Agent listening at http://127.0.0.1:${CENTIBOT_AGENT_PORT}/v1/chat/completions`,
    );
    console.log(
      `Centibot Agent listening at http://127.0.0.1:${CENTIBOT_AGENT_PORT}/v1/chat/completions`,
    );
  });

  centibotAgentServer.on("error", (error) => {
    writeAppLog("error", "server", "Centibot Agent server failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    console.error("Centibot Agent server failed", error);
  });
}

process.on("uncaughtException", (error) => {
  writeAppLog("error", "process", "Uncaught exception", {
    error: error.message,
    stack: error.stack,
  });
});

process.on("unhandledRejection", (reason) => {
  writeAppLog("error", "process", "Unhandled rejection", {
    reason:
      reason instanceof Error
        ? { message: reason.message, stack: reason.stack }
        : reason,
  });
});

app.whenReady().then(async () => {
  writeAppLog("info", "app", "Application ready");
  const savedSettings = getModelSettings();
  applyModelSettings(savedSettings);

  const savedWechatBot = getWechatBotSettings();
  updateWechatBotStatus({
    status: savedWechatBot.status ?? (savedWechatBot.token ? "bound" : "idle"),
    message: savedWechatBot.token
      ? "微信 ClawBot 已绑定"
      : "进入页面后会自动刷新二维码，请使用微信中的 ClawBot 扫码绑定",
    qrcode: undefined,
    qrContent: undefined,
    qrDataUrl: undefined,
    token: savedWechatBot.token,
    botId: savedWechatBot.botId,
    userId: savedWechatBot.userId,
    nickname: savedWechatBot.nickname,
  });

  createWindow();
  createTray();
  startCentibotAgentServer();
  void checkWechatBotBinding();
  void fetchOllamaModels()
    .then(() => {
      saveModelSettings(getModelSettingsSnapshot());
    })
    .catch((error: unknown) => {
      writeAppLog("warn", "startup", "Fetch Ollama models after window creation failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });

  app.on("activate", function () {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
      return;
    }

    focusPrimaryWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  isQuitting = true;
  appTray?.destroy();
  appTray = null;
  centibotAgentServer?.close();
  centibotAgentServer = null;
  stopOpenClawGateway();
});
