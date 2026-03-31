import { NextResponse } from 'next/server'
import { callClaude, SYSTEM_AUDIT } from '@/lib/claude'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY!
const ABRA_URL = process.env.ABRA_URL!
const ABRA_USER = process.env.ABRA_USER!
const ABRA_PASS = process.env.ABRA_PASS!
const ABRA_AUTH = 'Basic ' + Buffer.from(`${ABRA_USER}:${ABRA_PASS}`).toString('base64')
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY!

const SB_HEADERS = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
  Prefer: 'return=minimal',
}

function daysDiff(a: string, b: string): number {
  return Math.abs((new Date(a).getTime() - new Date(b).getTime()) / 86400000)
}

// Extract original foreign currency amount from Fio card transaction message
// e.g. "Nákup: WWW.TWILIO.COM, ..., částka  44.95 USD" → { amount: 44.95, mena: 'USD' }
function extractFxFromZprava(zprava: string): { amount: number; mena: string } | null {
  const match = zprava.match(/(?:částka|amount)\s+([\d.,]+)\s+([A-Z]{3})/i)
  if (!match) return null
  const amount = parseFloat(match[1].replace(',', '.'))
  const mena = match[2].toUpperCase()
  if (isNaN(amount) || mena === 'CZK') return null
  return { amount, mena }
}

// Extract payment date from Fio zprava: "dne 11.3.2026" → "2026-03-11"
function extractDateFromZprava(zprava: string): string | null {
  const m = zprava.match(/dne\s+(\d{1,2})\.(\d{1,2})\.(\d{4})/i)
  if (!m) return null
  return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`
}

// Fetch EUR/USD/GBP→CZK rate from ČNB for a given date
const kurzyCache: Record<string, number> = {}
async function getKurz(mena: string, datum: string): Promise<number> {
  if (mena === 'CZK') return 1
  const key = `${mena}_${datum}`
  if (kurzyCache[key]) return kurzyCache[key]

  try {
    // ČNB daily rates API
    const [y, m, d] = datum.split('-')
    const url = `https://www.cnb.cz/en/financial-markets/foreign-exchange-market/central-bank-exchange-rate-fixing/central-bank-exchange-rate-fixing/daily.txt?date=${d}.${m}.${y}`
    const res = await fetch(url)
    const text = await res.text()
    // Format: "Country|Currency|Amount|Code|Rate"
    const line = text.split('\n').find(l => l.includes(`|${mena}|`))
    if (line) {
      const parts = line.split('|')
      const amount = parseFloat(parts[2])
      const rate = parseFloat(parts[4].replace(',', '.'))
      const kurz = rate / amount
      kurzyCache[key] = kurz
      return kurz
    }
  } catch { /* fallback */ }

  // Fallback: approximate rates
  const fallback: Record<string, number> = { EUR: 25.2, USD: 23.1, GBP: 29.5 }
  return fallback[mena] ?? 1
}

type CardRule = { keyword: string; dodavatelMatch: string }

