import { NextResponse } from 'next/server'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY!
const SB = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }

export async function GET() {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/faktury_vydane?select=*&order=datum_vystaveni.desc`,
    { headers: SB }
  )
  const data = await res.json()
  return NextResponse.json(Array.isArray(data) ? data : [])
}
