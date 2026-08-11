// Single source of truth for where the RAG backend lives. In dev the Vite
// proxy maps /rag-api/* onto the rag-api container (see vite.config.ts), so
// the app stays same-origin; VITE_RAG_API_URL overrides for direct access.
export const RAG_API_URL: string = import.meta.env.VITE_RAG_API_URL ?? '/rag-api'
