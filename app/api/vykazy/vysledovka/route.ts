/**
 * Analytická výsledovka z ABRA — faktura-prijata (FP-* kódy) jako jediná pravda.
 * Skupinuje dle kategorie z SB (přes FP-{id} mapování) a měsíce dle datUcto.
 */
import { NextResponse } from 'next/server'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY!
const ABRA_URL = process.env.ABRA_URL!
const ABRA_USER = process.env.ABRA_USER!
const ABRA_PASS = process.env.ABRA_PASS!
const ABRA_AUTH = 'Basic ' + Buffer.from(`${ABRA_USER}:${ABRA_PASS}`).toString('base64')

export async function GET() {
  const now = new Date()
  const currentYear = now.getFullYear()
  const currentMonth = now.getMonth() + 1

  // 1. Fetch ABRA faktura-prijata — only FP-* records (SuperAccount managed)
  const faRes = await fetch(
    `${ABRA_URL}/faktura-prijata.json?fields=id,kod,datUcto,datVyst,sumZklCelkem,sumCelkem,nazFirmy,popis,mena&limit=1000`,
    { headers: { Authorization: ABRA_AUTH } }
  )
  const faData = await faRes.json()
  const abraFaktury: {
    id: string
    kod: string
    datUcto: string
    datVyst: string
    sumZklCelkem: string
    sumCelkem: string
    nazFirmy: string
    popis: string
    mena: string
  }[] = (faData?.winstrom?.['faktura-prijata'] ?? []).filter((f: { kod: string }) => f.kod?.startsWith('FP-'))

  // 2. Extract SB faktura IDs from ABRA kódy (FP-{id}-{year})
  const sbIdToAbraMap = new Map<number, typeof abraFaktury[0]>()
  for (const f of abraFaktury) {
    const m = f.kod.match(/^FP-(\d+)-\d+$/)
    if (m) sbIdToAbraMap.set(parseInt(m[1]), f)
  }

  // 3. Fetch SB kategorie for those IDs
  const sbIds = [...sbIdToAbraMap.keys()]
  const [fakturyRes, kategorieRes] = await Promise.all([
    fetch(
      `${SUPABASE_URL}/rest/v1/faktury?id=in.(${sbIds.join(',')})&select=id,kategorie_id`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    ),
    fetch(
      `${SUPABASE_URL}/rest/v1/kategorie?select=id,l1,l2,ucetni_kod,stredisko`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    ),
  ])

  const sbFaktury: { id: number; kategorie_id: number | null }[] = sbIds.length > 0 ? await fakturyRes.json() : []
  const kategorie: { id: number; l1: string; l2: string; ucetni_kod: string; stredisko: string }[] = await kategorieRes.json()

  const katMap = new Map(kategorie.map(k => [k.id, k]))
  const sbKatMap = new Map(sbFaktury.map(f => [f.id, f.kategorie_id]))

  const months: number[] = Array.from({ length: currentMonth }, (_, i) => i + 1)

  // 4. Aggregate by category and month
  type Row = { ucetni_kod: string; l1: string; l2: string; stredisko: string; mesice: Record<number, number> }
  const rowMap = new Map<string, Row>()

  for (const [sbId, abraF] of sbIdToAbraMap.entries()) {
    // Use datUcto (accounting date) — fall back to datVyst
    const dateStr = abraF.datUcto || abraF.datVyst || ''
    const dateClean = dateStr.split('+')[0].split('T')[0]  // "2026-01-15"
    if (!dateClean) continue
    const d = new Date(dateClean)
    if (d.getFullYear() !== currentYear) continue
    const month = d.getMonth() + 1
    if (month < 1 || month > currentMonth) continue

    const kategId = sbKatMap.get(sbId) ?? null
    const kat = kategId ? katMap.get(kategId) : null

    const key = kat ? kat.ucetni_kod : 'nezarazeno'

    // Only include P&L accounts (5xx expenses, 6xx revenues) — skip balance sheet (261xx, 321xx etc.)
    if (key !== 'nezarazeno' && !key.startsWith('5') && !key.startsWith('6')) continue

    const l1 = kat?.l1 ?? 'Nezařazeno'
    const l2 = kat?.l2 ?? ''
    const stredisko = kat?.stredisko ?? ''

    if (!rowMap.has(key)) rowMap.set(key, { ucetni_kod: key, l1, l2, stredisko, mesice: {} })

    // Use sumZklCelkem (excl. VAT) — for foreign invoices without CZ VAT this equals sumCelkem
    const amount = parseFloat(abraF.sumZklCelkem || '0') || parseFloat(abraF.sumCelkem || '0')
    const row = rowMap.get(key)!
    row.mesice[month] = (row.mesice[month] ?? 0) + amount
  }

  const naklady = [...rowMap.values()].sort((a, b) => a.ucetni_kod.localeCompare(b.ucetni_kod))

  function monthTotals(rows: Row[]): Record<number, number> {
    const t: Record<number, number> = {}
    for (const row of rows) {
      for (const [m, v] of Object.entries(row.mesice)) {
        t[Number(m)] = (t[Number(m)] ?? 0) + v
      }
    }
    return t
  }

  return NextResponse.json({
    year: currentYear,
    months,
    naklady,
    nakladyTotal: monthTotals(naklady),
    vynosy: {} as Record<number, number>,  // vydané faktury zatím nejsou v ABRA
    abraTotal: abraFaktury.length,
    poznamka: `Zdroj: ABRA faktura-prijata (${abraFaktury.length} FP- záznamů), kategorizace z SuperAccount`,
  })
}
