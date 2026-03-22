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
  const { fakturaId } = await req.json()

  // 1. Unpair transakce in Supabase
  const tRes = await fetch(`${SUPABASE_URL}/rest/v1/transakce?faktura_id=eq.${fakturaId}&select=id`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  })
  const transakce = await tRes.json()
  if (Array.isArray(transakce)) {
    for (const t of transakce) {
      await fetch(`${SUPABASE_URL}/rest/v1/transakce?id=eq.${t.id}`, {
        method: 'PATCH',
        headers: SB_HEADERS,
        body: JSON.stringify({ stav: 'nesparovano', faktura_id: null }),
      })
    }
  }

  // 2. Reset faktura to schvalena in Supabase
  await fetch(`${SUPABASE_URL}/rest/v1/faktury?id=eq.${fakturaId}`, {
    method: 'PATCH',
    headers: SB_HEADERS,
    body: JSON.stringify({ stav: 'schvalena', zauctovano_platba: false }),
  })

  // 3. Undo ABRA changes (non-blocking)
  let abraResult: { ok: boolean; error?: string } = { ok: false }
  try {
    const abraKod = `FP-${fakturaId}-${new Date().getFullYear()}`
    const findRes = await fetch(`${ABRA_URL}/faktura-prijata/(kod='${abraKod}').json`, {
      headers: { Authorization: ABRA_AUTH },
    })
    const findData = await findRes.json()
    const abraFa = findData?.winstrom?.['faktura-prijata']?.[0]

    if (abraFa?.id) {
      // Unmark payment on faktura-prijata
      await fetch(`${ABRA_URL}/faktura-prijata/${abraFa.id}.json`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: ABRA_AUTH },
        body: JSON.stringify({
          winstrom: { 'faktura-prijata': [{ id: abraFa.id, stavUhrK: '' }] },
        }),
      })

      // Delete banka records that were created for this faktura (find by popis)
      const bankaFindRes = await fetch(
        `${ABRA_URL}/banka/(popis like '%${abraKod}%').json?fields=id`,
        { headers: { Authorization: ABRA_AUTH } }
      )
      const bankaFindData = await bankaFindRes.json()
      const bankaRecords = bankaFindData?.winstrom?.banka ?? []
      for (const b of bankaRecords) {
        await fetch(`${ABRA_URL}/banka/${b.id}.json`, {
          method: 'DELETE',
          headers: { Authorization: ABRA_AUTH },
        })
      }
      abraResult = { ok: true }
    } else {
      abraResult = { ok: true } // no ABRA record = nothing to undo
    }
  } catch (e) {
    abraResult = { ok: false, error: String(e) }
  }

  return NextResponse.json({ ok: true, abra: abraResult })
}
