import { useCallback, useEffect, useState } from 'react'

export type ReasoningEffort = 'low' | 'medium' | 'high'

export interface ModelConfig {
  /** Model name sent to the configured provider. '' = use the server default (env LLM_MODEL). */
  model: string
  /** Enable provider "thinking"/reasoning for new messages. */
  thinking: boolean
  /** Reasoning effort applied when thinking is on. */
  reasoningEffort: ReasoningEffort
}

const STORAGE_KEY = 'modelConfig'
const CHANGE_EVENT = 'model-config-changed'

export const DEFAULT_MODEL_CONFIG: ModelConfig = {
  model: '',
  thinking: false,
  reasoningEffort: 'medium',
}

function readConfig(): ModelConfig {
  if (typeof window === 'undefined') return DEFAULT_MODEL_CONFIG
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_MODEL_CONFIG
    const parsed = JSON.parse(raw) as Partial<ModelConfig>
    const effort = parsed.reasoningEffort
    return {
      model: typeof parsed.model === 'string' ? parsed.model : '',
      thinking: parsed.thinking === true,
      reasoningEffort:
        effort === 'low' || effort === 'medium' || effort === 'high' ? effort : 'medium',
    }
  } catch {
    return DEFAULT_MODEL_CONFIG
  }
}

/** Read the persisted model config imperatively (e.g. at message-send time). */
export function readModelConfig(): ModelConfig {
  return readConfig()
}

/**
 * Global, persisted model configuration (model name + thinking + effort).
 *
 * App-wide like {@link useSidebarCollapsed}/theme: stored under a single
 * localStorage key and synced across tabs/components via a custom event, so the
 * composer dialog and the send path stay in agreement without prop drilling.
 */
export function useModelConfig(): [ModelConfig, (next: Partial<ModelConfig>) => void] {
  const [config, setConfigState] = useState<ModelConfig>(readConfig)

  useEffect(() => {
    const sync = () => setConfigState(readConfig())
    window.addEventListener('storage', sync)
    window.addEventListener(CHANGE_EVENT, sync)
    return () => {
      window.removeEventListener('storage', sync)
      window.removeEventListener(CHANGE_EVENT, sync)
    }
  }, [])

  const updateConfig = useCallback((next: Partial<ModelConfig>) => {
    // Merge onto the persisted value (source of truth) to avoid stale-closure drift.
    const merged = { ...readConfig(), ...next }
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(merged))
    } catch {
      /* ignore quota / disabled storage */
    }
    setConfigState(merged)
    window.dispatchEvent(new Event(CHANGE_EVENT))
  }, [])

  return [config, updateConfig]
}
