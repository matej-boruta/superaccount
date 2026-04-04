import { NextResponse } from 'next/server'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY!
const ABRA_URL = process.env.ABRA_URL!
const ABRA_USER = process.env.ABRA_USER!
const ABRA_PASS = process.env.ABRA_PASS!
const ABRA_AUTH = 'Basic ' + Buffer.from(`${ABRA_USER}:${ABRA_PASS}`).toString('base64')

function addWorkingDays(date: Date, days: number): Date {
  const result = new Date(date)
  let subtracted = 0
  while (subtracted < days) {
    result.setDate(result.getDate() - 1)
    const dow = result.getDay()
    if (dow !== 0 && dow !== 6) subtracted++
  }
  return result
}

export async function POST(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  // 1. Fetch faktura from Supabase
  const fRes = await fetch(`${SUPABASE_URL}/rest/v1/faktury?id=eq.${id}&select=*`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  })
  const [f] = await fRes.json()
  if (!f) return NextResponse.json({ error: 'Faktura nenalezena' }, { status: 404 })

  // PRAVIDLO: faktura bez kategorie nesmí být schválena
  if (!f.kategorie_id) {
    return NextResponse.json(
      { error: 'Faktura nemá přiřazenou kategorii — nelze schválit. Nejprve přiřaď kategorii (ACCOUNTANT).' },
      { status: 422 }
    )
  }

  // 2. Compute payment date
  const splatnostRaw = f.datum_splatnosti
  const splatnostYear = splatnostRaw ? parseInt(splatnostRaw.split('-')[0]) : 0
  const splatnostValid = splatnostYear >= 2020 && splatnostYear <= 2100
  const splatnost = splatnostValid ? new Date(splatnostRaw) : new Date()
  const datumPlatbyStr = splatnostValid ? addWorkingDays(splatnost, 1).toISOString().split('T')[0] : null

  // 3. Update Supabase
  await fetch(`${SUPABASE_URL}/rest/v1/faktury?id=eq.${id}`, {
    method: 'PATCH',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify({
      stav: 'schvalena',
      stav_workflow: 'APPROVED',
      zauctovano_at: new Date().toISOString(),
      datum_platby: datumPlatbyStr,
    }),
  })

  // 4. Create faktura-prijata in ABRA (if not already exists)
  const abraKod = `FP-${id}-${new Date().getFullYear()}`
  let abraResult: { ok: boolean; error?: string } = { ok: false }
  try {
    // Check if already exists
    const checkRes = await fetch(`${ABRA_URL}/faktura-prijata/(kod='${abraKod}').json?fields=id`, {
      headers: { Authorization: ABRA_AUTH },
    })
    const checkData = await checkRes.json()
    const existing = checkData?.winstrom?.['faktura-prijata']?.[0]

    if (existing?.id) {
      abraResult = { ok: true } // already in ABRA
    } else {
      const mena = f.mena || 'CZK'
      const datVyst = (() => {
        const y = f.datum_vystaveni ? parseInt(f.datum_vystaveni.split('-')[0]) : 0
        return (y >= 2020 && y <= 2100) ? f.datum_vystaveni : new Date().toISOString().split('T')[0]
      })()

      const abraRes = await fetch(`${ABRA_URL}/faktura-prijata.json`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: ABRA_AUTH },
        body: JSON.stringify({
          winstrom: {
            'faktura-prijata': [{
              typDokl: 'code:FAKTURA',
              kod: abraKod,
              cisDosle: f.cislo_faktury || abraKod,
              varSym: f.variabilni_symbol || '',
              datVyst,
              datSplat: splatnostValid ? splatnostRaw : undefined,
              datUcto: new Date().toISOString().split('T')[0],
              popis: f.popis || f.dodavatel,
              mena: `code:${mena}`,
              polozkyFaktury: [{
                nazev: f.popis || f.dodavatel,
                cenaMj: Number(f.castka_bez_dph),
                mnozstvi: 1,
                sazbyDph: Number(f.dph) > 0 ? 'typSazbyDph.zakladni' : 'typSazbyDph.dphOsvobozeno',
                ucetni: 'code:518500',
              }],
            }],
          },
        }),
      })
      const abraData = await abraRes.json()
      abraResult = { ok: abraData?.winstrom?.success === 'true' }
      if (!abraResult.ok) {
        abraResult.error = abraData?.winstrom?.results?.[0]?.errors?.[0]?.message
      }
    }
  } catch (e) {
    abraResult = { ok: false, error: String(e) }
  }

  return NextResponse.json({ ok: true, datum_platby: datumPlatbyStr, abra: abraResult })
}
