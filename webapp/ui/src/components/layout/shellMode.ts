import { Home, Code2 } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

/**
 * The two halves of the app, as a switch in the sidebar header.
 *
 * This is a real mode, not a shortcut: Home lists the platform's destinations,
 * Code swaps the nav for the short list a coding session needs and hands the
 * main pane to `/code`. Everything Home shows is still reachable from Code —
 * the "More" disclosure under the Code nav opens the rest — so switching
 * narrows the view without stranding a page.
 *
 * Code's own backend is not wired yet. The surface exists, says so, and is
 * ready for it.
 */
export type ShellMode = 'home' | 'code'

export interface ShellModeEntry {
  value: ShellMode
  label: string
  icon: LucideIcon
  route: string
}

export const SHELL_MODES: readonly ShellModeEntry[] = [
  { value: 'home', label: 'Home', icon: Home, route: '/dashboard' },
  { value: 'code', label: 'Code', icon: Code2, route: '/code' },
]

export function shellModeForPath(pathname: string): ShellMode {
  return pathname === '/code' || pathname.startsWith('/code/') ? 'code' : 'home'
}

export function shellModeRoute(mode: ShellMode): string {
  return SHELL_MODES.find((m) => m.value === mode)!.route
}
