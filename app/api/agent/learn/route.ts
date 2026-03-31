/**
 * POST /api/agent/learn
 *
 * Volá se když člověk ručně opraví klasifikaci faktury.
 * Uloží korekci jako pravidlo do ucetni_pravidla (confidence=95, zdroj=manual).
 * Loguje do agent_log jako typ='korekce'.
 *
 * Body: {
 *   faktura_id: number
 *   kategorie_id: number        — nová správná kategorie
 *   dodavatel?: string
 *   ico?: string
 *   md_ucet?: string            — volitelně i předkontace
 *   dal_ucet?: string
 *   sazba_dph?: number
 *   poznamka?: string
 * }
 */
import { NextResponse } from 'next/server'
import { savePravidlo, logDecision } from '@/lib/rules'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY!
const SB = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }

export async function POST(req: Request) {
  const body = await req.json()
  const { faktura_id, kategorie_id, dodavatel, ico, md_ucet, dal_ucet, sazba_dph, poznamka } = body

  if (!faktura_id || !kategorie_id) {
    return NextResponse.json({ error: 'faktura_id a kategorie_id jsou povinné' }, { status: 400 })
  }

  // Načti fakturu pokud dodavatel/ico nejsou v body
  let finalDodavatel = dodavatel
  let finalIco = ico
  if (!finalDodavatel) {
    const fRes = await fetch(`${SUPABASE_URL}/rest/v1/faktury?id=eq.${faktura_id}&select=dodavatel,ico`, { headers: SB })
    const [f] = await fRes.json()
    finalDodavatel = f?.dodavatel
    finalIco = f?.ico
  }

  if (!finalDodavatel) {
    return NextResponse.json({ error: 'Faktura nenalezena nebo chybí dodavatel' }, { status: 404 })
  }

  // Ulož pravidlo (confidence=95 = manuální korekce člověkem)
  await savePravidlo({
    typ: 'predkontace',
    dodavatel: finalDodavatel,
    ico: finalIco ?? null,
    kategorie_id,
    md_ucet: md_ucet ?? null,
    dal_ucet: dal_ucet ?? null,
    sazba_dph: sazba_dph ?? null,
    confidence: 95,
    zdroj: 'manual',
    poznamka: poznamka ?? `Manuální korekce — faktura ${faktura_id}`,
  })

  // Aktualizuj fakturu
  await fetch(`${SUPABASE_URL}/rest/v1/faktury?id=eq.${faktura_id}`, {
    method: 'PATCH',
    headers: { ...SB, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({ kategorie_id }),
  })

  // Loguj korekci do agent_log
  await logDecision({
    typ: 'korekce',
    vstup: { faktura_id, dodavatel: finalDodavatel, ico: finalIco },
    vystup: { kategorie_id, md_ucet, dal_ucet, zdroj: 'manual_correction' },
    confidence: 95,
    pravidlo_zdroj: 'manual',
    faktura_id,
  })

  // Auto-commit do gitu — zaznamená učení v historii
  const commitMsg = `Pravidlo: ${finalDodavatel} → kat=${kategorie_id}, conf=95 (manuální korekce faktura ${faktura_id})`
  fetch(`${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/api/agent/commit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: commitMsg, push: true, scope: ['pravidla'] }),
  }).catch(() => { /* commit je best-effort, nesmí blokovat */ })

  return NextResponse.json({
    ok: true,
    pravidlo_ulozeno: finalDodavatel,
    kategorie_id,
    poznamka: 'Pravidlo uloženo s confidence=95. Příště aplikováno automaticky.',
  })
}
