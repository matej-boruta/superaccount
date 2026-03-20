import { NextResponse } from 'next/server'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY!

export async function GET() {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/faktury?select=id,dodavatel,ico,datum_vystaveni,datum_splatnosti,cislo_faktury,castka_bez_dph,dph,castka_s_dph,mena,popis,variabilni_symbol,stav,prijato_at,platba_naplanovana,datum_platby&stav=in.(nova,schvalena,zamitnuta)&order=stav.asc,datum_vystaveni.desc`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
  )
  const data = await res.json()
  return NextResponse.json(data)
}
