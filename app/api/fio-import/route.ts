/**
 * Fio Import — stáhne transakce ze všech účtů a uloží do Supabase
 * Deduplikuje přes fio_id (conflict ignore).
 *
 * Účty (pouze tokeny Boruta, Matěj):
 *   CZK 1: tp1F55JlAY1MssWulLFAdqNOoywLCpmCXX6kZcnaOhkimfW0Iz0PSXmSSUCmaOQg  (2503421631)
 *   CZK 2: 4f854NkIPOKplYpNUDswBfvLiIlLvu3jJJdvd6npumxYe1KiILI8qZpXYQRsWSmE  (2500323753)
 *
 * Fio rate limit: 1 request / 30s per token
 */

import { NextResponse } from 'next/server'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY!

const FIO_TOKENS = [
  { token: 'tp1F55JlAY1MssWulLFAdqNOoywLCpmCXX6kZcnaOhkimfW0Iz0PSXmSSUCmaOQg', label: 'CZK1' },
  { token: '4f854NkIPOKplYpNUDswBfvLiIlLvu3jJJdvd6npumxYe1KiILI8qZpXYQRsWSmE', label: 'CZK2' },
]

const SB_HEADERS = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
  Prefer: 'resolution=ignore-duplicates,return=minimal',
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function parseFioTx(data: Record<string, unknown>, ucet: string) {
  const stmt = data.accountStatement as Record<string, unknown>
  const txList = (stmt?.transactionList as Record<string, unknown>)?.transaction as Record<string, unknown>[] | null
  if (!txList?.length) return []

  return txList.map(t => {
    const col = (name: string) => (t[name] as Record<string, unknown> | null)?.value ?? null
    return {
      fio_id: String(col('column22') ?? ''),
      ucet,
      datum: col('column0') ? String(col('column0')).substring(0, 10) : null,
      castka: col('column1') ? Number(col('column1')) : 0,
      mena: col('column14') ?? 'CZK',
      protiucet: col('column2') ? String(col('column2')) : null,
      zprava: col('column16') ?? col('column25') ?? null,
      variabilni_symbol: col('column5') ? String(col('column5')) : null,
      typ: col('column8') ? String(col('column8')) : null,
      stav: 'nesparovano',
    }
  })
}

export async function POST() {
  const log: { ucet: string; count: number; saved: number; error?: string }[] = []

  for (let i = 0; i < FIO_TOKENS.length; i++) {
    if (i > 0) await sleep(35_000) // Fio rate limit: 35s between calls

    const { token, label } = FIO_TOKENS[i]
    try {
      const fioRes = await fetch(
        `https://fioapi.fio.cz/v1/rest/last/${token}/transactions.json`,
        { signal: AbortSignal.timeout(15_000) }
      )
      const data = await fioRes.json()
      const stmt = data?.accountStatement
      if (!stmt) {
        log.push({ ucet: label, count: 0, saved: 0, error: 'no accountStatement' })
        continue
      }

      const ucet: string = stmt.info?.iban || stmt.info?.accountId || label
      const rows = parseFioTx(data, ucet)

      if (!rows.length) {
        log.push({ ucet: label, count: 0, saved: 0 })
        continue
      }

      const sbRes = await fetch(`${SUPABASE_URL}/rest/v1/transakce`, {
        method: 'POST',
        headers: SB_HEADERS,
        body: JSON.stringify(rows),
      })

      log.push({
        ucet: label,
        count: rows.length,
        saved: sbRes.ok ? rows.length : 0,
        error: sbRes.ok ? undefined : `HTTP ${sbRes.status}`,
      })
    } catch (e) {
      log.push({ ucet: label, count: 0, saved: 0, error: String(e) })
    }
  }

  const totalSaved = log.reduce((s, l) => s + l.saved, 0)
  return NextResponse.json({ ok: true, totalSaved, log })
}
