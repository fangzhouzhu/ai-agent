import { app, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { addWorkspace, listWorkspaces, updateWorkspace } from '../runtime/workspaces';
import { listFileRevisions, restoreFileRevision } from '../runtime/fileOperations';

function assertMainFrame(event: IpcMainInvokeEvent): void {
  if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame) throw new Error('只允许应用主窗口管理工作区授权。');
  const url = event.senderFrame.url;
  const developmentOrigin = process.env.ELECTRON_RENDERER_URL;
  const parsed = new URL(url);
  parsed.search = ''; parsed.hash = '';
  const ownRenderer = pathToFileURL(join(app.getAppPath(), 'out/renderer/index.html')).href;
  if (parsed.href !== ownRenderer && !(!app.isPackaged && developmentOrigin && parsed.origin === new URL(developmentOrigin).origin)) throw new Error('工作区授权请求来源无效。');
}

export function registerWorkspaceIpcHandlers(): void {
  ipcMain.handle('workspaces:list', event => { assertMainFrame(event); return listWorkspaces(); });
  ipcMain.handle('workspaces:pick', async event => {
    assertMainFrame(event);
    const selection = await dialog.showOpenDialog({ title: '授权 Agent 访问工作目录', properties: ['openDirectory'] });
    assertMainFrame(event);
    return selection.canceled || !selection.filePaths[0] ? listWorkspaces() : addWorkspace(selection.filePaths[0]);
  });
  ipcMain.handle('workspaces:update', (event, id: string, rights: { allowWrite: boolean; allowDelete: boolean } | null) => {
    assertMainFrame(event);
    if (typeof id !== 'string') throw new Error('工作区 ID 无效。');
    return updateWorkspace(id, rights);
  });
  ipcMain.handle('workspaces:revisions', event => { assertMainFrame(event); return listFileRevisions(); });
  ipcMain.handle('workspaces:restore-file', async (event, id: string) => {
    assertMainFrame(event);
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw new Error('恢复记录 ID 无效。');
    // The privileged confirmation is owned by main, not a renderer boolean.
    const revision = listFileRevisions().find(item => item.id === id);
    if (!revision) throw new Error('恢复记录不存在。');
    const answer = await dialog.showMessageBox({ type: 'warning', title: '恢复文件', message: '用备份恢复这个文件？当前文件会先另存一份恢复备份。', detail: revision.originalPath, buttons: ['取消', '恢复文件'], defaultId: 0, cancelId: 0, noLink: true });
    if (answer.response !== 1) return false;
    assertMainFrame(event);
    await restoreFileRevision(id);
    return true;
  });
}
