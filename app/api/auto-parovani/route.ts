import { NextResponse } from 'next/server'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY!
const ABRA_URL = process.env.ABRA_URL!
const ABRA_USER = process.env.ABRA_USER!
const ABRA_PASS = process.env.ABRA_PASS!
const ABRA_AUTH = 'Basic ' + Buffer.from(`${ABRA_USER}:${ABRA_PASS}`).toString('base64')

const SB_HEADERS = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
  Prefer: 'return=minimal',
}

// Card payment suppliers: keyword in transakce.zprava → must also appear in faktura.dodavatel
const CARD_SUPPLIERS: { keyword: string; dodavatelMatch: string }[] = [
  { keyword: 'SEZNAM', dodavatelMatch: 'SEZNAM' },
  { keyword: 'GOOGLE', dodavatelMatch: 'GOOGLE' },
]

function daysDiff(a: string, b: string): number {
  return Math.abs((new Date(a).getTime() - new Date(b).getTime()) / 86400000)
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

async function matchByCard(
  t: Record<string, unknown>,
  f: Record<string, unknown>
): Promise<boolean> {
  if (t.typ !== 'Platba kartou') return false
  const zprava = String(t.zprava || '').toUpperCase()
  const dodavatel = String(f.dodavatel || '').toUpperCase()

  const supplierMatch = CARD_SUPPLIERS.some(
    s => zprava.includes(s.keyword) && dodavatel.includes(s.dodavatelMatch)
  )
  if (!supplierMatch) return false

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

  // Date within 5 days (EUR invoices may have bigger date gap)
  const fDate = String(f.datum_splatnosti || f.datum_vystaveni || '').split('T')[0]
  const tDate = String(t.datum || '').split('T')[0]
  if (!fDate || !tDate) return false
  if (daysDiff(fDate, tDate) > 5) return false

  return true
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

  const body: Record<string, unknown> = {
    typDokl: 'code:FAKTURA',
    kod: abraKod,
    cisDosle: f.cislo_faktury || abraKod,
    varSym: f.variabilni_symbol || '',
    datVyst,
    datUcto,
    popis: f.popis || f.dodavatel,
    mena: `code:${mena}`,
    polozkyFaktury: [{
      nazev: f.popis || f.dodavatel,
      cenaMj: Number(f.castka_bez_dph),
      mnozstvi: 1,
      sazbyDph: Number(f.dph) > 0 ? 'typSazbyDph.zakladni' : 'typSazbyDph.dphOsvobozeno',
      ucetni: 'code:518500',
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
  abraFaId: string
) {
  const fakturaId = f.id as number
  const abraKod = `FP-${fakturaId}-${new Date().getFullYear()}`
  const datPlatby = String(t.datum || '').split('T')[0] || new Date().toISOString().split('T')[0]
  const castka = Number(f.castka_s_dph)
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

export async function POST() {
  const [fSchvalenaRes, fNovaRes, tRes] = await Promise.all([
    fetch(`${SUPABASE_URL}/rest/v1/faktury?stav=eq.schvalena&select=*`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    }),
    fetch(`${SUPABASE_URL}/rest/v1/faktury?stav=eq.nova&select=*`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    }),
    fetch(`${SUPABASE_URL}/rest/v1/transakce?stav=eq.nesparovano&select=*`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    }),
  ])

  const schvalena: Record<string, unknown>[] = await fSchvalenaRes.json()
  const nova: Record<string, unknown>[] = await fNovaRes.json()
  const transakce: Record<string, unknown>[] = await tRes.json()

  const results: { faktura_id: number; transakce_id: number; match: string }[] = []

  // ── CARD TRANSACTIONS: match nova + schvalena faktury via supplier name + amount + date ──
  const cardTranakce = transakce.filter(t => t.typ === 'Platba kartou')

  for (const f of [...nova, ...schvalena]) {
    const matchResults = await Promise.all(cardTranakce.map(t => matchByCard(t, f)))
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
    } catch { /* non-blocking */ }
  }

  // ── STANDARD: match schvalena faktury via VS + amount ──
  for (const f of schvalena) {
    // Skip if already paired above
    if (results.find(r => r.faktura_id === (f.id as number))) continue

    const fVs = String(f.variabilni_symbol || '').trim()
    const fCastka = Number(f.castka_s_dph)

    // Priority 1: VS + amount
    let match = transakce.find(t =>
      String(t.variabilni_symbol || '').trim() === fVs &&
      fVs !== '' &&
      Math.abs(Number(t.castka) - fCastka) < 1
    )
    let matchType = 'vs+castka'

    // Priority 2: VS only
    if (!match && fVs) {
      match = transakce.find(t => String(t.variabilni_symbol || '').trim() === fVs)
      matchType = 'vs'
    }

    // Priority 3: amount only (outgoing)
    if (!match) {
      match = transakce.find(t => Math.abs(Number(t.castka) - fCastka) < 1 && Number(t.castka) < 0)
      matchType = 'castka'
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

    results.push({ faktura_id: fakturaId, transakce_id: transakceId, match: matchType })
  }

  return NextResponse.json({ ok: true, paired: results.length, results })
}
