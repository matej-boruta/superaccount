import { NextResponse } from 'next/server'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY!
const SB = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
const SB_W = { ...SB, 'Content-Type': 'application/json', Prefer: 'return=minimal' }

export async function POST(req: Request) {
  const { dodavatel } = await req.json()
  if (!dodavatel) return NextResponse.json({ error: 'dodavatel required' }, { status: 400 })

  const pattern = encodeURIComponent(`%${dodavatel}%`)

  // 1. Find all matching faktury (any stav except zamitnuta)
  const fRes = await fetch(
    `${SUPABASE_URL}/rest/v1/faktury?dodavatel=ilike.${pattern}&stav=in.(nova,ke_schvaleni,schvalena,zaplacena)&select=id,stav`,
    { headers: SB }
  )
  const faktury: { id: number; stav: string }[] = await fRes.json()
  if (!Array.isArray(faktury) || faktury.length === 0) {
    return NextResponse.json({ ok: true, faktury: 0, transakce: 0 })
  }
  const ids = faktury.map(f => f.id)

  // 2. Unpair all transakce linked to these faktury
  const tRes = await fetch(
    `${SUPABASE_URL}/rest/v1/transakce?faktura_id=in.(${ids.join(',')})&select=id`,
    { headers: SB }
  )
  const transakce: { id: number }[] = await tRes.json()
  let unpairedCount = 0
  if (Array.isArray(transakce) && transakce.length > 0) {
    await fetch(
      `${SUPABASE_URL}/rest/v1/transakce?id=in.(${transakce.map(t => t.id).join(',')})`,
      { method: 'PATCH', headers: SB_W, body: JSON.stringify({ stav: 'nesparovano', faktura_id: null }) }
    )
    unpairedCount = transakce.length
  }

  // 3. Reset all faktury to nova
  await fetch(
    `${SUPABASE_URL}/rest/v1/faktury?id=in.(${ids.join(',')})`,
    { method: 'PATCH', headers: SB_W, body: JSON.stringify({ stav: 'nova', platba_naplanovana: false, datum_platby: null, zauctovano_platba: false }) }
  )

  return NextResponse.json({ ok: true, faktury: ids.length, transakce: unpairedCount })
}
