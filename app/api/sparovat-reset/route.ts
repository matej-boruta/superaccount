import { NextResponse } from 'next/server'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY!

const SB_HEADERS = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
  Prefer: 'return=minimal',
}

export async function POST(req: Request) {
  const { transakceId } = await req.json()

  // Fetch transakce to get faktura_id
  const tRes = await fetch(`${SUPABASE_URL}/rest/v1/transakce?id=eq.${transakceId}&select=id,faktura_id`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  })
  const [t] = await tRes.json()
  if (!t) return NextResponse.json({ error: 'Transakce nenalezena' }, { status: 404 })

  // Reset transakce
  await fetch(`${SUPABASE_URL}/rest/v1/transakce?id=eq.${transakceId}`, {
    method: 'PATCH',
    headers: SB_HEADERS,
    body: JSON.stringify({ stav: 'nesparovano', faktura_id: null }),
  })

  // If faktura was zaplacena, reset it back to schvalena
  if (t.faktura_id) {
    const fRes = await fetch(`${SUPABASE_URL}/rest/v1/faktury?id=eq.${t.faktura_id}&select=id,stav`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    })
    const [f] = await fRes.json()
    if (f?.stav === 'zaplacena') {
      await fetch(`${SUPABASE_URL}/rest/v1/faktury?id=eq.${t.faktura_id}`, {
        method: 'PATCH',
        headers: SB_HEADERS,
        body: JSON.stringify({ stav: 'schvalena', zauctovano_platba: false }),
      })
    }
  }

  return NextResponse.json({ ok: true })
}
