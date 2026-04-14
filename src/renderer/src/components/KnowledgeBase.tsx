import React, { useState, useEffect, useCallback, useRef } from 'react'
import styles from './KnowledgeBase.module.css'

type KnowledgeBase = {
  id: string
  name: string
  description: string
  embeddingModel: string
  chunkSize: number
  chunkOverlap: number
  docCount: number
  chunkCount: number
  createdAt: number
  updatedAt: number
}

type KbDocument = {
  id: string
  knowledgeBaseId: string
  fileName: string
  originalPath: string
  storedPath: string
  hash: string
  size: number
  status: 'pending' | 'parsing' | 'chunking' | 'embedding' | 'ready' | 'failed'
  chunkCount: number
  errorMessage?: string
  createdAt: number
  updatedAt: number
}

type KbIndexingProgress = {
  docId: string
  kbId: string
  status: string
  message: string
  progress?: number
}

interface Props {
  selectedKbIds: string[]
  onSelectionChange: (ids: string[]) => void
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

const statusLabel: Record<string, string> = {
  pending: '等待中',
  parsing: '解析中',
  chunking: '切片中',
  embedding: '向量化',
  ready: '已就绪',
  failed: '失败',
}

const statusColor: Record<string, string> = {
  pending: '#8b9dc3',
  parsing: '#f0a500',
  chunking: '#f0a500',
  embedding: '#4a90d9',
  ready: '#27ae60',
  failed: '#e74c3c',
}

const KnowledgeBasePanel: React.FC<Props> = ({ selectedKbIds, onSelectionChange }) => {
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBase[]>([])
  const [activeKbId, setActiveKbId] = useState<string | null>(null)
  const [documents, setDocuments] = useState<KbDocument[]>([])
  const [progressMap, setProgressMap] = useState<Record<string, KbIndexingProgress>>({})
  const [isAddingKb, setIsAddingKb] = useState(false)
  const [newKbName, setNewKbName] = useState('')
  const [newKbDesc, setNewKbDesc] = useState('')
  const [isLoadingDocs, setIsLoadingDocs] = useState(false)
  const [isAddingFiles, setIsAddingFiles] = useState(false)
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Load KB list
  const refreshKbs = useCallback(async () => {
    const kbs = await window.electronAPI.kb.list()
    setKnowledgeBases(kbs)
  }, [])

  // Load docs for active KB
  const refreshDocs = useCallback(async (kbId: string) => {
    setIsLoadingDocs(true)
    try {
      const docs = await window.electronAPI.kb.listDocs(kbId)
      setDocuments(docs)
    } finally {
      setIsLoadingDocs(false)
    }
  }, [])

  useEffect(() => {
    refreshKbs()
  }, [refreshKbs])

  useEffect(() => {
    if (activeKbId) {
      refreshDocs(activeKbId)
    } else {
      setDocuments([])
    }
  }, [activeKbId, refreshDocs])

  // Subscribe to indexing progress
  useEffect(() => {
    const unsub = window.electronAPI.kb.onIndexingProgress((data) => {
      setProgressMap((prev) => ({ ...prev, [data.docId]: data }))

      // Refresh docs list when any doc status changes
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current)
      refreshTimerRef.current = setTimeout(() => {
        if (activeKbId) refreshDocs(activeKbId)
        refreshKbs()
      }, 600)
    })
    return () => {
      unsub()
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current)
    }
  }, [activeKbId, refreshDocs, refreshKbs])

  const handleCreateKb = useCallback(async () => {
    if (!newKbName.trim()) return
    await window.electronAPI.kb.create({
      name: newKbName.trim(),
      description: newKbDesc.trim(),
    })
    setNewKbName('')
    setNewKbDesc('')
    setIsAddingKb(false)
    await refreshKbs()
  }, [newKbName, newKbDesc, refreshKbs])

  const handleDeleteKb = useCallback(
    async (kbId: string, e: React.MouseEvent) => {
      e.stopPropagation()
      if (!window.confirm('确定要删除该知识库及其所有文档和索引吗？')) return
      await window.electronAPI.kb.delete(kbId)
      if (activeKbId === kbId) setActiveKbId(null)
      onSelectionChange(selectedKbIds.filter((id) => id !== kbId))
      await refreshKbs()
    },
    [activeKbId, selectedKbIds, onSelectionChange, refreshKbs],
  )

  const handleToggleSelect = useCallback(
    (kbId: string, e: React.MouseEvent) => {
      e.stopPropagation()
      const next = selectedKbIds.includes(kbId)
        ? selectedKbIds.filter((id) => id !== kbId)
        : [...selectedKbIds, kbId]
      onSelectionChange(next)
    },
    [selectedKbIds, onSelectionChange],
  )

  const handleAddFiles = useCallback(async () => {
    if (!activeKbId) return
    setIsAddingFiles(true)
    try {
      await window.electronAPI.kb.addFiles(activeKbId)
      await refreshDocs(activeKbId)
      await refreshKbs()
    } finally {
      setIsAddingFiles(false)
    }
  }, [activeKbId, refreshDocs, refreshKbs])

  const handleRemoveDoc = useCallback(
    async (docId: string) => {
      if (!window.confirm('确定要从知识库中移除该文档吗？')) return
      await window.electronAPI.kb.removeDoc(docId)
      if (activeKbId) {
        await refreshDocs(activeKbId)
        await refreshKbs()
      }
    },
    [activeKbId, refreshDocs, refreshKbs],
  )

  const handleRebuildDoc = useCallback(
    async (docId: string) => {
      await window.electronAPI.kb.rebuildDoc(docId)
    },
    [],
  )

  const activeKb = knowledgeBases.find((k) => k.id === activeKbId) ?? null

  return (
    <div className={styles.container}>
      {/* Left panel: KB list */}
      <div className={styles.leftPanel}>
        <div className={styles.leftHeader}>
          <span className={styles.leftTitle}>知识库</span>
          <button
            className={styles.addKbBtn}
            onClick={() => setIsAddingKb(true)}
            title="新建知识库"
          >
            +
          </button>
        </div>

        {isAddingKb && (
          <div className={styles.newKbForm}>
            <input
              className={styles.newKbInput}
              placeholder="知识库名称"
              value={newKbName}
              onChange={(e) => setNewKbName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreateKb()
                if (e.key === 'Escape') setIsAddingKb(false)
              }}
              autoFocus
            />
            <input
              className={styles.newKbInput}
              placeholder="描述（可选）"
              value={newKbDesc}
              onChange={(e) => setNewKbDesc(e.target.value)}
            />
            <div className={styles.newKbActions}>
              <button className={styles.confirmBtn} onClick={handleCreateKb}>
                创建
              </button>
              <button className={styles.cancelBtn} onClick={() => setIsAddingKb(false)}>
                取消
              </button>
            </div>
          </div>
        )}

        <div className={styles.kbList}>
          {knowledgeBases.length === 0 && (
            <div className={styles.emptyHint}>暂无知识库，点击 + 创建</div>
          )}
          {knowledgeBases.map((kb) => (
            <div
              key={kb.id}
              className={`${styles.kbItem} ${activeKbId === kb.id ? styles.kbItemActive : ''}`}
              onClick={() => setActiveKbId(kb.id === activeKbId ? null : kb.id)}
            >
              <div className={styles.kbItemTop}>
                <span className={styles.kbIcon}>📚</span>
                <span className={styles.kbName}>{kb.name}</span>
                <div className={styles.kbItemActions}>
                  <button
                    className={`${styles.selectBtn} ${selectedKbIds.includes(kb.id) ? styles.selectBtnActive : ''}`}
                    onClick={(e) => handleToggleSelect(kb.id, e)}
                    title={selectedKbIds.includes(kb.id) ? '取消选用（聊天时不使用）' : '选用（聊天时使用）'}
                  >
                    {selectedKbIds.includes(kb.id) ? '✓' : '○'}
                  </button>
                  <button
                    className={styles.deleteKbBtn}
                    onClick={(e) => handleDeleteKb(kb.id, e)}
                    title="删除知识库"
                  >
                    ✕
                  </button>
                </div>
              </div>
              <div className={styles.kbStats}>
                {kb.docCount} 个文档 · {kb.chunkCount} 个片段
              </div>
            </div>
          ))}
        </div>

        {selectedKbIds.length > 0 && (
          <div className={styles.activeNotice}>
            ✓ 已选 {selectedKbIds.length} 个知识库用于聊天
          </div>
        )}
      </div>

      {/* Right panel: document list */}
      <div className={styles.rightPanel}>
        {!activeKb ? (
          <div className={styles.noKbSelected}>
            <div className={styles.noKbIcon}>📚</div>
            <div className={styles.noKbText}>选择左侧知识库查看文档</div>
          </div>
        ) : (
          <>
            <div className={styles.rightHeader}>
              <div className={styles.rightTitle}>
                <span>{activeKb.name}</span>
                {activeKb.description && (
                  <span className={styles.rightDesc}>{activeKb.description}</span>
                )}
              </div>
              <button
                className={styles.addFileBtn}
                onClick={handleAddFiles}
                disabled={isAddingFiles}
                title="添加文档到知识库"
              >
                {isAddingFiles ? '添加中...' : '+ 添加文档'}
              </button>
            </div>

            {isLoadingDocs ? (
              <div className={styles.loading}>加载中...</div>
            ) : documents.length === 0 ? (
              <div className={styles.emptyDocs}>
                <div>暂无文档</div>
                <div className={styles.emptyDocsHint}>点击"添加文档"上传 PDF、Word、TXT 等文件</div>
              </div>
            ) : (
              <div className={styles.docTable}>
                <div className={styles.docTableHeader}>
                  <span className={styles.colName}>文件名</span>
                  <span className={styles.colSize}>大小</span>
                  <span className={styles.colChunks}>片段</span>
                  <span className={styles.colStatus}>状态</span>
                  <span className={styles.colDate}>时间</span>
                  <span className={styles.colActions}></span>
                </div>
                {documents.map((doc) => {
                  const prog = progressMap[doc.id]
                  const displayStatus = prog?.status ?? doc.status

                  return (
                    <div key={doc.id} className={styles.docRow}>
                      <span className={styles.colName} title={doc.fileName}>
                        {doc.fileName}
                      </span>
                      <span className={styles.colSize}>{formatSize(doc.size)}</span>
                      <span className={styles.colChunks}>{doc.chunkCount || '-'}</span>
                      <span className={styles.colStatus}>
                        <span
                          className={styles.statusBadge}
                          style={{ color: statusColor[displayStatus] ?? '#8b9dc3' }}
                        >
                          {statusLabel[displayStatus] ?? displayStatus}
                        </span>
                        {prog && displayStatus !== 'ready' && displayStatus !== 'failed' && (
                          <div className={styles.progressBar}>
                            <div
                              className={styles.progressFill}
                              style={{ width: `${prog.progress ?? 0}%` }}
                            />
                          </div>
                        )}
                      </span>
                      <span className={styles.colDate}>{formatDate(doc.createdAt)}</span>
                      <span className={styles.colActions}>
                        {doc.status === 'failed' && (
                          <button
                            className={styles.rebuildBtn}
                            onClick={() => handleRebuildDoc(doc.id)}
                            title="重新索引"
                          >
                            ↺
                          </button>
                        )}
                        <button
                          className={styles.removeDocBtn}
                          onClick={() => handleRemoveDoc(doc.id)}
                          title="移除文档"
                        >
                          ✕
                        </button>
                      </span>
                    </div>
                  )
                })}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

export default KnowledgeBasePanel
