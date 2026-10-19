export type SettingsResource = {
  id: string
  group: string
  label: string
  load: () => Promise<unknown>
  apply: (value: any) => void
}

// Each resource has its own deadline and result. A failed diagnostic request must
// never prevent a successfully loaded model configuration from being applied.
export async function loadSettingsResources(resources: SettingsResource[], options: {
  timeoutMs?: number
  start: (resource: SettingsResource) => void
  finish: (resource: SettingsResource, error?: string) => void
  isCurrent: (resource: SettingsResource) => boolean
}): Promise<void> {
  await Promise.all(resources.map(async resource => {
    options.start(resource)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const value = await Promise.race([
        Promise.resolve().then(resource.load),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('加载超时')), options.timeoutMs ?? 15_000) }),
      ])
      if (options.isCurrent(resource)) {
        resource.apply(value)
        options.finish(resource)
      }
    } catch (error) {
      if (options.isCurrent(resource)) options.finish(resource, `${resource.label}：${error instanceof Error ? error.message : '加载失败'}`)
    } finally { if (timer) clearTimeout(timer) }
  }))
}
