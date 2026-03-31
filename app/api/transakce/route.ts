import { NextResponse } from 'next/server'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY!

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const rok = parseInt(searchParams.get('rok') ?? String(new Date().getFullYear()))
  const rokFilter = `&datum=gte.${rok}-01-01&datum=lte.${rok}-12-31`

  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/transakce?select=id,datum,castka,mena,zprava,variabilni_symbol,typ,stav,faktura_id,protiucet${rokFilter}&order=datum.desc`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
  )
  return NextResponse.json(await res.json())
}
