import { basename } from "node:path";
import { dialog, ipcMain } from "electron";
import { listRagFiles, removeRagFile } from "../rag";
import {
  listKnowledgeBases,
  createKnowledgeBase,
  updateKnowledgeBase,
  deleteKnowledgeBase,
  listDocuments,
} from "../ragRepository";
import {
  ingestDocumentToKb,
  removeDocumentFromKb,
  rebuildDocumentIndex,
} from "../ragIndexer";
import { deleteKbVectors } from "../ragStore";

export function registerKnowledgeIpcHandlers(): void {
  ipcMain.handle("rag:list", () => {
    return listRagFiles();
  });

  ipcMain.handle("rag:remove", (_event, id: string) => {
    return removeRagFile(id);
  });

  ipcMain.handle("kb:list", () => {
    return listKnowledgeBases();
  });

  ipcMain.handle(
    "kb:create",
    (
      _event,
      data: {
        name: string;
        description?: string;
        chunkSize?: number;
        chunkOverlap?: number;
      },
    ) => {
      return createKnowledgeBase(data);
    },
  );

  ipcMain.handle(
    "kb:update",
    (_event, id: string, data: { name?: string; description?: string }) => {
      return updateKnowledgeBase(id, data);
    },
  );

  ipcMain.handle("kb:delete", async (_event, id: string) => {
    const docs = listDocuments(id);
    for (const doc of docs) {
      try {
        await removeDocumentFromKb(doc.id);
      } catch {
        // best-effort
      }
    }
    await deleteKbVectors(id);
    return deleteKnowledgeBase(id);
  });

  ipcMain.handle("kb:list-docs", (_event, kbId: string) => {
    return listDocuments(kbId);
  });

  ipcMain.handle("kb:add-files", async (event, kbId: string) => {
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

    const added = [];
    for (const filePath of result.filePaths) {
      try {
        const doc = await ingestDocumentToKb(kbId, filePath);
        added.push(doc);
      } catch (err: unknown) {
        event.sender.send("kb:indexing-progress", {
          docId: "",
          kbId,
          status: "failed",
          message: `${basename(filePath)}: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
    return added;
  });

  ipcMain.handle("kb:remove-doc", async (_event, docId: string) => {
    await removeDocumentFromKb(docId);
  });

  ipcMain.handle("kb:rebuild-doc", async (_event, docId: string) => {
    await rebuildDocumentIndex(docId);
  });
}
