import {
  Asterisk,
  BarChart3,
  BookOpen,
  Bookmark,
  Calculator,
  Code,
  Compass,
  Database,
  Expand,
  FileCode,
  FilePen,
  FilePlus,
  FileSearch,
  FileText,
  Files,
  Folder,
  FolderTree,
  GitFork,
  Globe,
  Layers,
  ListChecks,
  ListTodo,
  ListTree,
  Puzzle,
  Receipt,
  Rows3,
  ScanText,
  Search,
  Terminal,
  TextSearch,
  Upload,
  Users,
  Wrench,
  type LucideIcon,
} from 'lucide-react'

export interface ToolMeta {
  name: string
  icon: LucideIcon
  family: string
}

const TOOL_REGISTRY: Record<string, ToolMeta> = {
  list_files: { name: 'List Files', icon: Files, family: 'Workspace' },
  ls: { name: 'List Directory', icon: Folder, family: 'Workspace' },
  tree: { name: 'Directory Tree', icon: FolderTree, family: 'Workspace' },
  glob: { name: 'Find Files', icon: Asterisk, family: 'Workspace' },
  grep: { name: 'Search in Files', icon: TextSearch, family: 'Workspace' },
  write_file: { name: 'Write File', icon: FilePlus, family: 'Workspace' },
  read_file: { name: 'Read File', icon: FileText, family: 'Workspace' },
  edit_file: { name: 'Edit File', icon: FilePen, family: 'Workspace' },

  search_documents: { name: 'Document Search', icon: FileSearch, family: 'Knowledge Base' },
  read: { name: 'Read Document', icon: BookOpen, family: 'Knowledge Base' },
  get_document_structure: { name: 'Document Structure', icon: ListTree, family: 'Knowledge Base' },
  get_document_sections: { name: 'Document Sections', icon: Rows3, family: 'Knowledge Base' },
  analyze_document: { name: 'Analyze Document', icon: ScanText, family: 'Knowledge Base' },
  context_expansion: { name: 'Context Expansion', icon: Expand, family: 'Knowledge Base' },
  explore_knowledge_base: { name: 'Explore Knowledge Base', icon: Compass, family: 'Knowledge Base' },

  query_sales_database: { name: 'SQL Query', icon: Database, family: 'Business Data' },
  get_team_members: { name: 'Team Lookup', icon: Users, family: 'Business Data' },
  get_budget_by_level: { name: 'Budget Lookup', icon: BarChart3, family: 'Business Data' },
  get_expenses: { name: 'Expense Lookup', icon: Receipt, family: 'Business Data' },

  web_search: { name: 'Web Search', icon: Globe, family: 'Web' },

  load_skill: { name: 'Load Skill', icon: Puzzle, family: 'Skills' },
  read_skill_file: { name: 'Read Skill File', icon: FileCode, family: 'Skills' },
  save_skill: { name: 'Save Skill', icon: Bookmark, family: 'Skills' },
  upload_skill_file: { name: 'Upload Skill File', icon: Upload, family: 'Skills' },

  write_todos: { name: 'Update Plan', icon: ListChecks, family: 'Planning' },
  read_todos: { name: 'Read Plan', icon: ListTodo, family: 'Planning' },
  task: { name: 'Sub-agent Task', icon: GitFork, family: 'Planning' },

  calculator: { name: 'Calculator', icon: Calculator, family: 'Compute' },
  generate_code: { name: 'Generate Code', icon: Code, family: 'Compute' },
  code_execution: { name: 'Run Code', icon: Terminal, family: 'Compute' },

  execute_code: { name: 'Run Code', icon: Terminal, family: 'Compute' },
  tool_search: { name: 'Tool Search', icon: Search, family: 'Planning' },
  hybrid_search: { name: 'Document Search', icon: FileSearch, family: 'Knowledge Base' },
  append_file: { name: 'Write File', icon: FilePlus, family: 'Workspace' },
}

function titleCaseToolName(toolName: string): string {
  return toolName
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ')
}

export function getToolMeta(toolName: string): ToolMeta {
  return TOOL_REGISTRY[toolName] ?? {
    name: titleCaseToolName(toolName),
    icon: Wrench,
    family: 'Other',
  }
}

export function getToolDisplayName(toolName: string): string {
  return getToolMeta(toolName).name
}

export function getToolIcon(toolName: string): LucideIcon {
  return getToolMeta(toolName).icon
}

export function getToolFamily(toolName: string): string {
  return getToolMeta(toolName).family
}

export const toolGroupIcon = Layers
