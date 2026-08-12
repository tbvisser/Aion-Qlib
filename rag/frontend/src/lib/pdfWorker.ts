// frontend/src/lib/pdfWorker.ts
//
// Single source of truth for pdf.js worker config. Calling this multiple
// times concurrently is safe — all callers await the same one-time setup.
// NOTE: No static imports from pdfjs-dist here — that would pull the entire
// library into the main bundle and defeat lazy loading.

let configuredPromise: Promise<void> | null = null

export function ensurePdfWorker(): Promise<void> {
  if (!configuredPromise) {
    configuredPromise = (async () => {
      // Use Vite's `?worker&url` (not plain `?url`): it returns the URL of a
      // Vite-emitted module-worker bundle, which the dev server serves correctly
      // as a standalone worker. Plain `?url` returns the bare node_modules path,
      // which Vite 6's dev server does not serve as a clean module worker — pdf.js
      // then falls back to import()-ing it and fails ("Setting up fake worker
      // failed … ?import"). pdf.js always instantiates workerSrc as a module
      // worker, and keeping workerSrc (vs workerPort) preserves one worker per
      // document for concurrent PDF rendering.
      const [{ GlobalWorkerOptions }, workerSrcMod] = await Promise.all([
        import('pdfjs-dist'),
        import('pdfjs-dist/build/pdf.worker.min.mjs?worker&url'),
      ])
      GlobalWorkerOptions.workerSrc = workerSrcMod.default
    })()
  }
  return configuredPromise
}
