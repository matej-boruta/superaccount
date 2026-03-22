import { NextResponse } from 'next/server'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY!
const ABRA_URL = process.env.ABRA_URL!
const ABRA_USER = process.env.ABRA_USER!
const ABRA_PASS = process.env.ABRA_PASS!

const ABRA_AUTH = 'Basic ' + Buffer.from(`${ABRA_USER}:${ABRA_PASS}`).toString('base64')

export async function POST(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  const fRes = await fetch(`${SUPABASE_URL}/rest/v1/faktury?id=eq.${id}&select=*`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
  })
  const [f] = await fRes.json()
  if (!f) return NextResponse.json({ error: 'Nenalezena' }, { status: 404 })
  if (f.stav !== 'zaplacena') return NextResponse.json({ error: 'Faktura není zaplacena' }, { status: 400 })

  const abraKod = `FP-${id}-${new Date().getFullYear()}`
  const abraFaRes = await fetch(`${ABRA_URL}/faktura-prijata/(kod='${abraKod}').json`, {
    headers: { Authorization: ABRA_AUTH }
  })
  const abraFaData = await abraFaRes.json()
  const abraFa = abraFaData?.winstrom?.['faktura-prijata']?.[0]
  if (!abraFa?.id) return NextResponse.json({ error: 'Faktura nenalezena v ABRA', kod: abraKod }, { status: 404 })

  const tRes = await fetch(`${SUPABASE_URL}/rest/v1/transakce?faktura_id=eq.${id}&stav=eq.sparovano&select=*`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  })
  const [t] = await tRes.json()
  const datPlatby = t?.datum
    ? t.datum.split('T')[0]
    : (f.datum_platby ? f.datum_platby.split('T')[0] : new Date().toISOString().split('T')[0])
  const castka = Number(f.castka_s_dph)
  const mena = f.mena || 'CZK'
  const abraKodFull = `FP-${id}-${new Date().getFullYear()}`

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
          popis: `Platba ${abraKodFull} - ${f.dodavatel}`,
          mena: `code:${mena}`,
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
  const ok = bankaData?.winstrom?.success === 'true'
  const err = bankaData?.winstrom?.results?.[0]?.errors?.[0]?.message

  if (ok) {
    await fetch(`${SUPABASE_URL}/rest/v1/faktury?id=eq.${id}`, {
      method: 'PATCH',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({ zauctovano_platba: true }),
    })
  }

  return NextResponse.json({ ok, error: err })
}
