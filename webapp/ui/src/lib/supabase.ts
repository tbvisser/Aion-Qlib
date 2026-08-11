import { createClient } from '@supabase/supabase-js'

// Browser-side Supabase client (auth, realtime, storage). Talks straight to
// the Kong gateway of the qlib RAG Supabase stack (supabase-aq, host :8010) —
// not through the Vite /rag-api proxy. The anon key is public by design; RLS
// is the actual security boundary.
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error('Missing Supabase environment variables')
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey)
