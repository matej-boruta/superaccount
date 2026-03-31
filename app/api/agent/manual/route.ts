/**
 * GET  /api/agent/manual        — vrátí celý manuál (všechny sekce, řazeno dle poradi)
 * GET  /api/agent/manual?sekce= — vrátí jednu sekci
 * POST /api/agent/manual        — aktualizuje nebo vytvoří sekci (upsert)
 *
 * Body pro POST:
 * {
 *   sekce: string       — unikátní klíč sekce (např. "03_pravidla")
 *   nazev: string       — zobrazovaný název
 *   obsah: string       — markdown obsah
 *   poradi?: number     — pořadí v manuálu
 *   updated_by?: string — "agent" nebo "manual"
 * }
 *
 * Agent volá POST automaticky při:
 * - Přidání nového pravidla do ucetni_pravidla
 * - Změně konfigurace v agent_api
 * - Každé verzi ústavy
 */
import { NextResponse } from 'next/server'

const SB_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SB_KEY = process.env.SUPABASE_SERVICE_KEY!
const SB = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` }

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const sekce = searchParams.get('sekce')

  const url = sekce
    ? `${SB_URL}/rest/v1/agent_manual?sekce=eq.${encodeURIComponent(sekce)}&select=*`
    : `${SB_URL}/rest/v1/agent_manual?select=*&order=poradi.asc`

  const res = await fetch(url, { headers: SB })
  const data = await res.json()

  if (sekce) {
    if (!Array.isArray(data) || !data[0]) return NextResponse.json({ error: 'Sekce nenalezena' }, { status: 404 })
    return NextResponse.json(data[0])
  }

  return NextResponse.json({ sekce: data, total: data.length })
}

export async function POST(req: Request) {
  const body = await req.json()
  const { sekce, nazev, obsah, poradi, updated_by } = body

  if (!sekce || !nazev || !obsah) {
    return NextResponse.json({ error: 'sekce, nazev a obsah jsou povinné' }, { status: 400 })
  }

  // Načti existující verzi pro inkrementaci
  const existRes = await fetch(
    `${SB_URL}/rest/v1/agent_manual?sekce=eq.${encodeURIComponent(sekce)}&select=verze`,
    { headers: SB }
  )
  const [existing] = await existRes.json()
  const noveVerze = (existing?.verze ?? 0) + 1

  const payload = {
    sekce,
    nazev,
    obsah,
    poradi: poradi ?? existing?.poradi ?? 99,
    verze: noveVerze,
    updated_at: new Date().toISOString(),
    updated_by: updated_by ?? 'agent',
  }

  await fetch(`${SB_URL}/rest/v1/agent_manual`, {
    method: 'POST',
    headers: { ...SB, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(payload),
  })

  // Auto-commit — každá aktualizace manuálu se zaznamená v gitu
  const commitMsg = `Manuál: sekce ${sekce} aktualizována (v${noveVerze}) — ${updated_by ?? 'agent'}`
  fetch(`${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/api/agent/commit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: commitMsg, push: true, scope: ['manual'] }),
  }).catch(() => { /* best-effort */ })

  return NextResponse.json({ ok: true, sekce, verze: noveVerze })
}
