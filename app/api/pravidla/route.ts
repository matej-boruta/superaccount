import { NextResponse } from 'next/server'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY!
const SB = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }

export async function GET() {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/dodavatel_pravidla?select=*&order=id`,
    { headers: SB }
  )
  const data = await res.json()
  return NextResponse.json(data)
}

export async function PATCH(req: Request) {
  const { id, ...patch } = await req.json()
  await fetch(`${SUPABASE_URL}/rest/v1/dodavatel_pravidla?id=eq.${id}`, {
    method: 'PATCH',
    headers: { ...SB, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify(patch),
  })
  return NextResponse.json({ ok: true })
}
