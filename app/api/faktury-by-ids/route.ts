import { NextRequest, NextResponse } from 'next/server'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY!

export async function GET(req: NextRequest) {
  const ids = req.nextUrl.searchParams.get('ids') ?? ''
  if (!ids) return NextResponse.json([])

  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/faktury?id=in.(${ids})&select=id,dodavatel,castka_s_dph,mena`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
  )
  return NextResponse.json(await res.json())
}
