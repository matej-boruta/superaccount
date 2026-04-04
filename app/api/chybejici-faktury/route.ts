/**
 * Detekuje faktury, které pravděpodobně chybí.
 * Zdroj: nesparované odchozí platby — pro každou platbu hledáme, zda existuje faktura.
 * Kontext: dodavatel je identifikován z pravidla nebo historických faktur (zprava match).
 * Výstup: jeden řádek na dodavatele — měsíc platby, počet plateb, celková hodnota.
 */
import { NextResponse } from 'next/server'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY!

const SB = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const now = new Date()
  const rok = parseInt(searchParams.get('rok') ?? String(now.getFullYear()))

  // Fetch in parallel: nesparované odchozí transakce + všechny dodavatele z faktur roku + pravidla
  const [transakceRes, fakturyRes, pravidlaRes] = await Promise.all([
    fetch(
      `${SUPABASE_URL}/rest/v1/transakce?stav=eq.nesparovano&castka=lt.0&datum=gte.${rok}-01-01&datum=lte.${rok}-12-31&select=id,castka,mena,zprava,datum&order=datum.asc`,
      { headers: SB }
    ),
    fetch(
      `${SUPABASE_URL}/rest/v1/faktury?datum_vystaveni=gte.${rok}-01-01&datum_vystaveni=lte.${rok}-12-31&select=dodavatel,datum_vystaveni,castka_s_dph,mena`,
      { headers: SB }
    ),
    fetch(
      `${SUPABASE_URL}/rest/v1/pravidla?select=dodavatel,dodavatel_pattern`,
      { headers: SB }
    ),
  ])

  const transakce: {
    id: number
    castka: number
    mena: string
    zprava: string | null
    datum: string
  }[] = await transakceRes.json()

  const faktury: {
    dodavatel: string
    datum_vystaveni: string
    castka_s_dph: number
    mena: string
  }[] = await fakturyRes.json()

  const pravidla: {
    dodavatel: string
    dodavatel_pattern: string
  }[] = await pravidlaRes.json()

  if (!Array.isArray(transakce) || transakce.length === 0) return NextResponse.json([])

  // Build lookup: pattern → dodavatel name (from pravidla)
  const pravidlaMap: { pattern: string; dodavatel: string }[] = Array.isArray(pravidla)
    ? pravidla.filter(p => p.dodavatel_pattern).map(p => ({
        pattern: p.dodavatel_pattern.replace(/%/g, '').toLowerCase(),
        dodavatel: p.dodavatel,
      }))
    : []

  // Build lookup: known dodavatelé from historical faktury (unique names)
  const knownDodavatele: string[] = Array.isArray(faktury)
    ? [...new Set(faktury.map(f => f.dodavatel).filter(Boolean))]
    : []

  // Build set of (dodavatel × month) that already have a faktura
  const fakturyMonths = new Set<string>()
  for (const f of Array.isArray(faktury) ? faktury : []) {
    if (!f.datum_vystaveni || !f.dodavatel) continue
    const m = new Date(f.datum_vystaveni).getMonth() + 1
    fakturyMonths.add(`${f.dodavatel}|${m}`)
  }

  // For each transakce, identify dodavatel
  function identifyDodavatel(zprava: string | null): string | null {
    if (!zprava) return null
    const zpravaLower = zprava.toLowerCase()

    // 1. Match pravidla pattern
    for (const p of pravidlaMap) {
      if (p.pattern && zpravaLower.includes(p.pattern)) return p.dodavatel
    }

    // 2. Match known dodavatel names from historical faktury
    for (const d of knownDodavatele) {
      // Match at least first meaningful word (≥4 chars) of dodavatel name
      const words = d.toLowerCase().split(/\s+/).filter(w => w.length >= 4)
      if (words.length > 0 && words.some(w => zpravaLower.includes(w))) return d
    }

    return null
  }

  // Group unmatched payments by dodavatel+month (ne jen dodavatel)
  // Bug fix: groupování jen po dodavateli způsobovalo, že jeden měsíc s fakturou
  // vyfiltroval celého dodavatele — i měsíce kde faktura chybí
  type Group = {
    dodavatel: string
    month: number
    payments: { castka: number; mena: string; datum: string }[]
    faktura_exists: boolean
  }
  const groups = new Map<string, Group>()

  for (const t of transakce) {
    const dodavatel = identifyDodavatel(t.zprava)
    if (!dodavatel) continue

    const month = new Date(t.datum).getMonth() + 1
    const hasFaktura = fakturyMonths.has(`${dodavatel}|${month}`)

    // Klíč = dodavatel + měsíc — každý měsíc hodnotíme zvlášť
    const key = `${dodavatel}|${month}`
    const prev = groups.get(key)
    if (!prev) {
      groups.set(key, {
        dodavatel,
        month,
        payments: [{ castka: Math.abs(t.castka), mena: t.mena, datum: t.datum }],
        faktura_exists: hasFaktura,
      })
    } else {
      prev.payments.push({ castka: Math.abs(t.castka), mena: t.mena, datum: t.datum })
      if (hasFaktura) prev.faktura_exists = true
    }
  }

  // Build result — only groups where no matching faktura exists for that month
  const MONTH_NAMES = ['', 'Leden', 'Únor', 'Březen', 'Duben', 'Květen', 'Červen',
    'Červenec', 'Srpen', 'Září', 'Říjen', 'Listopad', 'Prosinec']

  const result = [...groups.values()]
    .filter(g => !g.faktura_exists)
    .map(g => {
      const totalCastka = g.payments.reduce((s, p) => s + p.castka, 0)
      const mena = g.payments[0]?.mena ?? 'CZK'
      return {
        dodavatel: g.dodavatel,
        chybi_mesic: g.month,
        chybi_mesic_nazev: MONTH_NAMES[g.month] ?? '',
        nesparovana_count: g.payments.length,
        nesparovana_castka: totalCastka,
        nesparovana_mena: mena,
      }
    })
    .sort((a, b) => b.nesparovana_castka - a.nesparovana_castka)

  return NextResponse.json(result)
}
