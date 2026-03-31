import { NextResponse } from 'next/server'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY!
const ABRA_URL = process.env.ABRA_URL!
const ABRA_USER = process.env.ABRA_USER!
const ABRA_PASS = process.env.ABRA_PASS!

const ABRA_AUTH = 'Basic ' + Buffer.from(`${ABRA_USER}:${ABRA_PASS}`).toString('base64')
const SB_HEADERS = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }

export async function POST(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  const fRes = await fetch(`${SUPABASE_URL}/rest/v1/faktury?id=eq.${id}&select=*`, { headers: SB_HEADERS })
  const [f] = await fRes.json()
  if (!f) return NextResponse.json({ error: 'Nenalezena' }, { status: 404 })
  if (f.stav !== 'zaplacena') return NextResponse.json({ error: 'Faktura není zaplacena' }, { status: 400 })

  const year = new Date().getFullYear()
  const abraKod = `FP-${id}-${year}`

  const abraFaRes = await fetch(`${ABRA_URL}/faktura-prijata/(kod='${abraKod}').json`, {
    headers: { Authorization: ABRA_AUTH }
  })
  const abraFaData = await abraFaRes.json()
  const abraFa = abraFaData?.winstrom?.['faktura-prijata']?.[0]
  if (!abraFa?.id) return NextResponse.json({ error: 'Faktura nenalezena v ABRA', kod: abraKod }, { status: 404 })

  // Fetch ALL sparovane transakce for this faktura
  const tRes = await fetch(`${SUPABASE_URL}/rest/v1/transakce?faktura_id=eq.${id}&stav=eq.sparovano&select=*`, {
    headers: SB_HEADERS,
  })
  let transakce: { id: number; datum: string; castka: number; mena: string }[] = await tRes.json()
  if (!transakce.length) {
    transakce = [{
      id: 0,
      datum: f.datum_platby || new Date().toISOString(),
      castka: -Number(f.castka_s_dph),
      mena: f.mena || 'CZK',
    }]
  }

  // Fetch existing ABRA banka records for in-memory idempotency check
  const bkRes = await fetch(`${ABRA_URL}/banka.json?fields=id,popis&limit=2000`, {
    headers: { Authorization: ABRA_AUTH },
  })
  const bkData = await bkRes.json()
  const existingPopis: Set<string> = new Set(
    (bkData?.winstrom?.banka ?? []).map((b: { popis?: string }) => b.popis ?? '')
  )

  const mena = f.mena || 'CZK'
  const results: { transakce_id: number; ok: boolean; skipped?: boolean; error?: string }[] = []

  for (const t of transakce) {
    const isSingle = transakce.length === 1
    // Check new format
    const newPopisExists = [...existingPopis].some(p => p.startsWith(`Platba ${abraKod} T${t.id}`))
    // Check old format (single transakce only)
    const oldPopisExists = isSingle && [...existingPopis].some(p => p.startsWith(`Platba ${abraKod} -`))

    if (newPopisExists || oldPopisExists) {
      results.push({ transakce_id: t.id, ok: true, skipped: true })
      continue
    }

    const popis = `Platba ${abraKod} T${t.id} - ${f.dodavatel}`
    const datPlatby = t.datum ? t.datum.split('T')[0] : new Date().toISOString().split('T')[0]
    const castkaT = Math.abs(Number(t.castka))

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
            popis,
            mena: `code:${mena}`,
            sumOsv: castkaT,
            primUcet: 'code:221001',
            protiUcet: 'code:321001',
            ...(abraFa.firma ? { firma: abraFa.firma } : {}),
            uhrada: [{ dokladFaktPrij: { id: abraFa.id }, castka: castkaT }],
          }],
        },
      }),
    })
    const bankaData = await bankaRes.json()
    const ok = bankaData?.winstrom?.success === 'true'
    const err = bankaData?.winstrom?.results?.[0]?.errors?.[0]?.message
    if (ok) existingPopis.add(popis)
    results.push({ transakce_id: t.id, ok, error: err })
  }

  const allOk = results.every(r => r.ok)
  if (allOk) {
    await fetch(`${SUPABASE_URL}/rest/v1/faktury?id=eq.${id}`, {
      method: 'PATCH',
      headers: { ...SB_HEADERS, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ zauctovano_platba: true }),
    })
  }

  return NextResponse.json({
    ok: allOk,
    created: results.filter(r => r.ok && !r.skipped).length,
    skipped: results.filter(r => r.skipped).length,
    results,
  })
}
