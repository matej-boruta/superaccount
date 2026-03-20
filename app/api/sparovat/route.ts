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

  // 1. Mark transakce as paired
  await fetch(`${SUPABASE_URL}/rest/v1/transakce?id=eq.${transakceId}`, {
    method: 'PATCH',
    headers: SB_HEADERS,
    body: JSON.stringify({ stav: 'sparovano', faktura_id: fakturaId }),
  })

  // 2. Mark faktura as zaplacena
  await fetch(`${SUPABASE_URL}/rest/v1/faktury?id=eq.${fakturaId}`, {
    method: 'PATCH',
    headers: SB_HEADERS,
    body: JSON.stringify({ stav: 'zaplacena' }),
  })

  // 3. Auto-zaúčtovat do ABRA (non-blocking — chyba neblokuje párování)
  let abraResult: { ok: boolean; banka_id?: string; error?: string } = { ok: false }
  try {
    const fRes = await fetch(`${SUPABASE_URL}/rest/v1/faktury?id=eq.${fakturaId}&select=*`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    })
    const [f] = await fRes.json()

    const tRes = await fetch(`${SUPABASE_URL}/rest/v1/transakce?id=eq.${transakceId}&select=*`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    })
    const [t] = await tRes.json()

    if (f) {
      const abraKod = `FP-${fakturaId}-${new Date().getFullYear()}`
      const abraFaRes = await fetch(`${ABRA_URL}/faktura-prijata.json?kod=${abraKod}`, {
        headers: { Authorization: ABRA_AUTH },
      })
      const abraFaData = await abraFaRes.json()
      const abraFa = abraFaData?.winstrom?.['faktura-prijata']?.[0]

      if (abraFa?.id) {
        const datPlatby = t?.datum
          ? t.datum.split('T')[0]
          : (f.datum_platby ? f.datum_platby.split('T')[0] : new Date().toISOString().split('T')[0])
        const castka = Number(f.castka_s_dph)
        const mena = f.mena || 'CZK'

        const bankaRes = await fetch(`${ABRA_URL}/banka.json`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: ABRA_AUTH },
          body: JSON.stringify({
            winstrom: {
              banka: [{
                typDokl: 'code:STANDARD',
                banka: 'code:BANKOVNÍ ÚČET',
                ...(abraFa.firma ? { firma: abraFa.firma } : {}),
                varSym: f.variabilni_symbol || '',
                datVyst: datPlatby,
                popis: `Platba ${abraKod} - ${f.dodavatel}`,
                castka: -castka,
                mena: `code:${mena}`,
                polozkyBanky: [{
                  typPolozkyK: 'typPolozky.uhradaFaktury',
                  faktura: `id:${abraFa.id}`,
                  castka,
                }],
              }],
            },
          }),
        })

        const bankaData = await bankaRes.json()
        const bankaSuccess = bankaData?.winstrom?.success === 'true'
        const bankaId = bankaData?.winstrom?.results?.[0]?.id
        const bankaErr = bankaData?.winstrom?.results?.[0]?.errors?.[0]?.message

        if (bankaSuccess) {
          await fetch(`${SUPABASE_URL}/rest/v1/faktury?id=eq.${fakturaId}`, {
            method: 'PATCH',
            headers: SB_HEADERS,
            body: JSON.stringify({ zauctovano_platba: true }),
          })
          abraResult = { ok: true, banka_id: bankaId }
        } else {
          abraResult = { ok: false, error: bankaErr }
        }
      } else {
        abraResult = { ok: false, error: 'Faktura nenalezena v ABRA' }
      }
    }
  } catch (e) {
    abraResult = { ok: false, error: String(e) }
  }

  return NextResponse.json({ ok: true, abra: abraResult })
}
