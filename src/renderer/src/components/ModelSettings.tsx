import React, { useState } from 'react'
import type { ModelRouteConfig, OnlineProviderConfig, RouteModelConfig } from '../modelSettings'
import styles from './ModelSettings.module.css'

type Props = {
  config: ModelRouteConfig
  saved: ModelRouteConfig
  models: string[]
  candidates: string[]
  presets: Record<string, string>
  providerModels: Record<string, string[]>
  test: { status: string; message: string; latencyMs?: number }
  onConnection: (patch: Partial<OnlineProviderConfig>) => void
  onRoute: (route: RouteModelConfig) => void
  onSelect: (id: string) => void
  onCreate: () => void
  onDelete: (id: string) => void
  onTest: () => void
  onRefreshModels: (models: string[]) => void
}

export default function ModelSettings({ config, saved, models, candidates, presets, providerModels, test, onConnection, onRoute, onSelect, onCreate, onDelete, onTest, onRefreshModels }: Props) {
  const [showKey, setShowKey] = useState(false)
  const [search, setSearch] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [localError, setLocalError] = useState('')
  const online = config.chat.provider === 'openai-compatible'
  const active = config.onlineProfiles.find((p) => p.id === config.activeOnlineProfileId)
  const available = online ? candidates : models.filter((m) => !/embed/i.test(m))
  const filtered = available.filter((m) => m.toLowerCase().includes(search.toLowerCase()))
  const busy = test.status === 'testing'
  const resetView = () => { setShowKey(false); setSearch('') }

  return (
    <div className={styles.page}>
      <header className={styles.heading}>
        <div><h2>模型与连接</h2><p>配置一次，聊天、任务和知识库问答共用。</p></div>
        <span className={styles.badge}>{JSON.stringify(config) === JSON.stringify(saved) ? '已保存' : '有未保存修改'}</span>
      </header>

      <div className={styles.sourceSwitch} role="group" aria-label="模型来源">
        <button type="button" aria-pressed={online} className={online ? styles.sourceActive : ''} onClick={() => {
          if (online) return
          resetView()
          onRoute({ provider: 'openai-compatible', model: active?.chatModel || active?.agentModel || active?.ragModel || providerModels[config.online.provider]?.[0] || '' })
        }}><span className={styles.sourceIcon}>↗</span><span><strong>在线模型</strong><small>连接服务商或自定义 API</small></span></button>
        <button type="button" aria-pressed={!online} className={!online ? styles.sourceActive : ''} onClick={() => {
          if (!online) return
          resetView()
          onRoute({ provider: 'ollama', model: saved.chat.provider === 'ollama' ? saved.chat.model : models.find((m) => !/embed/i.test(m)) || '' })
        }}><span className={styles.sourceIcon}>▣</span><span><strong>本地 Ollama</strong><small>使用本机运行的模型</small></span></button>
      </div>

      <div className={styles.settingsGrid}>
      {online ? <>
        <section className={styles.section}>
          <div className={styles.sectionTitle}><h3>连接配置</h3><button className={styles.textBtn} onClick={() => { resetView(); onCreate() }}>＋ 新建配置</button></div>
          {config.onlineProfiles.length > 0 && <div className={styles.profileRow}>
            <label htmlFor="saved-model-profile">已保存配置</label>
            <select id="saved-model-profile" value={config.activeOnlineProfileId ?? ''} onChange={(e) => { resetView(); e.target.value ? onSelect(e.target.value) : onCreate() }}>
              <option value="">新配置</option>
              {config.onlineProfiles.map((p) => <option key={p.id} value={p.id}>{p.name} · {p.provider}</option>)}
            </select>
            {active && <button className={styles.deleteBtn} onClick={() => onDelete(active.id)} aria-label={`删除配置 ${active.name}`}>删除</button>}
          </div>}
          <div className={styles.grid}>
            <label className={styles.field}><span>服务商</span><select aria-label="服务商" value={config.online.provider} onChange={(e) => {
              const provider = e.target.value
              resetView()
              onConnection({ provider, baseUrl: provider === 'Custom' ? '' : presets[provider], apiKey: '', name: active ? config.online.name : '' })
              onRoute({ provider: 'openai-compatible', model: providerModels[provider]?.[0] || '' })
            }}>{Object.keys(presets).map((p) => <option key={p} value={p}>{p === 'Custom' ? '自定义（OpenAI 兼容）' : p}</option>)}</select></label>
            <label className={styles.field}><span>配置名称 <em>选填</em></span><input value={config.online.name} onChange={(e) => onConnection({ name: e.target.value })} placeholder={`默认使用 ${config.online.provider}，可自定义名称`} /></label>
            <label className={`${styles.field} ${styles.full}`}><span>接口地址 <em>Base URL</em></span><input type="url" spellCheck={false} title="填写 API 根地址，无需添加 /chat/completions" value={config.online.baseUrl} onChange={(e) => onConnection({ baseUrl: e.target.value })} placeholder="https://api.example.com/v1" /></label>
            <div className={`${styles.field} ${styles.full}`}><label htmlFor="model-api-key">API Key</label><div className={styles.secretInput}><input id="model-api-key" type={showKey ? 'text' : 'password'} autoComplete="off" spellCheck={false} value={config.online.apiKey} onChange={(e) => onConnection({ apiKey: e.target.value })} placeholder="粘贴服务商提供的 API Key" /><button aria-label={showKey ? '隐藏 API Key' : '显示 API Key'} aria-pressed={showKey} onClick={() => setShowKey(!showKey)}>{showKey ? '隐藏' : '显示'}</button></div></div>
          </div>
          <div className={styles.testRow}>
            <button className={styles.outlineBtn} onClick={onTest} disabled={busy || !config.online.baseUrl.trim() || !config.online.apiKey.trim() || !config.chat.model.trim()}>{busy ? '正在测试…' : '测试连接并获取模型'}</button>
            <span role="status" className={test.status === 'error' ? styles.error : test.status === 'success' ? styles.success : styles.muted}>{test.message || '先填写连接信息和默认模型，再测试。'}{test.status === 'success' && test.latencyMs !== undefined ? ` · ${test.latencyMs} ms` : ''}</span>
          </div>
        </section>
      </> : <section className={styles.localNote}>
        <span className={styles.sourceIcon}>▣</span><div><strong>本地运行，直接连接 Ollama</strong><p>请先启动 Ollama 并下载模型，随后刷新列表。</p><span role="status" className={styles.error}>{localError}</span></div>
        <button className={styles.outlineBtn} disabled={refreshing} onClick={async () => {
          setRefreshing(true); setLocalError('')
          try { onRefreshModels(await window.electronAPI.listModels()) } catch { setLocalError('获取失败，请检查 Ollama 是否已启动。') } finally { setRefreshing(false) }
        }}>{refreshing ? '刷新中…' : '刷新模型'}</button>
      </section>}

      <section className={styles.section}>
        <div className={styles.sectionTitle}><h3>默认模型</h3><span className={styles.muted}>保存后生效</span></div>
        <label className={styles.field}><span className={styles.srOnly}>默认模型名称</span><input value={config.chat.model} spellCheck={false} onChange={(e) => onRoute({ provider: config.chat.provider, model: e.target.value })} placeholder={online ? '选择下方模型，或输入服务商的模型 ID' : '选择下方模型，或输入本地模型名称'} /><small>聊天、任务、知识库问答统一使用此模型，也可在聊天输入框上方切换。</small></label>
        {available.length > 0 ? <>
          <div className={styles.listHeader}><span>{online ? '可选模型' : '已安装模型'} · {available.length}</span>{available.length > 6 && <input type="search" aria-label="搜索模型" placeholder="搜索模型…" value={search} onChange={(e) => setSearch(e.target.value)} />}</div>
          <div className={styles.modelList}>{filtered.map((model) => <button key={model} title={model} aria-pressed={config.chat.model === model} className={config.chat.model === model ? styles.modelActive : ''} onClick={() => onRoute({ provider: config.chat.provider, model })}>{model}{config.chat.model === model && <span> ✓</span>}</button>)}{!filtered.length && <span className={styles.muted}>没有匹配的模型，可在上方直接填写。</span>}</div>
          {online && <p className={styles.footnote}>列表包含服务商预设和已获取的模型，实际可用性以连接测试为准。</p>}
        </> : <p className={styles.empty}>{online ? '暂无模型列表，可手动填写模型 ID 后测试连接。' : '尚未检测到聊天模型。安装模型后点击“刷新模型”，或手动填写名称。'}</p>}
      </section>
      </div>
      <p className={styles.saveHint}>修改完成后点击下方“保存并应用”，连接配置和默认模型将一起保存。</p>
    </div>
  )
}
