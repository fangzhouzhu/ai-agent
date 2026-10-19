import React, { useEffect, useState } from 'react'
import type { WorkspaceGrant, FileRevision } from '../../../preload/index'
import styles from '../App.module.css'

export default function WorkspacePermissions() {
  const [grants, setGrants] = useState<WorkspaceGrant[]>([])
  const [revisions, setRevisions] = useState<FileRevision[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(true)
  const refresh = async () => {
    const [roots, changes] = await Promise.all([window.electronAPI.workspaces.list(), window.electronAPI.workspaces.revisions()])
    setGrants(roots); setRevisions(changes)
  }
  useEffect(() => {
    let active = true
    Promise.all([window.electronAPI.workspaces.list(), window.electronAPI.workspaces.revisions()]).then(([roots, changes]) => {
      if (active) { setGrants(roots); setRevisions(changes) }
    }).catch(err => { if (active) setError(String(err.message || err)) }).finally(() => { if (active) setBusy(false) })
    return () => { active = false }
  }, [])
  const run = async (work: () => Promise<unknown>) => {
    setBusy(true); setError('')
    try { await work() } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    finally { setBusy(false) }
  }
  return <section className={styles.modalSection} aria-label="工作区授权与文件恢复">
    <div className={styles.modalLabel}>工作区授权</div>
    <div className={styles.fieldHint}>Agent 只能访问下列目录。新授权默认只读，写入与删除还需要 Agent 自身权限允许。撤销后，尚未执行的文件操作会重新检查授权。</div>
    <button type="button" className={styles.secondaryBtn} disabled={busy} onClick={() => void run(async () => setGrants(await window.electronAPI.workspaces.pick()))}>添加工作目录</button>
    {grants.map(grant => <div key={grant.id} className={styles.policyCard}>
      <div className={styles.policyName} style={{ overflowWrap: 'anywhere' }}>{grant.root}</div>
      <div className={styles.fieldHint}>{grant.builtin ? '默认成果目录，可读写；应用配置与恢复备份不对 Agent 开放。' : '允许读取该目录及子目录，不允许通过符号链接或目录联接访问。'}</div>
      <div className={styles.agentToggleGrid}>
        {(['allowWrite', 'allowDelete'] as const).map(key => <label key={key} className={styles.toggleRow}>
          <input type="checkbox" checked={grant[key]} disabled={busy || grant.builtin}
            onChange={event => { const value = event.target.checked; void run(async () => setGrants(await window.electronAPI.workspaces.update(grant.id, { allowWrite: grant.allowWrite, allowDelete: grant.allowDelete, [key]: value }))) }} />
          <span>{key === 'allowWrite' ? '允许创建和修改' : '允许移入回收站'}</span>
        </label>)}
        {!grant.builtin && <button type="button" className={styles.secondaryBtn} disabled={busy} onClick={() => void run(async () => setGrants(await window.electronAPI.workspaces.update(grant.id, null)))}>撤销授权</button>}
      </div>
    </div>)}
    <div className={styles.fieldHint}>覆盖、移动和删除现有文件前会展示路径并要求确认。已有目录不支持覆盖，请指定新目录。单次最多 2000 个条目、50 MiB。</div>
    <div className={styles.modalLabel}>文件恢复</div>
    <button type="button" className={styles.secondaryBtn} disabled={busy} onClick={() => void run(refresh)}>刷新授权与备份</button>
    <div className={styles.fieldHint}>修改前自动保留文件备份，显示最近 100 条。恢复前会再次确认，当前内容也会保留备份。目录移动可移回原位置，删除文件也可从系统回收站恢复。</div>
    {!revisions.length && <div className={styles.emptyHint}>暂无文件恢复备份。</div>}
    {revisions.map(revision => <div key={revision.id} className={styles.policyCard}>
      <div style={{ overflowWrap: 'anywhere' }}>{revision.originalPath}</div>
      <div className={styles.fieldHint}>{new Date(revision.createdAt).toLocaleString()} · {revision.size} 字节 · {revision.toolName}</div>
      <button type="button" className={styles.secondaryBtn} disabled={busy} onClick={() => void run(async () => { await window.electronAPI.workspaces.restoreFile(revision.id); await refresh() })}>恢复这份备份</button>
    </div>)}
    {error && <div role="alert">{error}</div>}
  </section>
}
