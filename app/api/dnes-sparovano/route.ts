import { NextResponse } from 'next/server'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY!

export async function GET() {
  const today = new Date().toISOString().slice(0, 10) // "2026-03-31"

  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/faktury?zauctovano_at=gte.${today}T00:00:00Z&stav=eq.zaplacena&select=dodavatel,castka_s_dph`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
  )
  const rows: { dodavatel: string; castka_s_dph: number }[] = await res.json()
  if (!Array.isArray(rows) || rows.length === 0) return NextResponse.json([])

  const grouped = new Map<string, { count: number; castka: number }>()
  for (const f of rows) {
    const prev = grouped.get(f.dodavatel) ?? { count: 0, castka: 0 }
    grouped.set(f.dodavatel, { count: prev.count + 1, castka: prev.castka + f.castka_s_dph })
  }

  return NextResponse.json(
    [...grouped.entries()].map(([dodavatel, v]) => ({ dodavatel, ...v }))
  )
}
