import { NextResponse } from 'next/server'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY!

export async function GET() {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/transakce?select=id,datum,castka,mena,zprava,variabilni_symbol,typ,stav,faktura_id,protiucet&order=datum.desc`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
  )
  return NextResponse.json(await res.json())
}
