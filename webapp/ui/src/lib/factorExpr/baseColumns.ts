/**
 * The column names each handler already computes.
 *
 * Needed for one check: in `extend` mode a custom column that repeats a handler
 * column's name silently replaces it. qlib's `NestedDataLoader` drops the
 * earlier duplicate and keeps the later one, so the handler comes back the same
 * size with the user's expression under qlib's name, and nothing anywhere says
 * so.
 *
 * The live source is the served `/api/indicators` payload, which the canvas
 * already fetches -- it comes from the same `get_feature_config` call the
 * handler itself makes. The constant below is the fallback, and it exists
 * because the alternative failure is the worst one available: a collision check
 * that passes because the API was down would let the very thing it guards
 * against through. There must never be an empty base set.
 *
 * Generated; pinned against `src/fixtures/library.json` by a test.
 */
import type { Indicator } from '@/lib/api'

/** Alpha158's 158 columns. Note MIN5..MIN60 -- qlib's `LOW` key emits `MIN`. */
export const ALPHA158_COLUMNS: readonly string[] = [
  'KMID', 'KLEN', 'KMID2', 'KUP', 'KUP2', 'KLOW', 'KLOW2', 'KSFT', 'KSFT2',
  'OPEN0', 'HIGH0', 'LOW0', 'VWAP0', 'ROC5', 'ROC10', 'ROC20', 'ROC30',
  'ROC60', 'MA5', 'MA10', 'MA20', 'MA30', 'MA60', 'STD5', 'STD10', 'STD20',
  'STD30', 'STD60', 'BETA5', 'BETA10', 'BETA20', 'BETA30', 'BETA60',
  'RSQR5', 'RSQR10', 'RSQR20', 'RSQR30', 'RSQR60', 'RESI5', 'RESI10',
  'RESI20', 'RESI30', 'RESI60', 'MAX5', 'MAX10', 'MAX20', 'MAX30', 'MAX60',
  'MIN5', 'MIN10', 'MIN20', 'MIN30', 'MIN60', 'QTLU5', 'QTLU10', 'QTLU20',
  'QTLU30', 'QTLU60', 'QTLD5', 'QTLD10', 'QTLD20', 'QTLD30', 'QTLD60',
  'RANK5', 'RANK10', 'RANK20', 'RANK30', 'RANK60', 'RSV5', 'RSV10', 'RSV20',
  'RSV30', 'RSV60', 'IMAX5', 'IMAX10', 'IMAX20', 'IMAX30', 'IMAX60',
  'IMIN5', 'IMIN10', 'IMIN20', 'IMIN30', 'IMIN60', 'IMXD5', 'IMXD10',
  'IMXD20', 'IMXD30', 'IMXD60', 'CORR5', 'CORR10', 'CORR20', 'CORR30',
  'CORR60', 'CORD5', 'CORD10', 'CORD20', 'CORD30', 'CORD60', 'CNTP5',
  'CNTP10', 'CNTP20', 'CNTP30', 'CNTP60', 'CNTN5', 'CNTN10', 'CNTN20',
  'CNTN30', 'CNTN60', 'CNTD5', 'CNTD10', 'CNTD20', 'CNTD30', 'CNTD60',
  'SUMP5', 'SUMP10', 'SUMP20', 'SUMP30', 'SUMP60', 'SUMN5', 'SUMN10',
  'SUMN20', 'SUMN30', 'SUMN60', 'SUMD5', 'SUMD10', 'SUMD20', 'SUMD30',
  'SUMD60', 'VMA5', 'VMA10', 'VMA20', 'VMA30', 'VMA60', 'VSTD5', 'VSTD10',
  'VSTD20', 'VSTD30', 'VSTD60', 'WVMA5', 'WVMA10', 'WVMA20', 'WVMA30',
  'WVMA60', 'VSUMP5', 'VSUMP10', 'VSUMP20', 'VSUMP30', 'VSUMP60', 'VSUMN5',
  'VSUMN10', 'VSUMN20', 'VSUMN30', 'VSUMN60', 'VSUMD5', 'VSUMD10',
  'VSUMD20', 'VSUMD30', 'VSUMD60'
]

/**
 * Alpha360's 360 columns, by construction.
 *
 * Six fields at sixty lags each. Generated rather than listed because the shape
 * is regular and 360 strings is noise -- and because the only fact that matters
 * here is that Alpha360 contributes *no rolling names at all*, so a custom
 * column called `MA5` collides under Alpha158 and is free under Alpha360.
 */
export function alpha360Columns(): string[] {
  const out: string[] = []
  for (const field of ['CLOSE', 'OPEN', 'HIGH', 'LOW', 'VWAP', 'VOLUME']) {
    for (let lag = 0; lag < 60; lag++) out.push(`${field}${lag}`)
  }
  return out
}

/**
 * What `handler` already computes, preferring the served answer.
 *
 * `indicators` is the payload the canvas fetched. When it has not arrived the
 * built-in list stands in, which is why this never returns an empty set.
 */
export function baseColumns(handler: string, indicators: Indicator[]): ReadonlySet<string> {
  if (handler === 'Alpha360') return new Set(alpha360Columns())

  const served = indicators.filter((i) => i.in_handler).map((i) => i.name)
  return new Set(served.length ? served : ALPHA158_COLUMNS)
}
