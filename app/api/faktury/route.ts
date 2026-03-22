import { NextResponse } from 'next/server'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY!

export async function GET() {
  // Try with kategorie_id first; fall back if column doesn't exist yet
  const url = `${SUPABASE_URL}/rest/v1/faktury?select=id,dodavatel,ico,datum_vystaveni,datum_splatnosti,cislo_faktury,castka_bez_dph,dph,castka_s_dph,mena,popis,variabilni_symbol,stav,prijato_at,platba_naplanovana,datum_platby,kategorie_id,zauctovano_platba&stav=in.(nova,schvalena,zaplacena,zamitnuta)&order=datum_splatnosti.asc`
  const headers = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }

  const res = await fetch(url, { headers })
  const data = await res.json()

  // If Supabase returned an error (e.g. column doesn't exist yet), retry without kategorie_id
  if (!Array.isArray(data)) {
    const fallbackUrl = `${SUPABASE_URL}/rest/v1/faktury?select=id,dodavatel,ico,datum_vystaveni,datum_splatnosti,cislo_faktury,castka_bez_dph,dph,castka_s_dph,mena,popis,variabilni_symbol,stav,prijato_at,platba_naplanovana,datum_platby&stav=in.(nova,schvalena,zaplacena,zamitnuta)&order=datum_splatnosti.asc`
    const fallbackRes = await fetch(fallbackUrl, { headers })
    return NextResponse.json(await fallbackRes.json())
  }

  return NextResponse.json(data)
}
