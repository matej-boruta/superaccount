/**
 * Detekuje faktury, které pravděpodobně chybí v aktuálním účetním období.
 * Logika: dodavatel měl faktury v předchozích měsících, ale v aktuálním měsíci žádná nepřišla.
 * Suma: součet nesparovaných odchozích plateb, kde zprava obsahuje jméno dodavatele.
 */
import { NextResponse } from 'next/server'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY!

const SB_HEADERS = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
}

export async function GET() {
  const now = new Date()
  const currentYear = now.getFullYear()
  const currentMonth = now.getMonth() + 1 // 1-12

  // Fetch all faktury from this year + nesparované odchozí transakce in parallel
  const [fakturyRes, transakceRes] = await Promise.all([
    fetch(
      `${SUPABASE_URL}/rest/v1/faktury?datum_vystaveni=gte.${currentYear}-01-01&select=id,dodavatel,castka_s_dph,mena,datum_vystaveni,stav&order=datum_vystaveni.asc`,
      { headers: SB_HEADERS }
    ),
    fetch(
      `${SUPABASE_URL}/rest/v1/transakce?stav=eq.nesparovano&castka=lt.0&select=id,castka,mena,zprava`,
      { headers: SB_HEADERS }
    ),
  ])

  const faktury: {
    id: number
    dodavatel: string
    castka_s_dph: number
    mena: string
    datum_vystaveni: string
    stav: string
  }[] = await fakturyRes.json()

  const transakce: {
    id: number
    castka: number
    mena: string
    zprava: string | null
  }[] = await transakceRes.json()

  if (!Array.isArray(faktury)) return NextResponse.json([])

  // Group by supplier → months they appeared in
  const supplierMonths = new Map<string, {
    months: Set<number>
    avgCastka: number
    mena: string
    hasCurrentMonth: boolean
    lastCastka: number
  }>()

  for (const f of faktury) {
    if (!f.datum_vystaveni || !f.dodavatel) continue
    const month = new Date(f.datum_vystaveni).getMonth() + 1
    const prev = supplierMonths.get(f.dodavatel)
    if (!prev) {
      supplierMonths.set(f.dodavatel, {
        months: new Set([month]),
        avgCastka: f.castka_s_dph,
        mena: f.mena,
        hasCurrentMonth: month === currentMonth,
        lastCastka: f.castka_s_dph,
      })
    } else {
      prev.months.add(month)
      if (month === currentMonth) prev.hasCurrentMonth = true
      prev.lastCastka = f.castka_s_dph
      prev.avgCastka = (prev.avgCastka + f.castka_s_dph) / 2
    }
  }

  // Find suppliers with ≥2 previous months but missing current month
  const missing: {
    dodavatel: string
    months_present: number[]
    avg_castka: number
    last_castka: number
    mena: string
    nesparovana_castka: number
    nesparovana_mena: string
  }[] = []

  for (const [dodavatel, info] of supplierMonths.entries()) {
    const previousMonths = [...info.months].filter(m => m < currentMonth)
    if (previousMonths.length >= 2 && !info.hasCurrentMonth) {
      // Sum nesparované odchozí transakce whose zprava contains the supplier name
      const dodavatelLower = dodavatel.toLowerCase()
      let nesparovanaSum = 0
      let nesparovatMena = info.mena
      for (const t of Array.isArray(transakce) ? transakce : []) {
        if (t.zprava && t.zprava.toLowerCase().includes(dodavatelLower)) {
          nesparovanaSum += Math.abs(t.castka)
          nesparovatMena = t.mena || nesparovatMena
        }
      }

      missing.push({
        dodavatel,
        months_present: [...info.months].sort((a, b) => a - b),
        avg_castka: info.avgCastka,
        last_castka: info.lastCastka,
        mena: info.mena,
        nesparovana_castka: nesparovanaSum,
        nesparovana_mena: nesparovatMena,
      })
    }
  }

  // Sort by last_castka desc (most important first)
  missing.sort((a, b) => b.last_castka - a.last_castka)

  return NextResponse.json(missing)
}