async function getCardRules(): Promise<{ keyword: string; dodavatelMatch: string }[]> {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/ucetni_pravidla?typ_platby=eq.karta&aktivni=eq.true&parovat_keyword=not.is.null&select=parovat_keyword,dodavatel_pattern`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    )
    const rows: { parovat_keyword: string; dodavatel_pattern: string }[] = await res.json()
    if (!Array.isArray(rows)) return []
    return rows.map(r => ({
      keyword: r.parovat_keyword.toUpperCase(),
      dodavatelMatch: (r.dodavatel_pattern ?? '').replace(/%/g, '').toUpperCase(),
    }))
  } catch { return [] }
}

async function matchByCard(
  t: Record<string, unknown>,
  f: Record<string, unknown>,
  cardRules: CardRule[]
): Promise<boolean> {
  if (t.typ !== 'Platba kartou') return false
  const zprava = String(t.zprava || '').toUpperCase()
  const dodavatel = String(f.dodavatel || '').toUpperCase()

  // Musí existovat pravidlo kde ZÁROVEŇ:
  // 1. keyword pravidla je v textu zprávy transakce
  // 2. dodavatel faktury odpovídá dodavatelMatch pravidla (pokud je specifikován)
  // Bez tohoto by FACEBK transakce mohla matchovat Google fakturu s podobnou částkou.
  const matchingRule = cardRules.find(s =>
    zprava.includes(s.keyword) &&
    (s.dodavatelMatch.length === 0 || dodavatel.includes(s.dodavatelMatch))
  )
  if (!matchingRule) return false

  // Amount match — handle EUR/USD faktury vs CZK bank transactions
  const fCastka = Number(f.castka_s_dph)
  const tCastka = Math.abs(Number(t.castka))
  const fMena = String(f.mena || 'CZK')
  const tMena = String(t.mena || 'CZK')

  let amountMatch = false
  if (fMena === tMena) {
    amountMatch = Math.abs(tCastka - fCastka) < 1
  } else if (fMena !== 'CZK' && tMena === 'CZK') {
    // Faktura in EUR/USD, transaction in CZK — convert via ČNB rate
    const tDate = String(t.datum || '').split('T')[0]
    const kurz = await getKurz(fMena, tDate)
    const fCzkEquiv = fCastka * kurz
    // Allow 2% tolerance for exchange rate differences
    amountMatch = Math.abs(tCastka - fCzkEquiv) / fCzkEquiv < 0.02
  }
  if (!amountMatch) return false

  // Date: "dne" date from zprava = datum when card was charged (= datum_splatnosti).
  // Bank posts it D+1. Tolerance ±2 days for weekends/holidays.
  const fDate = String(f.datum_splatnosti || f.datum_vystaveni || '').split('T')[0]
  const tDate = extractDateFromZprava(String(t.zprava || '')) ?? String(t.datum || '').split('T')[0]
  if (!fDate || !tDate) return false
  if (daysDiff(fDate, tDate) > 2) return false

  return true
}

// Cache kategorie ucetni_kod
let kategorieCache: Record<number, string> | null = null
async function getUcetniKod(kategorieId: number | null): Promise<string> {
  if (!kategorieId) return '518900'  // fallback: ostatní služby
  if (!kategorieCache) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/kategorie?select=id,ucetni_kod`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    })
    const rows: { id: number; ucetni_kod: string }[] = await res.json()
    kategorieCache = Object.fromEntries(rows.map(r => [r.id, r.ucetni_kod]))
  }
  // Only use 5xx accounts for expenses — skip balance sheet accounts (261xx etc.)
  const kod = kategorieCache[kategorieId] ?? '518900'
  return kod.startsWith('5') ? kod : '518900'
}

