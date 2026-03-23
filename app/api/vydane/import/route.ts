/**
 * POST /api/vydane/import
 *
 * Importuje vydané faktury z CSV.
 * Podporované sloupce (hlavička v prvním řádku, libovolné pořadí):
 *   cislo_faktury, odberatel, castka_bez_dph, dph, castka_s_dph,
 *   mena, datum_vystaveni, datum_splatnosti, variabilni_symbol, popis
 *
 * Deduplikace podle cislo_faktury.
 */
import { NextResponse } from 'next/server'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY!
const SB = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
const SB_W = { ...SB, 'Content-Type': 'application/json', Prefer: 'return=minimal' }

function parseCSV(text: string): Record<string, string>[] {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim().split('\n')
  if (lines.length < 2) return []
  // Detect delimiter (semicolon or comma)
  const delim = lines[0].includes(';') ? ';' : ','
  const headers = lines[0].split(delim).map(h => h.trim().replace(/^"|"$/g, '').toLowerCase())
  const rows: Record<string, string>[] = []
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue
    const vals = lines[i].split(delim).map(v => v.trim().replace(/^"|"$/g, ''))
    const row: Record<string, string> = {}
    headers.forEach((h, idx) => { row[h] = vals[idx] ?? '' })
    rows.push(row)
  }
  return rows
}

function parseDate(s: string): string | null {
  if (!s) return null
  // DD.MM.YYYY → YYYY-MM-DD
  const dmY = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/)
  if (dmY) return `${dmY[3]}-${dmY[2].padStart(2, '0')}-${dmY[1].padStart(2, '0')}`
  // Already YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10)
  return null
}

export async function POST(req: Request) {
  const text = await req.text()
  const rows = parseCSV(text)
  if (!rows.length) return NextResponse.json({ error: 'Prázdný nebo neplatný CSV soubor' }, { status: 400 })

  let imported = 0
  let skipped = 0
  const errors: string[] = []

  for (const row of rows) {
    const cislo = row['cislo_faktury'] || row['číslo faktury'] || row['cislo'] || ''
    if (!cislo) { errors.push('Řádek bez cislo_faktury přeskočen'); continue }

    // Deduplikace
    const checkRes = await fetch(
      `${SUPABASE_URL}/rest/v1/faktury_vydane?cislo_faktury=eq.${encodeURIComponent(cislo)}&select=id&limit=1`,
      { headers: SB }
    )
    const existing = await checkRes.json()
    if (existing?.length > 0) { skipped++; continue }

    const castka_s_dph = parseFloat(row['castka_s_dph'] || row['částka s dph'] || '0') || 0
    const castka_bez_dph = parseFloat(row['castka_bez_dph'] || row['částka bez dph'] || '0') || 0
    const dph = parseFloat(row['dph'] || '21') || 21

    const faktura = {
      cislo_faktury: cislo,
      odberatel: row['odberatel'] || row['odběratel'] || '',
      castka_bez_dph,
      dph,
      castka_s_dph,
      mena: row['mena'] || row['měna'] || 'CZK',
      datum_vystaveni: parseDate(row['datum_vystaveni'] || row['datum vystavení'] || '') ?? new Date().toISOString().slice(0, 10),
      datum_splatnosti: parseDate(row['datum_splatnosti'] || row['datum splatnosti'] || '') ?? null,
      variabilni_symbol: row['variabilni_symbol'] || row['variabilní symbol'] || row['vs'] || null,
      popis: row['popis'] || null,
      stav: 'nova',
    }

    const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/faktury_vydane`, {
      method: 'POST',
      headers: SB_W,
      body: JSON.stringify(faktura),
    })

    if (!insertRes.ok) {
      const err = await insertRes.text()
      errors.push(`${cislo}: ${err.substring(0, 100)}`)
    } else {
      imported++
    }
  }

  return NextResponse.json({ ok: true, imported, skipped, errors })
}
