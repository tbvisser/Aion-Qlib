import { MessageSquare, Folder, Zap } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

export type SectionKey = 'chat' | 'documents' | 'skills'

export interface NavItem {
  key: SectionKey
  label: string
  icon: LucideIcon
  route: string
}

export const navItems: NavItem[] = [
  { key: 'chat', label: 'Chats', icon: MessageSquare, route: '/chat' },
  { key: 'documents', label: 'Documents', icon: Folder, route: '/documents' },
  { key: 'skills', label: 'Skills', icon: Zap, route: '/skills' },
]
