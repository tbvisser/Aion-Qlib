import { test, expect } from '@playwright/test'
import { readFileSync, readdirSync, existsSync, statSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

// Workstream E (Frontend Client Security) — build-output secret scan.
//
// The Vite bundle is shipped to every browser, so only the intended publishable
// VITE_* values may appear in it: the Supabase URL, the *anon* (publishable) key
// — an RLS-gated, intended-public client key — the API URL, and the brand. This
// test fails if a server-side secret (service_role key, OpenAI/OpenRouter
// `sk-...`, GitHub token, Supabase service-role JWT) leaks into dist/.
//
// It scans an existing dist/ build. Produce one first with:
//   npm run build        (tsc && vite build)
// If dist/ is absent the test is skipped (so it never blocks a non-built CI leg)
// — wire `npm run build` ahead of it in the security CI job to make it gating.

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const DIST_DIR = path.resolve(__dirname, '../../dist')

function collectFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...collectFiles(full))
    else out.push(full)
  }
  return out
}

// Patterns that must NEVER appear in client bundle output.
const FORBIDDEN: Array<{ name: string; re: RegExp }> = [
  { name: 'service_role literal', re: /service_role/ },
  { name: 'SUPABASE_SERVICE_ROLE var', re: /SUPABASE_SERVICE_ROLE/ },
  { name: 'OpenAI/OpenRouter secret key', re: /\bsk-[A-Za-z0-9_-]{16,}/ },
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}/ },
  // Supabase JWTs encode their role in the payload. The anon key is allowed;
  // a service_role JWT is not. Match a JWT whose decoded payload names the
  // service_role.
  { name: 'service_role JWT', re: /eyJ[A-Za-z0-9_-]+\.([A-Za-z0-9_-]+)\.[A-Za-z0-9_-]+/ },
]

function jwtIsServiceRole(token: string): boolean {
  const parts = token.split('.')
  if (parts.length !== 3) return false
  try {
    const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'))
    return payload?.role === 'service_role'
  } catch {
    return false
  }
}

test.describe('Frontend bundle secret scan', () => {
  test('dist/ contains no server-side secrets (only the anon key is allowed)', () => {
    test.skip(!existsSync(DIST_DIR), 'No dist/ build present — run `npm run build` first.')

    const files = collectFiles(DIST_DIR).filter(f => /\.(js|mjs|css|html|map|json)$/.test(f))
    const violations: string[] = []

    for (const file of files) {
      const content = readFileSync(file, 'utf8')
      for (const { name, re } of FORBIDDEN) {
        const matches = content.match(new RegExp(re, 'g'))
        if (!matches) continue
        if (name === 'service_role JWT') {
          // Only flag JWTs whose payload is actually service_role; the anon key
          // (role: "anon") is an intended, RLS-gated publishable key.
          const bad = matches.filter(jwtIsServiceRole)
          if (bad.length) violations.push(`${path.basename(file)}: ${name}`)
        } else {
          violations.push(`${path.basename(file)}: ${name} (${matches.length}x)`)
        }
      }
    }

    expect(violations, `Secrets found in build output:\n${violations.join('\n')}`).toEqual([])
  })
})
