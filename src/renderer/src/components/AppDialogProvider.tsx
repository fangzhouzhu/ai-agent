import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import styles from './AppDialogProvider.module.css'

type ConfirmOptions = {
  title?: string
  message: string
  description?: string
  confirmText?: string
  cancelText?: string
  tone?: 'default' | 'danger'
}

type PromptOptions = {
  title?: string
  message?: string
  initialValue?: string
  placeholder?: string
  confirmText?: string
  cancelText?: string
}

type DialogContextValue = {
  confirm: (options: ConfirmOptions) => Promise<boolean>
  prompt: (options: PromptOptions) => Promise<string | null>
}

type ConfirmState = ConfirmOptions & {
  resolve: (value: boolean) => void
}

type PromptState = PromptOptions & {
  resolve: (value: string | null) => void
}

const DialogContext = createContext<DialogContextValue | null>(null)

export function useAppDialog(): DialogContextValue {
  const context = useContext(DialogContext)
  if (!context) {
    throw new Error('useAppDialog must be used within AppDialogProvider')
  }
  return context
}

const AppDialogProvider: React.FC<React.PropsWithChildren> = ({ children }) => {
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null)
  const [promptState, setPromptState] = useState<PromptState | null>(null)
  const [promptValue, setPromptValue] = useState('')
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (promptState) {
      setPromptValue(promptState.initialValue ?? '')
      queueMicrotask(() => inputRef.current?.focus())
    }
  }, [promptState])

  const value = useMemo<DialogContextValue>(() => ({
    confirm: (options) =>
      new Promise<boolean>((resolve) => {
        setConfirmState({
          title: options.title,
          message: options.message,
          description: options.description,
          confirmText: options.confirmText ?? (options.tone === 'danger' ? '删除' : '确定'),
          cancelText: options.cancelText ?? '取消',
          tone: options.tone ?? 'default',
          resolve,
        })
      }),
    prompt: (options) =>
      new Promise<string | null>((resolve) => {
        setPromptState({
          title: options.title ?? '请输入内容',
          message: options.message,
          initialValue: options.initialValue ?? '',
          placeholder: options.placeholder ?? '',
          confirmText: options.confirmText ?? '确定',
          cancelText: options.cancelText ?? '取消',
          resolve,
        })
      }),
  }), [])

  return (
    <DialogContext.Provider value={value}>
      {children}
      {confirmState && (
        <div className={styles.overlay}>
          <div className={styles.dialog} role="dialog" aria-modal="true">
            <button
              type="button"
              className={styles.closeBtn}
              onClick={() => {
                confirmState.resolve(false)
                setConfirmState(null)
              }}
              aria-label="关闭"
            >
              ×
            </button>
            <div className={styles.body}>
              <div className={styles.titleRow}>
                {confirmState.tone === 'danger' ? (
                  <div className={styles.warnIcon}>!</div>
                ) : (
                  <div className={styles.titleSpacer} />
                )}
                <div className={styles.dialogTitle}>
                  {confirmState.title ?? confirmState.message}
                </div>
              </div>
              {(confirmState.description || !confirmState.title) && (
                <div className={styles.dialogDescription}>
                  {confirmState.title ? confirmState.description : ''}
                </div>
              )}
            </div>
            <div className={styles.footer}>
              <button
                type="button"
                className={styles.btn}
                onClick={() => {
                  confirmState.resolve(false)
                  setConfirmState(null)
                }}
              >
                {confirmState.cancelText ?? '取消'}
              </button>
              <button
                type="button"
                className={`${styles.btn} ${confirmState.tone === 'danger' ? styles.btnDanger : styles.btnPrimary}`}
                onClick={() => {
                  confirmState.resolve(true)
                  setConfirmState(null)
                }}
              >
                {confirmState.confirmText ?? '确定'}
              </button>
            </div>
          </div>
        </div>
      )}
      {promptState && (
        <div className={styles.overlay}>
          <div className={styles.dialog} role="dialog" aria-modal="true">
            <button
              type="button"
              className={styles.closeBtn}
              onClick={() => {
                promptState.resolve(null)
                setPromptState(null)
              }}
              aria-label="关闭"
            >
              ×
            </button>
            <div className={styles.body}>
              <div className={styles.dialogTitle}>{promptState.title ?? '请输入内容'}</div>
              {promptState.message && (
                <div className={styles.dialogDescription}>{promptState.message}</div>
              )}
              <input
                ref={inputRef}
                className={styles.input}
                value={promptValue}
                onChange={(e) => setPromptValue(e.target.value)}
                placeholder={promptState.placeholder}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    promptState.resolve(promptValue)
                    setPromptState(null)
                  }
                  if (e.key === 'Escape') {
                    promptState.resolve(null)
                    setPromptState(null)
                  }
                }}
              />
            </div>
            <div className={styles.footer}>
              <button
                type="button"
                className={styles.btn}
                onClick={() => {
                  promptState.resolve(null)
                  setPromptState(null)
                }}
              >
                {promptState.cancelText ?? '取消'}
              </button>
              <button
                type="button"
                className={`${styles.btn} ${styles.btnPrimary}`}
                onClick={() => {
                  promptState.resolve(promptValue)
                  setPromptState(null)
                }}
              >
                {promptState.confirmText ?? '确定'}
              </button>
            </div>
          </div>
        </div>
      )}
    </DialogContext.Provider>
  )
}

export default AppDialogProvider
