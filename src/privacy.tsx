import { createContext, useContext, useMemo, type ReactNode } from 'react'

export interface PrivacyTools {
  enabled: boolean
  sessionTitle: (value: string, id?: string) => string
  workspace: (value: string) => string
  path: (value: string) => string
  identifier: (value: string) => string
  content: (value: string) => string
  file: (value: string) => string
  capability: (value: string, kind?: string) => string
  memory: (value: string) => string
  host: (value: string, id?: string) => string
  endpoint: (value: string) => string
}

const passthrough: PrivacyTools = {
  enabled: false,
  sessionTitle: (value) => value,
  workspace: (value) => value,
  path: (value) => value,
  identifier: (value) => value,
  content: (value) => value,
  file: (value) => value,
  capability: (value) => value,
  memory: (value) => value,
  host: (value) => value,
  endpoint: (value) => value,
}

const PrivacyContext = createContext<PrivacyTools>(passthrough)

function alias(value: string): string {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36).slice(-3).toUpperCase().padStart(3, '0')
}

export function createPrivacyTools(enabled: boolean): PrivacyTools {
  if (!enabled) return passthrough
  return {
    enabled: true,
    sessionTitle: (value, id) => `Session ${alias(id || value)}`,
    workspace: (value) => `Workspace ${alias(value)}`,
    path: (value) => value.endsWith('.grok') ? '~/.grok' : `~/workspace-${alias(value).toLowerCase()}`,
    identifier: (value) => `private-${alias(value).toLowerCase()}`,
    content: () => 'Content hidden while Privacy Mode is active.',
    file: (value) => `file-${alias(value).toLowerCase()}`,
    capability: (value, kind = 'Capability') => `${kind} ${alias(value)}`,
    memory: (value) => `Memory ${alias(value)}`,
    host: (value, id) => `Host ${alias(id || value)}`,
    endpoint: (value) => `private-host-${alias(value).toLowerCase()}`,
  }
}

export function PrivacyProvider({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const tools = useMemo<PrivacyTools>(() => createPrivacyTools(enabled), [enabled])

  return <PrivacyContext.Provider value={tools}>{children}</PrivacyContext.Provider>
}

export function usePrivacy(): PrivacyTools {
  return useContext(PrivacyContext)
}
