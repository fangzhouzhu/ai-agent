import { app, dialog, ipcMain, shell } from "electron";
import { join } from "node:path";
import {
  getCurrentLogFilePath,
  getLogDirectory,
} from "../runtime/logger";
import { listTraces, getTrace } from "../runtime/trace";
import { listToolPolicies, updateToolPolicy } from "../tools/policy";
import {
  getSkills,
  saveSkills,
  getWechatBotSettings,
  saveWechatBotSettings,
  getKbUiState,
  saveKbUiState,
  createBackupSnapshot,
  restoreBackupSnapshot,
  type WechatBotSettings,
  type WechatBotPanelMessage,
  type SkillConfig,
} from "../storage";
import { getOpenClawGatewayState, restartOpenClawGateway } from "../openclawRuntime";

type WorkbenchIpcDependencies = {
  checkWechatBotBinding: () => Promise<unknown>;
  refreshWechatBotQr: () => Promise<unknown>;
  unbindWechatBot: () => Promise<unknown>;
  wechatBotMessages: WechatBotPanelMessage[];
};

export function registerWorkbenchIpcHandlers(
  dependencies: WorkbenchIpcDependencies,
): void {
  ipcMain.handle("settings:get-wechat-bot", async () => {
    return getWechatBotSettings();
  });

  ipcMain.handle(
    "settings:save-wechat-bot",
    async (_event, settings: WechatBotSettings) => {
      const normalized: WechatBotSettings = {
        enabled: Boolean(settings.enabled),
        token: settings.token?.trim() ?? "",
        chatModel: settings.chatModel?.trim() ?? "",
        chatProvider: settings.chatProvider,
        qrcode: settings.qrcode?.trim() ?? "",
        qrContent: settings.qrContent?.trim() ?? "",
        botId: settings.botId?.trim() ?? "",
        userId: settings.userId?.trim() ?? "",
        nickname: settings.nickname?.trim() ?? "",
        status: settings.status ?? "idle",
      };
      await saveWechatBotSettings(normalized);
      return getWechatBotSettings();
    },
  );

  ipcMain.handle("settings:refresh-wechat-bot-qr", async () => {
    return dependencies.refreshWechatBotQr();
  });

  ipcMain.handle("settings:get-wechat-bot-status", async () => {
    return dependencies.checkWechatBotBinding();
  });

  ipcMain.handle("settings:get-openclaw-gateway-state", async () => {
    return getOpenClawGatewayState();
  });

  ipcMain.handle("settings:restart-openclaw-gateway", async () => {
    await restartOpenClawGateway();
    return getOpenClawGatewayState();
  });

  ipcMain.handle("settings:unbind-wechat-bot", async () => {
    return dependencies.unbindWechatBot();
  });

  ipcMain.handle("wechat-bot:list-messages", async () => {
    return dependencies.wechatBotMessages;
  });

  ipcMain.handle("skills:list", async () => {
    return getSkills();
  });

  ipcMain.handle("skills:save", async (_event, skills: SkillConfig[]) => {
    await saveSkills(skills);
    return getSkills();
  });

  ipcMain.handle("tools:list-policies", () => listToolPolicies());

  ipcMain.handle(
    "tools:update-policy",
    (_event, name: string, requiresConfirmation: boolean) =>
      updateToolPolicy(name, requiresConfirmation),
  );

  ipcMain.handle("diagnostics:list-traces", () => listTraces());

  ipcMain.handle("diagnostics:get-trace", (_event, traceId: string) =>
    getTrace(traceId),
  );

  ipcMain.handle("diagnostics:get-log-info", () => ({
    directory: getLogDirectory(),
    currentFile: getCurrentLogFilePath(),
  }));

  ipcMain.handle("diagnostics:open-log-directory", async () => {
    const result = await shell.openPath(getLogDirectory());
    return { ok: result.length === 0, message: result };
  });

  ipcMain.handle("diagnostics:export-backup", async () => {
    const snapshot = createBackupSnapshot();
    const timestamp = new Date()
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\.\d{3}Z$/, "Z");
    const result = await dialog.showSaveDialog({
      title: "导出 Centibot 备份",
      defaultPath: join(
        app.getPath("documents"),
        `centibot-backup-${timestamp}.json`,
      ),
      filters: [{ name: "Centibot Backup", extensions: ["json"] }],
    });

    if (result.canceled || !result.filePath) {
      return { ok: false, message: "已取消导出" };
    }

    await app.whenReady();
    await import("node:fs/promises").then(({ writeFile }) =>
      writeFile(result.filePath!, JSON.stringify(snapshot, null, 2), "utf-8"),
    );

    return {
      ok: true,
      message: "备份导出成功",
      filePath: result.filePath,
      fileCount: snapshot.files.length,
    };
  });

  ipcMain.handle("diagnostics:import-backup", async () => {
    const result = await dialog.showOpenDialog({
      title: "导入 Centibot 备份",
      properties: ["openFile"],
      filters: [{ name: "Centibot Backup", extensions: ["json"] }],
    });

    if (result.canceled || result.filePaths.length === 0) {
      return { ok: false, message: "已取消导入" };
    }

    const selectedPath = result.filePaths[0];
    const raw = await import("node:fs/promises").then(({ readFile }) =>
      readFile(selectedPath, "utf-8"),
    );
    const parsed = JSON.parse(raw) as unknown;
    const restored = restoreBackupSnapshot(parsed);

    return {
      ok: true,
      message: "备份导入成功，重启应用后生效",
      filePath: selectedPath,
      fileCount: restored.fileCount,
      requiresRestart: true,
    };
  });

  ipcMain.handle("diagnostics:relaunch-app", () => {
    app.relaunch();
    app.exit(0);
  });

  ipcMain.handle("kb:get-ui-state", async () => {
    return getKbUiState();
  });

  ipcMain.handle(
    "kb:save-ui-state",
    async (_event, selectedIds: string[], ragOnly: boolean, minScore: number) => {
      await saveKbUiState(selectedIds, ragOnly, minScore);
    },
  );
}
