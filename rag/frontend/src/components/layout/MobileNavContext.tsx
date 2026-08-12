import { createContext, useContext, useState, type ReactNode } from 'react'

interface MobileNavValue {
  /** Whether the mobile navigation drawer is open. Meaningless on desktop. */
  open: boolean
  setOpen: (open: boolean) => void
}

const MobileNavContext = createContext<MobileNavValue | null>(null)

export function MobileNavProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <MobileNavContext.Provider value={{ open, setOpen }}>
      {children}
    </MobileNavContext.Provider>
  )
}

export function useMobileNav(): MobileNavValue {
  const ctx = useContext(MobileNavContext)
  // Fall back to a no-op so a stray consumer outside the provider never crashes
  // (e.g. during isolated component tests).
  return ctx ?? { open: false, setOpen: () => {} }
}
