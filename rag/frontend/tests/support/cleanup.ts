/**
 * Test data cleanup utility.
 *
 * Deletes all threads and folders for the authenticated test user via the
 * backend API.  Called in globalSetup so every Playwright run starts clean,
 * and the cleanup is self-healing even after a previous crash.
 */

import { request } from '@playwright/test'
import * as fs from 'fs'

const API_BASE = process.env.BASE_URL
  ? process.env.BASE_URL.replace(':5173', ':8001')
  : 'http://localhost:8001'

const STORAGE_STATE_PATH = './tests/support/.auth/user1.json'

/** Extract the JWT from a Playwright storageState JSON file. */
function getTokenFromStorageState(path: string): string | null {
  if (!fs.existsSync(path)) return null

  const state = JSON.parse(fs.readFileSync(path, 'utf-8'))
  // Supabase stores auth in localStorage under sb-*-auth-token
  for (const entry of state.origins ?? []) {
    for (const item of entry.localStorage ?? []) {
      if (item.name?.includes('auth-token')) {
        try {
          const parsed = JSON.parse(item.value)
          return parsed.access_token ?? null
        } catch {
          return null
        }
      }
    }
  }
  return null
}

/** Delete all threads and folders for the test user. */
export async function cleanupTestData(): Promise<void> {
  const token = getTokenFromStorageState(STORAGE_STATE_PATH)
  if (!token) {
    // Auth setup hasn't run yet — nothing to clean
    return
  }

  const ctx = await request.newContext({
    baseURL: API_BASE,
    extraHTTPHeaders: { Authorization: `Bearer ${token}` },
    timeout: 30_000,
  })

  try {
    // Delete threads (cascades to messages and todos).
    // The endpoint is paginated ({ threads, total_count, has_more }); tolerate
    // either a bare array or the paginated envelope.
    const threadsResp = await ctx.get('/threads')
    if (threadsResp.ok()) {
      const data = await threadsResp.json()
      const threads = Array.isArray(data) ? data : data.threads ?? []
      for (const t of threads) {
        await ctx.delete(`/threads/${t.id}`)
      }
    }

    // Delete folders (children first, then roots)
    const foldersResp = await ctx.get('/folders')
    if (foldersResp.ok()) {
      const folders = await foldersResp.json()
      const withParent = folders.filter((f: any) => f.parent_id)
      const roots = folders.filter((f: any) => !f.parent_id)
      for (const f of [...withParent, ...roots]) {
        await ctx.delete(`/folders/${f.id}`)
      }
    }
  } finally {
    await ctx.dispose()
  }
}
