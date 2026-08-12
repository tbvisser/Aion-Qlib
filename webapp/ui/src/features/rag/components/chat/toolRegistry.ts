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

  // Vibe-Trading MCP tools (rag-api MCP_SERVERS → vibe-mcp sidecar). The
  // include filter in rag/backend/.env decides which of these are live.
  search_symbol: { name: 'Symbol Search', icon: Search, family: 'Vibe Markets' },
  get_market_data: { name: 'Market Data', icon: BarChart3, family: 'Vibe Markets' },
  get_stock_profile: { name: 'Company Profile', icon: FileText, family: 'Vibe Markets' },
  get_financial_statements: { name: 'Financials', icon: Receipt, family: 'Vibe Markets' },
  get_options_chain: { name: 'Options Chain', icon: Layers, family: 'Vibe Markets' },
  get_sec_filings: { name: 'SEC Filings', icon: FileSearch, family: 'Vibe Markets' },
  get_stock_news: { name: 'Stock News', icon: Globe, family: 'Vibe Markets' },
  screen_market: { name: 'Market Screener', icon: TextSearch, family: 'Vibe Markets' },
  get_macro_series: { name: 'Macro Series', icon: BarChart3, family: 'Vibe Markets' },
  get_sector_info: { name: 'Sector Info', icon: Rows3, family: 'Vibe Markets' },
  alpha_zoo: { name: 'Alpha Zoo', icon: Database, family: 'Vibe Research' },
  alpha_bench: { name: 'Alpha Benchmark', icon: BarChart3, family: 'Vibe Research' },
  extract_shadow_strategy: { name: 'Extract Shadow Strategy', icon: GitFork, family: 'Vibe Shadow' },
  run_shadow_backtest: { name: 'Shadow Backtest', icon: BarChart3, family: 'Vibe Shadow' },
  scan_shadow_signals: { name: 'Scan Shadow Signals', icon: TextSearch, family: 'Vibe Shadow' },
  render_shadow_report: { name: 'Shadow Report', icon: FileText, family: 'Vibe Shadow' },
  trading_connections: { name: 'Broker Connections', icon: Users, family: 'Vibe Brokers' },
  trading_select_connection: { name: 'Select Broker', icon: Users, family: 'Vibe Brokers' },
  trading_account: { name: 'Broker Account', icon: Receipt, family: 'Vibe Brokers' },
  trading_positions: { name: 'Broker Positions', icon: Rows3, family: 'Vibe Brokers' },
  trading_orders: { name: 'Broker Orders', icon: ListChecks, family: 'Vibe Brokers' },
  trading_history: { name: 'Trade History', icon: BookOpen, family: 'Vibe Brokers' },
  trading_quote: { name: 'Broker Quote', icon: BarChart3, family: 'Vibe Brokers' },
  trading_check: { name: 'Pre-trade Check', icon: ListChecks, family: 'Vibe Brokers' },
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
