import { NextResponse } from 'next/server'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY!

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const fakturaId = searchParams.get('faktura_id')

  if (!fakturaId) {
    return NextResponse.json({ error: 'faktura_id required' }, { status: 400 })
  }

  const url = `${SUPABASE_URL}/rest/v1/agent_log?faktura_id=eq.${fakturaId}&order=created_at.desc&limit=20`
  const res = await fetch(url, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  })

  const data = await res.json()
  return NextResponse.json(Array.isArray(data) ? data : [])
}
