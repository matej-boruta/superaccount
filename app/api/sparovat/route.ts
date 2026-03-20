import { NextResponse } from 'next/server'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY!

export async function POST(req: Request) {
  const { fakturaId, transakceId } = await req.json()
  await fetch(
    `${SUPABASE_URL}/rest/v1/transakce?id=eq.${transakceId}`,
    {
      method: 'PATCH',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({ stav: 'sparovano', faktura_id: fakturaId }),
    }
  )
  return NextResponse.json({ ok: true })
}
