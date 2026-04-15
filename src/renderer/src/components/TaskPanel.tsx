/**
 * TaskPanel — 独立任务中心视图
 * 显示所有后台任务，支持新建任务、实时查看步骤进度、查看结果。
 */
import React, { useState, useEffect, useCallback, useRef } from 'react'
import styles from './TaskPanel.module.css'
import type { Task, TaskStep } from '../../../preload/index'

const STEP_ICONS: Record<TaskStep['type'], string> = {
  plan: '📋',
  thinking: '🤔',
  tool_call: '🔧',
  tool_result: '📄',
  output: '✅',
  error: '❌',
}

const STATUS_LABELS: Record<Task['status'], string> = {
  pending: '等待中',
  running: '执行中',
  paused: '已暂停',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
}

interface Props {
  // nothing — 自管理状态
}

const TaskPanel: React.FC<Props> = () => {
  const [tasks, setTasks] = useState<Task[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [expandedSteps, setExpandedSteps] = useState<Set<string>>(new Set())
  const stepsEndRef = useRef<HTMLDivElement>(null)

  // 初始化加载任务列表
  useEffect(() => {
    window.electronAPI.task.list().then((list) => {
      setTasks(list)
      if (list.length > 0 && !selectedId) {
        setSelectedId(list[0].id)
      }
    })
  }, [])

  // 实时监听任务更新
  useEffect(() => {
    const remove = window.electronAPI.task.onUpdate((updated) => {
      setTasks((prev) => {
        const exists = prev.some((t) => t.id === updated.id)
        if (exists) {
          return prev.map((t) => (t.id === updated.id ? updated : t))
        }
        return [updated, ...prev]
      })
    })
    return remove
  }, [])

  // 选中任务切换后自动滚到底部
  useEffect(() => {
    stepsEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [selectedId, tasks])

  const selectedTask = tasks.find((t) => t.id === selectedId) ?? null

  const handleCancel = useCallback(async (id: string) => {
    await window.electronAPI.task.cancel(id)
  }, [])

  const handlePause = useCallback(async (id: string) => {
    await window.electronAPI.task.pause(id)
  }, [])

  const handleResume = useCallback(async (id: string) => {
    await window.electronAPI.task.resume(id)
  }, [])

  const handleRerun = useCallback(async (id: string) => {
    await window.electronAPI.task.rerun(id)
  }, [])

  const handleDelete = useCallback(async (id: string) => {
    await window.electronAPI.task.delete(id)
    setTasks((prev) => prev.filter((t) => t.id !== id))
    if (selectedId === id) {
      setSelectedId(null)
    }
  }, [selectedId])

  const toggleStep = useCallback((stepId: string) => {
    setExpandedSteps((prev) => {
      const next = new Set(prev)
      if (next.has(stepId)) next.delete(stepId)
      else next.add(stepId)
      return next
    })
  }, [])

  return (
    <div className={styles.container}>
      {/* ── 左侧任务列表 ── */}
      <div className={styles.leftPanel}>
        <div className={styles.leftHeader}>
          <span className={styles.leftTitle}>任务中心</span>
        </div>

        {/* 任务列表 */}
        <div className={styles.taskList}>
          {tasks.length === 0 && (
            <div className={styles.emptyHint}>还没有任务</div>
          )}
          {[...tasks].sort((a, b) => b.createdAt - a.createdAt).map((task) => (
            <div
              key={task.id}
              className={`${styles.taskItem} ${task.id === selectedId ? styles.taskItemActive : ''}`}
              onClick={() => setSelectedId(task.id)}
            >
              <div className={styles.taskItemHeader}>
                <span className={`${styles.statusDot} ${styles[`status_${task.status}`]}`} />
                <span className={styles.taskItemTitle}>{task.title}</span>
              </div>
              <div className={styles.taskItemMeta}>
                <span className={styles.statusLabel}>{STATUS_LABELS[task.status]}</span>
                <span className={styles.stepCount}>{task.steps.length} 步</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ── 右侧详情面板 ── */}
      <div className={styles.rightPanel}>
        {!selectedTask ? (
          <div className={styles.emptyDetail}>
            <div className={styles.emptyIcon}>⚡</div>
            <div className={styles.emptyTitle}>任务中心</div>
            <div className={styles.emptyDesc}>
              在左侧描述一个端到端任务，AI 会自动联网搜索、分析数据，并生成报告文件。<br />
              任务在后台独立执行，不影响普通对话。
            </div>
          </div>
        ) : (
          <>
            {/* 任务标题栏 */}
            <div className={styles.detailHeader}>
              <div>
                <div className={styles.detailTitle}>{selectedTask.title}</div>
                <div className={styles.detailMeta}>
                  <span className={`${styles.statusBadge} ${styles[`badge_${selectedTask.status}`]}`}>
                    {STATUS_LABELS[selectedTask.status]}
                  </span>
                  <span className={styles.detailTime}>
                    {new Date(selectedTask.createdAt).toLocaleString('zh-CN')}
                  </span>
                </div>
              </div>
              <div className={styles.detailActions}>
                {/* 暂停（运行中） */}
                {selectedTask.status === 'running' && (
                  <button
                    className={`${styles.iconBtn} ${styles.iconBtnWarning}`}
                    onClick={() => void handlePause(selectedTask.id)}
                    title="暂停任务"
                  >
                    <svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>
                  </button>
                )}
                {/* 继续（已暂停） */}
                {selectedTask.status === 'paused' && (
                  <button
                    className={`${styles.iconBtn} ${styles.iconBtnPrimary}`}
                    onClick={() => void handleResume(selectedTask.id)}
                    title="继续任务"
                  >
                    <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
                  </button>
                )}
                {/* 停止（运行中或已暂停） */}
                {(selectedTask.status === 'running' || selectedTask.status === 'paused') && (
                  <button
                    className={`${styles.iconBtn} ${styles.iconBtnDangerOutline}`}
                    onClick={() => void handleCancel(selectedTask.id)}
                    title="停止任务"
                  >
                    <svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>
                  </button>
                )}
                {/* 重新运行（已完成/失败/取消） */}
                {(selectedTask.status === 'completed' || selectedTask.status === 'failed' || selectedTask.status === 'cancelled') && (
                  <button
                    className={`${styles.iconBtn} ${styles.iconBtnPrimary}`}
                    onClick={() => void handleRerun(selectedTask.id)}
                    title="重新运行"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>
                  </button>
                )}
                {/* 删除 */}
                <button
                  className={`${styles.iconBtn} ${styles.iconBtnDanger}`}
                  onClick={() => {
                    if (window.confirm('确定删除此任务记录？')) {
                      void handleDelete(selectedTask.id)
                    }
                  }}
                  title="删除任务"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>
                </button>
              </div>
            </div>

            {/* 步骤列表 */}
            <div className={styles.stepList}>
              {selectedTask.steps.length === 0 && selectedTask.status === 'running' && (
                <div className={styles.waitingHint}>
                  <span className={styles.spinner} />
                  正在初始化任务...
                </div>
              )}

              {selectedTask.steps.map((step) => {
                const expanded = expandedSteps.has(step.id)
                const hasDetail = step.content && step.content.length > 0 && step.type !== 'output'

                return (
                  <div key={step.id} className={`${styles.stepItem} ${styles[`step_${step.type}`]}`}>
                    <div
                      className={styles.stepHeader}
                      onClick={() => hasDetail && toggleStep(step.id)}
                      style={{ cursor: hasDetail ? 'pointer' : 'default' }}
                    >
                      <span className={styles.stepIcon}>{STEP_ICONS[step.type]}</span>
                      <span className={styles.stepLabel}>{step.label}</span>
                      {hasDetail && (
                        <span className={styles.expandIcon}>{expanded ? '▲' : '▼'}</span>
                      )}
                    </div>
                    {expanded && hasDetail && (
                      <pre className={styles.stepContent}>{step.content}</pre>
                    )}
                    {step.type === 'output' && step.content && (
                      <div className={styles.outputContent}>
                        <pre className={styles.outputPre}>{step.content}</pre>
                      </div>
                    )}
                  </div>
                )
              })}

              {selectedTask.status === 'running' && selectedTask.steps.length > 0 && (
                <div className={styles.waitingHint}>
                  <span className={styles.spinner} />
                  执行中...
                </div>
              )}
              {selectedTask.status === 'paused' && (
                <div className={styles.waitingHint}>
                  ⏸ 已暂停，点击继续按钮恢复执行
                </div>
              )}

              <div ref={stepsEndRef} />
            </div>

            {/* 输出文件 */}
            {selectedTask.outputFiles.length > 0 && (
              <div className={styles.outputFiles}>
                <div className={styles.outputFilesTitle}>生成的文件：</div>
                {selectedTask.outputFiles.map((f) => (
                  <div
                    key={f}
                    className={styles.outputFile}
                    onClick={() => void window.electronAPI.openPath(f)}
                    title="点击打开文件"
                  >
                    📎 <span>{f}</span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

export default TaskPanel