async function createAbraFakturaPrijata(
  f: Record<string, unknown>,
  alreadyPaid: boolean
): Promise<string | null> {
  const id = f.id as number
  const abraKod = `FP-${id}-${new Date().getFullYear()}`

  // Check if already exists
  const checkRes = await fetch(`${ABRA_URL}/faktura-prijata/(kod='${abraKod}').json?fields=id`, {
    headers: { Authorization: ABRA_AUTH },
  })
  const checkData = await checkRes.json()
  const existing = checkData?.winstrom?.['faktura-prijata']?.[0]
  if (existing?.id) return existing.id

  const mena = String(f.mena || 'CZK')
  const datVystRaw = String(f.datum_vystaveni || '')
  const datVystYear = datVystRaw ? parseInt(datVystRaw.split('-')[0]) : 0
  const datVyst = (datVystYear >= 2020 && datVystYear <= 2100)
    ? datVystRaw
    : new Date().toISOString().split('T')[0]
  const datSplatRaw = String(f.datum_splatnosti || '')
  const datSplatYear = datSplatRaw ? parseInt(datSplatRaw.split('-')[0]) : 0
  const datSplat = (datSplatYear >= 2020 && datSplatYear <= 2100) ? datSplatRaw : undefined
  const datUcto = new Date().toISOString().split('T')[0]

  // Reverse charge: zahraniční SaaS dodavatelé (Google, Meta, Microsoft, atd.) → §108 ZDPH
  const dodavatel = String(f.dodavatel || '')
  const isReverseCharge = [
    'Google', 'Meta', 'Facebook', 'Microsoft', 'Amazon', 'Apple',
    'Twilio', 'Daktela', 'Cloudflare', 'Stripe', 'LinkedIn', 'Adobe',
  ].some(s => dodavatel.toLowerCase().includes(s.toLowerCase()))
  const mena2 = String(f.mena || 'CZK')
  const isForeign = mena2 !== 'CZK' || isReverseCharge

  // sazbyDph: reverse charge pro zahraniční, základní pro domácí s DPH, osvobozeno jinak
  const sazbyDph = isReverseCharge
    ? 'typSazbyDph.dphPrenesen'   // §108 reverse charge
    : Number(f.dph) > 0
      ? 'typSazbyDph.zakladni'
      : 'typSazbyDph.dphOsvobozeno'

  const ucetniKod = await getUcetniKod(f.kategorie_id as number | null)

  const body: Record<string, unknown> = {
    typDokl: isForeign ? 'code:FAKTURA_ZAHRANICNI' : 'code:FAKTURA',
    kod: abraKod,
    cisDosle: f.cislo_faktury || abraKod,
    varSym: f.variabilni_symbol || '',
    datVyst,
    datUcto,
    popis: f.popis || f.dodavatel,
    mena: `code:${mena}`,
    polozkyFaktury: [{
      nazev: f.popis || f.dodavatel,
      cenaMj: Number(f.castka_bez_dph) || Number(f.castka_s_dph),
      mnozstvi: 1,
      sazbyDph,
      zklMdUcet: `code:${ucetniKod}`,  // 5xx nákladový účet dle kategorie
      zklDalUcet: 'code:321001',        // závazky z obchodních vztahů
    }],
  }
  if (datSplat) body.datSplat = datSplat
  if (alreadyPaid) body.stavUhrK = 'stavUhr.uhrazenoRucne'

  const res = await fetch(`${ABRA_URL}/faktura-prijata.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: ABRA_AUTH },
    body: JSON.stringify({ winstrom: { 'faktura-prijata': [body] } }),
  })
  const data = await res.json()
  return data?.winstrom?.results?.[0]?.id ?? null
}

async function pairInSupabase(fakturaId: number, transakceId: number) {
  await Promise.all([
    fetch(`${SUPABASE_URL}/rest/v1/transakce?id=eq.${transakceId}`, {
      method: 'PATCH',
      headers: SB_HEADERS,
      body: JSON.stringify({ stav: 'sparovano', faktura_id: fakturaId }),
    }),
    fetch(`${SUPABASE_URL}/rest/v1/faktury?id=eq.${fakturaId}`, {
      method: 'PATCH',
      headers: SB_HEADERS,
      body: JSON.stringify({ stav: 'zaplacena', zauctovano_at: new Date().toISOString() }),
    }),
  ])
}

async function createAbraBanka(
  f: Record<string, unknown>,
  t: Record<string, unknown>,
  abraFaId: string,
  overrideCastka?: number  // for M:N: use individual transaction amount
) {
  const fakturaId = f.id as number
  const transakceId = t.id as number
  const abraKod = `FP-${fakturaId}-${new Date().getFullYear()}`
  // Unique kod per transakce — prevents duplicate banka records on repeated runs
  const bankKod = `BNK-${transakceId}-${new Date().getFullYear()}`

  // Idempotency check: skip if banka record for this transakce already exists
  const checkRes = await fetch(`${ABRA_URL}/banka/(kod='${bankKod}').json?fields=id`, {
    headers: { Authorization: ABRA_AUTH },
  })
  const checkData = await checkRes.json()
  if (checkData?.winstrom?.banka?.[0]?.id) return  // already booked

  const datPlatby = String(t.datum || '').split('T')[0] || new Date().toISOString().split('T')[0]
  const castka = overrideCastka ?? Number(f.castka_s_dph)
  const mena = String(f.mena || 'CZK')

  const abraFaRes = await fetch(`${ABRA_URL}/faktura-prijata/${abraFaId}.json?fields=id,firma`, {
    headers: { Authorization: ABRA_AUTH },
  })
  const abraFaData = await abraFaRes.json()
  const abraFa = abraFaData?.winstrom?.['faktura-prijata']?.[0]

  const bankaRes = await fetch(`${ABRA_URL}/banka.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: ABRA_AUTH },
    body: JSON.stringify({
      winstrom: {
        banka: [{
          typDokl: 'code:STANDARD',
          kod: bankKod,
          banka: 'code:BANKOVNÍ ÚČET',
          typPohybuK: 'typPohybu.vydej',
          varSym: f.variabilni_symbol || '',
          datVyst: datPlatby,
          datUcto: datPlatby,
          popis: `Platba ${abraKod} - ${f.dodavatel}`,
          mena: `code:${mena}`,
          sumOsv: castka,
          primUcet: 'code:221001',
          protiUcet: 'code:321001',
          ...(abraFa?.firma ? { firma: abraFa.firma } : {}),
          uhrada: [{ dokladFaktPrij: { id: abraFaId }, castka }],
        }],
      },
    }),
  })
  const bankaData = await bankaRes.json()
  if (bankaData?.winstrom?.success === 'true') {
    await fetch(`${SUPABASE_URL}/rest/v1/faktury?id=eq.${fakturaId}`, {
      method: 'PATCH',
      headers: SB_HEADERS,
      body: JSON.stringify({ zauctovano_platba: true }),
    })
  }
}

