/**
 * GET  /api/agent/knowledge          – vypíše celou paměť agenta
 * POST /api/agent/knowledge          – přidá/aktualizuje znalost
 * DELETE /api/agent/knowledge?kategorie=X&klic=Y  – smaže znalost
 */
import { NextRequest, NextResponse } from 'next/server'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY!
const SB = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
const SB_W = { ...SB, 'Content-Type': 'application/json' }

export async function GET() {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/agent_knowledge?select=*&order=kategorie.asc,klic.asc`,
    { headers: SB }
  )
  const rows = await res.json()
  return NextResponse.json({ ok: true, count: rows.length, knowledge: rows })
}

export async function POST(req: NextRequest) {
  const body = await req.json()
  const { kategorie, klic, hodnota, zdroj = 'manual', poznamka } = body

  if (!kategorie || !klic || !hodnota) {
    return NextResponse.json({ error: 'kategorie, klic a hodnota jsou povinné' }, { status: 400 })
  }

  const res = await fetch(`${SUPABASE_URL}/rest/v1/agent_knowledge`, {
    method: 'POST',
    headers: {
      ...SB_W,
      Prefer: 'resolution=merge-duplicates,return=representation',
    },
    body: JSON.stringify({ kategorie, klic, hodnota, zdroj, poznamka, updated_at: new Date().toISOString() }),
  })
  const data = await res.json()
  return NextResponse.json({ ok: true, saved: data })
}

export async function DELETE(req: NextRequest) {
  const { searchParams } = req.nextUrl
  const kategorie = searchParams.get('kategorie')
  const klic = searchParams.get('klic')

  if (!kategorie || !klic) {
    return NextResponse.json({ error: 'kategorie a klic jsou povinné' }, { status: 400 })
  }

  await fetch(
    `${SUPABASE_URL}/rest/v1/agent_knowledge?kategorie=eq.${kategorie}&klic=eq.${klic}`,
    { method: 'DELETE', headers: SB }
  )
  return NextResponse.json({ ok: true, deleted: { kategorie, klic } })
}
