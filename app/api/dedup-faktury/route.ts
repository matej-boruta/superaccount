import { NextResponse } from 'next/server'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY!
const SB = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }

export async function POST() {
  // Fetch all non-zaplacena faktury ordered by id asc (keep first = oldest import)
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/faktury?stav=in.(nova,ke_schvaleni,schvalena)&select=id,cislo_faktury,ico,castka_s_dph&order=id.asc&limit=2000`,
    { headers: SB }
  )
  const data: { id: number; cislo_faktury: string | null; ico: string | null; castka_s_dph: number }[] = await res.json()
  if (!Array.isArray(data)) return NextResponse.json({ error: 'Chyba Supabase' }, { status: 500 })

  // Group by cislo_faktury+ico — keep first, delete rest
  const seen = new Map<string, number>()
  const toDelete: number[] = []

  for (const f of data) {
    if (!f.cislo_faktury) continue
    const key = `${f.cislo_faktury}__${f.ico ?? ''}__${f.castka_s_dph}`
    if (seen.has(key)) {
      toDelete.push(f.id)
    } else {
      seen.set(key, f.id)
    }
  }

  if (toDelete.length === 0) return NextResponse.json({ ok: true, deleted: 0 })

  const delRes = await fetch(
    `${SUPABASE_URL}/rest/v1/faktury?id=in.(${toDelete.join(',')})`,
    { method: 'DELETE', headers: { ...SB, Prefer: 'return=minimal' } }
  )

  return NextResponse.json({ ok: delRes.ok, deleted: toDelete.length, ids: toDelete })
}
