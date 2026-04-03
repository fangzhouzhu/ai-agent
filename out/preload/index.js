"use strict";
const electron = require("electron");
const api = {
  // 发送聊天消息
  sendMessage: (history, message, useAgent) => electron.ipcRenderer.invoke("chat:send", { history, message, useAgent }),
  // 流式 token
  onToken: (callback) => {
    const handler = (_, token) => callback(token);
    electron.ipcRenderer.on("chat:token", handler);
    return () => electron.ipcRenderer.removeListener("chat:token", handler);
  },
  // 工具调用通知
  onToolCall: (callback) => {
    const handler = (_, data) => callback(data);
    electron.ipcRenderer.on("chat:tool-call", handler);
    return () => electron.ipcRenderer.removeListener("chat:tool-call", handler);
  },
  // 工具结果通知
  onToolResult: (callback) => {
    const handler = (_, data) => callback(data);
    electron.ipcRenderer.on("chat:tool-result", handler);
    return () => electron.ipcRenderer.removeListener("chat:tool-result", handler);
  },
  // 完成通知
  onDone: (callback) => {
    const handler = () => callback();
    electron.ipcRenderer.on("chat:done", handler);
    return () => electron.ipcRenderer.removeListener("chat:done", handler);
  },
  // 错误通知
  onError: (callback) => {
    const handler = (_, err) => callback(err);
    electron.ipcRenderer.on("chat:error", handler);
    return () => electron.ipcRenderer.removeListener("chat:error", handler);
  },
  // 模型相关
  listModels: () => electron.ipcRenderer.invoke("models:list"),
  setModel: (modelName) => electron.ipcRenderer.invoke("models:set", modelName),
  getModel: () => electron.ipcRenderer.invoke("models:get"),
  // 中断当前请求
  abortChat: () => electron.ipcRenderer.send("chat:abort"),
  // ---- 存储 API ----
  storage: {
    // 获取所有对话元数据列表（轻量，用于侧边栏）
    list: () => electron.ipcRenderer.invoke("storage:list"),
    // 加载某条对话的消息（按需）
    load: (id) => electron.ipcRenderer.invoke("storage:load", id),
    // 保存整条对话（元数据 + 消息）
    save: (meta, messages) => electron.ipcRenderer.invoke("storage:save", meta, messages),
    // 只更新元数据（标题、时间戳）
    updateMeta: (meta) => electron.ipcRenderer.invoke("storage:update-meta", meta),
    // 删除对话
    delete: (id) => electron.ipcRenderer.invoke("storage:delete", id),
    // 活跃 ID
    getActive: () => electron.ipcRenderer.invoke("storage:get-active"),
    setActive: (id) => electron.ipcRenderer.invoke("storage:set-active", id)
  }
};
electron.contextBridge.exposeInMainWorld("electronAPI", api);
//# sourceMappingURL=index.js.map
