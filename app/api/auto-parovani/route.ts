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

export async function POST() {
  // 1. Load all schvalena faktury (waiting for payment)
  const [fRes, tRes] = await Promise.all([
    fetch(`${SUPABASE_URL}/rest/v1/faktury?stav=eq.schvalena&select=*`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    }),
    fetch(`${SUPABASE_URL}/rest/v1/transakce?stav=eq.nesparovano&select=*`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    }),
  ])
  const faktury: Record<string, unknown>[] = await fRes.json()
  const transakce: Record<string, unknown>[] = await tRes.json()

  if (!faktury.length || !transakce.length) return NextResponse.json({ ok: true, paired: 0 })

  const results: { faktura_id: number; transakce_id: number; match: string }[] = []

  for (const f of faktury) {
    const fVs = String(f.variabilni_symbol || '').trim()
    const fCastka = Number(f.castka_s_dph)

    // Priority 1: exact VS match + amount
    let match = transakce.find(t =>
      String(t.variabilni_symbol || '').trim() === fVs &&
      fVs !== '' &&
      Math.abs(Number(t.castka) - fCastka) < 1
    )
    let matchType = 'vs+castka'

    // Priority 2: exact VS match only
    if (!match && fVs) {
      match = transakce.find(t => String(t.variabilni_symbol || '').trim() === fVs)
      matchType = 'vs'
    }

    // Priority 3: exact amount + same sign (negative = outgoing)
    if (!match) {
      match = transakce.find(t => Math.abs(Number(t.castka) - fCastka) < 1 && Number(t.castka) < 0)
      matchType = 'castka'
    }

    if (!match) continue

    const transakceId = match.id as number
    const fakturaId = f.id as number
    const datPlatby = (match.datum as string)?.split('T')[0] ?? new Date().toISOString().split('T')[0]
    const castka = fCastka

    // Remove from candidates so it can't match twice
    const idx = transakce.indexOf(match)
    transakce.splice(idx, 1)

    // Pair in Supabase
    await Promise.all([
      fetch(`${SUPABASE_URL}/rest/v1/transakce?id=eq.${transakceId}`, {
        method: 'PATCH',
        headers: SB_HEADERS,
        body: JSON.stringify({ stav: 'sparovano', faktura_id: fakturaId }),
      }),
      fetch(`${SUPABASE_URL}/rest/v1/faktury?id=eq.${fakturaId}`, {
        method: 'PATCH',
        headers: SB_HEADERS,
        body: JSON.stringify({ stav: 'zaplacena' }),
      }),
    ])

    // Account in ABRA
    try {
      const abraKod = `FP-${fakturaId}-${new Date().getFullYear()}`
      const findRes = await fetch(`${ABRA_URL}/faktura-prijata/(kod='${abraKod}').json`, {
        headers: { Authorization: ABRA_AUTH },
      })
      const abraFa = (await findRes.json())?.winstrom?.['faktura-prijata']?.[0]

      if (abraFa?.id) {
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
                mena: `code:${f.mena || 'CZK'}`,
                sumOsv: castka,
                primUcet: 'code:221001',
                protiUcet: 'code:321001',
                ...(abraFa.firma ? { firma: abraFa.firma } : {}),
                uhrada: [{ dokladFaktPrij: { id: abraFa.id }, castka }],
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
    } catch { /* non-blocking */ }

    results.push({ faktura_id: fakturaId, transakce_id: transakceId, match: matchType })
  }

  return NextResponse.json({ ok: true, paired: results.length, results })
}
