import { NextResponse } from 'next/server'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY!

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const rok = parseInt(searchParams.get('rok') ?? String(new Date().getFullYear()))
  const rokFilter = `&datum_vystaveni=gte.${rok}-01-01&datum_vystaveni=lte.${rok}-12-31`

  const url = `${SUPABASE_URL}/rest/v1/faktury?select=id,dodavatel,ico,datum_vystaveni,datum_splatnosti,cislo_faktury,castka_bez_dph,dph,castka_s_dph,mena,popis,variabilni_symbol,stav,prijato_at,platba_naplanovana,datum_platby,kategorie_id,zauctovano_platba,stav_workflow,blocker&stav=in.(nova,schvalena,zaplacena,zamitnuta)${rokFilter}&order=datum_splatnosti.asc`
  const headers = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }

  const res = await fetch(url, { headers })
  const data = await res.json()

  if (!Array.isArray(data)) {
    const fallbackUrl = `${SUPABASE_URL}/rest/v1/faktury?select=id,dodavatel,ico,datum_vystaveni,datum_splatnosti,cislo_faktury,castka_bez_dph,dph,castka_s_dph,mena,popis,variabilni_symbol,stav,prijato_at,platba_naplanovana,datum_platby&stav=in.(nova,schvalena,zaplacena,zamitnuta)${rokFilter}&order=datum_splatnosti.asc`
    const fallbackRes = await fetch(fallbackUrl, { headers })
    return NextResponse.json(await fallbackRes.json())
  }

  return NextResponse.json(data)
}
