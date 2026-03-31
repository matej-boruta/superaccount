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

export async function POST(req: Request) {
  const { fakturaId, transakceId } = await req.json()

  // Guard: never pair incoming payments (castka > 0) with outgoing invoices
  const tCheckRes = await fetch(`${SUPABASE_URL}/rest/v1/transakce?id=eq.${transakceId}&select=castka`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  })
  const [tCheck] = await tCheckRes.json()
  if (tCheck && Number(tCheck.castka) > 0) {
    return NextResponse.json({ ok: false, error: 'Nelze párovat příchozí platbu s přijatou fakturou' }, { status: 400 })
  }

  // 1. Mark transakce as paired in Supabase
  await fetch(`${SUPABASE_URL}/rest/v1/transakce?id=eq.${transakceId}`, {
    method: 'PATCH',
    headers: SB_HEADERS,
    body: JSON.stringify({ stav: 'sparovano', faktura_id: fakturaId }),
  })

  // 2. Mark faktura as zaplacena in Supabase
  await fetch(`${SUPABASE_URL}/rest/v1/faktury?id=eq.${fakturaId}`, {
    method: 'PATCH',
    headers: SB_HEADERS,
    body: JSON.stringify({ stav: 'zaplacena' }),
  })

  // 3. Zaúčtovat do ABRA (non-blocking)
  let abraResult: { ok: boolean; banka_id?: string; error?: string } = { ok: false }
  try {
    // Load faktura + transakce data
    const [fRes, tRes] = await Promise.all([
      fetch(`${SUPABASE_URL}/rest/v1/faktury?id=eq.${fakturaId}&select=*`, {
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
      }),
      fetch(`${SUPABASE_URL}/rest/v1/transakce?id=eq.${transakceId}&select=*`, {
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
      }),
    ])
    const [f] = await fRes.json()
    const [t] = await tRes.json()
    if (!f) throw new Error('Faktura nenalezena v Supabase')

    const abraKod = `FP-${fakturaId}-${new Date().getFullYear()}`
    const abraFaRes = await fetch(`${ABRA_URL}/faktura-prijata/(kod='${abraKod}').json`, {
      headers: { Authorization: ABRA_AUTH },
    })
    const abraFaData = await abraFaRes.json()
    const abraFa = abraFaData?.winstrom?.['faktura-prijata']?.[0]

    if (!abraFa?.id) {
      abraResult = { ok: false, error: 'Faktura nenalezena v ABRA' }
    } else {
      const datPlatby = t?.datum
        ? t.datum.split('T')[0]
        : (f.datum_platby ? f.datum_platby.split('T')[0] : new Date().toISOString().split('T')[0])
      const fakturaCastka = Number(f.castka_s_dph)  // v měně faktury (EUR/USD/CZK)
      const bankaCastka = t ? Math.abs(Number(t.castka)) : fakturaCastka  // CZK z FIO

      // Create banka record paired with faktura-prijata via uhrada
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
              mena: 'code:CZK',
              sumOsv: bankaCastka,
              primUcet: 'code:221001',
              protiUcet: 'code:321001',
              ...(abraFa.firma ? { firma: abraFa.firma } : {}),
              uhrada: [{ dokladFaktPrij: { id: abraFa.id }, castka: fakturaCastka }],
            }],
          },
        }),
      })
      const bankaData = await bankaRes.json()
      const bankaOk = bankaData?.winstrom?.success === 'true'
      const bankaId = bankaData?.winstrom?.results?.[0]?.id
      const bankaErr = bankaData?.winstrom?.results?.[0]?.errors?.[0]?.message

      if (bankaOk) {
        await fetch(`${SUPABASE_URL}/rest/v1/faktury?id=eq.${fakturaId}`, {
          method: 'PATCH',
          headers: SB_HEADERS,
          body: JSON.stringify({ zauctovano_platba: true }),
        })
        abraResult = { ok: true, banka_id: bankaId }
      } else {
        abraResult = { ok: false, error: bankaErr || 'Chyba při vytváření banka záznamu v ABRA' }
      }
    }
  } catch (e) {
    abraResult = { ok: false, error: String(e) }
  }

  return NextResponse.json({ ok: true, abra: abraResult })
}