// ── MODEL B AUDIT: verify each ABRA booking against Czech accounting rules ──
async function auditAbraBooking(
  f: Record<string, unknown>,
  mdUcet: string,
  dalUcet: string,
  castka: number,
  matchType: string
): Promise<void> {
  if (!ANTHROPIC_API_KEY) return

  const dodavatel = String(f.dodavatel || '')
  const mena = String(f.mena || 'CZK')
  const sazba = Number(f.dph ?? 0)
  const datum = String(f.datum_vystaveni || '').split('T')[0]
  const isForeign = !['CZK'].includes(mena) ||
    ['Google', 'Meta', 'Facebook', 'Twilio', 'Daktela', 'Microsoft', 'Amazon', 'Cloudflare'].some(
      s => dodavatel.toLowerCase().includes(s.toLowerCase())
    )

  const prompt = `Zkontroluj toto zaúčtování v ABRA Flexi:

Dodavatel: ${dodavatel}
Datum: ${datum}
Částka: ${castka} ${mena}
DPH sazba: ${sazba}%
MD účet: ${mdUcet}
DAL účet: ${dalUcet}
Typ platby/párování: ${matchType}
Zahraniční dodavatel: ${isForeign ? 'ANO' : 'NE'}

Zkontroluj:
1. Je souvztažnost MD ${mdUcet} / DAL ${dalUcet} správná pro tento typ výdaje?
2. Je DPH sazba ${sazba}% správná? (U zahraničních SaaS dodavatelů → reverse charge §108 ZDPH)
3. Je účet 518500 vhodný nebo má být jiný nákladový účet?`

  const auditText = await callClaude(
    ANTHROPIC_API_KEY,
    [{ role: 'user', content: prompt }],
    { model: 'claude-haiku-4-5-20251001', maxTokens: 200, system: SYSTEM_AUDIT }
  )

  let audit: { souhlas: boolean; confidence_korekce: number; poznamka: string } | null = null
  try {
    audit = JSON.parse(auditText?.match(/\{[\s\S]*\}/)?.[0] ?? '')
  } catch { /* ignore */ }

  // Log to agent_log
  await fetch(`${SUPABASE_URL}/rest/v1/agent_log`, {
    method: 'POST',
    headers: { ...SB_HEADERS, Prefer: 'return=minimal' },
    body: JSON.stringify({
      typ: audit?.souhlas === false ? 'audit_chyba' : 'audit_ok',
      vstup: { faktura_id: Number(f.id), dodavatel, md_ucet: mdUcet, dal_ucet: dalUcet, castka, matchType },
      vystup: audit ?? { raw: auditText },
      confidence: audit?.souhlas ? 90 : 10,
      pravidlo_zdroj: 'model_b_audit',
      faktura_id: Number(f.id),
      agent_id: 'superaccount',
    }),
  })

  // If audit disagrees → mark faktura for review
  if (audit?.souhlas === false) {
    await fetch(`${SUPABASE_URL}/rest/v1/faktury?id=eq.${f.id}`, {
      method: 'PATCH',
      headers: SB_HEADERS,
      body: JSON.stringify({ poznamka_audit: audit.poznamka }),
    })
  }
}

