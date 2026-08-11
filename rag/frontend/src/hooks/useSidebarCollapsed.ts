import { useEffect, useState, useCallback } from 'react'

const STORAGE_KEY = 'sidebar-collapsed'
const CHANGE_EVENT = 'sidebar-collapsed-changed'

function readCollapsed(): boolean {
  if (typeof window === 'undefined') return false
  return window.localStorage.getItem(STORAGE_KEY) === '1'
}

export function useSidebarCollapsed(): [boolean, (collapsed: boolean) => void] {
  const [collapsed, setCollapsedState] = useState<boolean>(readCollapsed)

  useEffect(() => {
    const sync = () => setCollapsedState(readCollapsed())
    window.addEventListener('storage', sync)
    window.addEventListener(CHANGE_EVENT, sync)
    return () => {
      window.removeEventListener('storage', sync)
      window.removeEventListener(CHANGE_EVENT, sync)
    }
  }, [])

  const setCollapsed = useCallback((next: boolean) => {
    if (next) {
      window.localStorage.setItem(STORAGE_KEY, '1')
    } else {
      window.localStorage.removeItem(STORAGE_KEY)
    }
    setCollapsedState(next)
    window.dispatchEvent(new Event(CHANGE_EVENT))
  }, [])

  return [collapsed, setCollapsed]
}