export async function POST() {
  const [fSchvalenaRes, fNovaRes, tRes] = await Promise.all([
    fetch(`${SUPABASE_URL}/rest/v1/faktury?stav=eq.schvalena&select=*`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    }),
    fetch(`${SUPABASE_URL}/rest/v1/faktury?stav=eq.nova&select=*`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    }),
    // Only odchozí platby (castka < 0) — příchozí platby se s fakturami nespárují nikdy
    fetch(`${SUPABASE_URL}/rest/v1/transakce?stav=eq.nesparovano&castka=lt.0&select=*`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    }),
  ])

  const schvalena: Record<string, unknown>[] = await fSchvalenaRes.json()
  const nova: Record<string, unknown>[] = await fNovaRes.json()
  const transakce: Record<string, unknown>[] = await tRes.json()

  const results: { faktura_id: number; transakce_id: number; match: string }[] = []

  // Load card rules from ucetni_pravidla (dynamic, includes Twilio/Daktela/etc.)
  const cardRules = await getCardRules()

  // ── CARD TRANSACTIONS: match nova + schvalena faktury via supplier name + amount + date ──
  const cardTranakce = transakce.filter(t => t.typ === 'Platba kartou')

  // ── M:N PAIRING: one invoice = many card transactions (e.g. Google Ads monthly invoice) ──
  // Strategy: sort invoices largest first, use greedy subset matching with 5% tolerance.
  // Multiple invoices from same supplier in same month → try to match each individually.
  const mnPaired = new Set<number>() // transakce IDs already used

  // Sort invoices: process SMALLEST amounts first — menší faktury dostanou přesnou podmnožinu
  // transakcí, zbývající transakce pak přesně odpovídají velké faktuře
  const sortedForMN = [...nova, ...schvalena].sort(
    (a, b) => Number(a.castka_s_dph) - Number(b.castka_s_dph)
  )

  for (const f of sortedForMN) {
    const fakturaId = f.id as number
    const dodavatel = String(f.dodavatel || '').toUpperCase()

    // Find matching rule with parovat_keyword — skip rules without dodavatel restriction (empty match)
    const rule = cardRules.find(r => r.dodavatelMatch.length > 0 && dodavatel.includes(r.dodavatelMatch))
    if (!rule) continue

    const fMonth = String(f.datum_vystaveni || '').slice(0, 7) // "2026-01"
    if (!fMonth) continue
    const fCastka = Number(f.castka_s_dph)

    // Get all available transactions matching keyword in same month
    const pool = transakce.filter(t => {
      if (mnPaired.has(t.id as number)) return false
      const zprava = String(t.zprava || '').toUpperCase()
      if (!zprava.includes(rule.keyword)) return false
      const tMonth = String(t.datum || '').slice(0, 7)
      return tMonth === fMonth
    })

    if (pool.length === 0) continue

    // Try to find a subset of transactions that sums to fCastka ±5%
    // First: check if ALL pool transactions match (common case when 1 invoice per month)
    const poolSum = pool.reduce((s, t) => s + Math.abs(Number(t.castka)), 0)
    const tolerance = fCastka * 0.05
    let candidates = pool

    if (Math.abs(poolSum - fCastka) > tolerance) {
      // Multiple invoices this month — try greedy accumulation up to fCastka
      // Sort by date ascending, accumulate until we hit the target amount
      const sorted = [...pool].sort((a, b) =>
        String(a.datum || '').localeCompare(String(b.datum || ''))
      )
      let acc = 0
      const subset: typeof pool = []
      for (const t of sorted) {
        const tAmt = Math.abs(Number(t.castka))
        if (acc + tAmt <= fCastka * 1.05) {
          subset.push(t)
          acc += tAmt
        }
        if (acc >= fCastka * 0.95) break
      }
      if (Math.abs(acc - fCastka) > tolerance) continue
      candidates = subset
    }

    // Match found — pair all candidates to this invoice
    // 1. Create one faktura-prijata in ABRA for the whole invoice
    let abraFaId: string | null = null
    try {
      abraFaId = await createAbraFakturaPrijata(f, true)
    } catch { /* non-blocking */ }

    let firstPair = true
    for (const t of candidates) {
      mnPaired.add(t.id as number)
      const transakceId = t.id as number
      const tCastka = Math.abs(Number(t.castka))

      await fetch(`${SUPABASE_URL}/rest/v1/transakce?id=eq.${transakceId}`, {
        method: 'PATCH',
        headers: SB_HEADERS,
        body: JSON.stringify({ stav: 'sparovano', faktura_id: fakturaId }),
      })

      if (firstPair) {
        await fetch(`${SUPABASE_URL}/rest/v1/faktury?id=eq.${fakturaId}`, {
          method: 'PATCH',
          headers: SB_HEADERS,
          body: JSON.stringify({ stav: 'zaplacena', zauctovano_at: new Date().toISOString() }),
        })
        firstPair = false
      }

      // 2. Create individual banka record in ABRA for each transaction (with its own amount)
      if (abraFaId) {
        try {
          await createAbraBanka(f, t, abraFaId, tCastka)
        } catch { /* non-blocking */ }
      }

      results.push({ faktura_id: fakturaId, transakce_id: transakceId, match: `mn_keyword_${rule.keyword}` })
    }

    // Audit the M:N booking with Model B (fire-and-forget)
    auditAbraBooking(f, '518500', '321001', Number(f.castka_s_dph), `mn_keyword_${rule.keyword}`)
      .catch(() => {})

    // Remove paired transactions from global pool
    for (const t of candidates) {
      const idx = transakce.indexOf(t)
      if (idx >= 0) transakce.splice(idx, 1)
      const cidx = cardTranakce.indexOf(t)
      if (cidx >= 0) cardTranakce.splice(cidx, 1)
    }
  }

  for (const f of [...nova, ...schvalena]) {
    if (results.find(r => r.faktura_id === (f.id as number))) continue  // skip already M:N paired
    const matchResults = await Promise.all(cardTranakce.map(t => matchByCard(t, f, cardRules)))
    const match = cardTranakce.find((_, i) => matchResults[i])
    if (!match) continue

    const fakturaId = f.id as number
    const transakceId = match.id as number

    // Remove from candidates
    cardTranakce.splice(cardTranakce.indexOf(match), 1)
    const globalIdx = transakce.indexOf(match)
    if (globalIdx >= 0) transakce.splice(globalIdx, 1)

    try {
      // Create ABRA faktura-prijata (already paid → stavUhrK=uhrazenoRucne)
      const abraFaId = await createAbraFakturaPrijata(f, true)

      // Pair in Supabase
      await pairInSupabase(fakturaId, transakceId)

      // Create ABRA banka record
      if (abraFaId) await createAbraBanka(f, match, abraFaId)

      results.push({ faktura_id: fakturaId, transakce_id: transakceId, match: 'card' })

      // Model B audit (fire-and-forget)
      auditAbraBooking(f, '518500', '221001', Number(f.castka_s_dph), 'card').catch(() => {})
    } catch { /* non-blocking */ }
  }

  // ── STANDARD: match schvalena faktury via VS + amount ──
  for (const f of schvalena) {
    // Skip if already paired above
    if (results.find(r => r.faktura_id === (f.id as number))) continue

    const fVs = String(f.variabilni_symbol || '').trim()
    const fCastka = Number(f.castka_s_dph)

    const fMena = String(f.mena || 'CZK')

    // Helper: check if transaction amount matches faktura amount (with currency conversion)
    const amountMatches = async (t: Record<string, unknown>) => {
      const tCastka = Math.abs(Number(t.castka))
      const tMena = String(t.mena || 'CZK')
      // 0. Extract original FX from zprava (most reliable for card payments)
      const fx = extractFxFromZprava(String(t.zprava || ''))
      if (fx && fx.mena === fMena && Math.abs(fx.amount - fCastka) / fCastka < 0.01) return true
      // 1. Same currency → direct compare
      if (fMena === tMena) return Math.abs(tCastka - fCastka) / Math.max(fCastka, 1) < 0.02
      // 2. Foreign invoice, CZK transaction → convert via ČNB
      if (fMena !== 'CZK' && tMena === 'CZK') {
        const tDate = String(t.datum || '').split('T')[0]
        const kurz = await getKurz(fMena, tDate)
        const fCzkEquiv = fCastka * kurz
        return fCzkEquiv > 0 && Math.abs(tCastka - fCzkEquiv) / fCzkEquiv < 0.02
      }
      return false
    }

    // Priority 1: VS + amount
    let match: Record<string, unknown> | undefined
    let matchType = 'vs+castka'
    for (const t of transakce) {
      if (String(t.variabilni_symbol || '').trim() !== fVs || fVs === '') continue
      if (await amountMatches(t)) { match = t; break }
    }

    // Priority 2: VS + amount within 30% (VS-only without amount check causes false matches)
    if (!match && fVs) {
      match = transakce.find(t => {
        if (String(t.variabilni_symbol || '').trim() !== fVs) return false
        const tAmt = Math.abs(Number(t.castka))
        return Math.abs(tAmt - fCastka) / Math.max(fCastka, 1) < 0.30
      })
      matchType = 'vs'
    }

    // Priority 3: amount only — "dne" date = datum_splatnosti ±2 days
    if (!match) {
      const fDate2 = String(f.datum_splatnosti || f.datum_vystaveni || '').split('T')[0]
      const fDodavatelLower = String(f.dodavatel || '').toLowerCase()

      // Cross-match guard: branded transactions must match branded invoices
      // e.g. GOOGLE payment → only Google Ireland invoices; META → only Meta invoices
      const BRAND_GUARDS: { transKeyword: string; invoiceKeywords: string[] }[] = [
        { transKeyword: 'google', invoiceKeywords: ['google'] },
        { transKeyword: 'meta ', invoiceKeywords: ['meta', 'facebook'] },
        { transKeyword: 'facebook', invoiceKeywords: ['meta', 'facebook'] },
        { transKeyword: 'seznam', invoiceKeywords: ['seznam'] },
        { transKeyword: 'apple.com/bill', invoiceKeywords: ['apple'] },
        { transKeyword: 'microsoft', invoiceKeywords: ['microsoft'] },
      ]

      for (const t of transakce) {
        if (Number(t.castka) >= 0) continue
        const tZpravaLower = String(t.zprava || '').toLowerCase()

        // Skip if transaction belongs to a different brand than this invoice
        const brandConflict = BRAND_GUARDS.some(g =>
          tZpravaLower.includes(g.transKeyword) &&
          !g.invoiceKeywords.some(k => fDodavatelLower.includes(k))
        )
        if (brandConflict) continue

        const tDate2 = extractDateFromZprava(String(t.zprava || '')) ?? String(t.datum || '').split('T')[0]
        if (fDate2 && tDate2 && daysDiff(fDate2, tDate2) > 2) continue
        if (await amountMatches(t)) { match = t; matchType = 'castka'; break }
      }
    }

    if (!match) continue

    const transakceId = match.id as number
    const fakturaId = f.id as number
    transakce.splice(transakce.indexOf(match), 1)

    await pairInSupabase(fakturaId, transakceId)

    try {
      const abraKod = `FP-${fakturaId}-${new Date().getFullYear()}`
      const abraFa = (await (await fetch(`${ABRA_URL}/faktura-prijata/(kod='${abraKod}').json`, {
        headers: { Authorization: ABRA_AUTH },
      })).json())?.winstrom?.['faktura-prijata']?.[0]

      if (abraFa?.id) await createAbraBanka(f, match, abraFa.id)
    } catch { /* non-blocking */ }

    // Model B audit (fire-and-forget)
    auditAbraBooking(f, '518500', '321001', Number(f.castka_s_dph), matchType).catch(() => {})

    results.push({ faktura_id: fakturaId, transakce_id: transakceId, match: matchType })
  }

  // ── FOREIGN CURRENCY FALLBACK: match any unpaired faktura in EUR/USD/etc. ──
  // Priority: 1) same-currency transaction, 2) CZK transaction via ČNB rate (±3%)
  const allUnpaired = [...nova, ...schvalena].filter(
    f => !results.find(r => r.faktura_id === (f.id as number))
  )
  for (const f of allUnpaired) {
    const fMena = String(f.mena || 'CZK')
    if (fMena === 'CZK') continue

    const fCastka = Number(f.castka_s_dph)
    const fDate = String(f.datum_splatnosti || f.datum_vystaveni || '').split('T')[0]
    const fakturaId = f.id as number

    let match: Record<string, unknown> | undefined
    let matchType = ''

    // 0. Extract original FX amount from transaction message (most reliable for card payments)
    // e.g. Fio: "Nákup: WWW.TWILIO.COM, ..., částka 44.95 USD"
    for (const t of transakce) {
      if (Number(t.castka) >= 0) continue
      const tDate = String(t.datum || '').split('T')[0]
      if (fDate && tDate && daysDiff(fDate, tDate) > 7) continue
      const fx = extractFxFromZprava(String(t.zprava || ''))
      if (fx && fx.mena === fMena && Math.abs(fx.amount - fCastka) / fCastka < 0.01) {
        match = t
        matchType = `fx_zprava_${fMena}`
        break
      }
    }

    // 1. Same currency (e.g. USD invoice → USD transaction)
    for (const t of transakce) {
      if (Number(t.castka) >= 0) continue
      if (String(t.mena || 'CZK') !== fMena) continue
      const tDate = String(t.datum || '').split('T')[0]
      if (fDate && tDate && daysDiff(fDate, tDate) > 7) continue
      if (Math.abs(Math.abs(Number(t.castka)) - fCastka) / fCastka < 0.03) {
        match = t
        matchType = `fx_same_${fMena}`
        break
      }
    }

    // 2. CZK transaction with ČNB rate conversion
    if (!match) {
      for (const t of transakce) {
        if (Number(t.castka) >= 0) continue
        const tDate = String(t.datum || '').split('T')[0]
        if (fDate && tDate && daysDiff(fDate, tDate) > 7) continue
        const kurz = await getKurz(fMena, tDate || fDate)
        const fCzkEquiv = fCastka * kurz
        const tCastka = Math.abs(Number(t.castka))
        if (fCzkEquiv > 0 && Math.abs(tCastka - fCzkEquiv) / fCzkEquiv < 0.03) {
          match = t
          matchType = `fx_${fMena}→CZK_kurz_${kurz.toFixed(2)}`
          break
        }
      }
    }

    if (!match) continue

    const transakceId = match.id as number
    transakce.splice(transakce.indexOf(match), 1)

    await pairInSupabase(fakturaId, transakceId)

    try {
      const abraFaId = await createAbraFakturaPrijata(f, true)
      if (abraFaId) await createAbraBanka(f, match, abraFaId)
    } catch { /* non-blocking */ }

    // Model B audit (fire-and-forget)
    auditAbraBooking(f, '518500', '321001', Number(f.castka_s_dph), matchType).catch(() => {})

    results.push({ faktura_id: fakturaId, transakce_id: transakceId, match: matchType })
  }

  return NextResponse.json({ ok: true, paired: results.length, results })
}
