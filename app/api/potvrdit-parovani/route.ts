/**
 * POST /api/potvrdit-parovani
 *
 * Lidské potvrzení navrženého párování (stav='navrzeno').
 * Po potvrzení: transakce → sparovano, faktura → zaplacena, pravidlo.confidence → 90.
 *
 * Body: { transakce_id: number, faktura_id: number }
 */

import { NextResponse } from 'next/server'
import { writeRozhodnuti } from '@/lib/rules'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY!
const SB = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
  Prefer: 'return=minimal',
}
const SBR = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}))
  const transakceId = Number(body.transakce_id)
  const fakturaId = Number(body.faktura_id)

  if (!transakceId || !fakturaId) {
    return NextResponse.json({ error: 'Chybí transakce_id nebo faktura_id' }, { status: 400 })
  }

  // 1. Ověř že transakce je ve stavu navrzeno a patří k této faktuře
  const tRes = await fetch(
    `${SUPABASE_URL}/rest/v1/transakce?id=eq.${transakceId}&stav=eq.navrzeno&faktura_id=eq.${fakturaId}&select=id,stav,faktura_id`,
    { headers: SBR }
  )
  const [transakce] = await tRes.json().catch(() => [])
  if (!transakce) {
    return NextResponse.json({ error: 'Transakce nenalezena nebo není ve stavu navrzeno pro tuto fakturu' }, { status: 404 })
  }

  // 2. Najdi pravidlo použité při návrhu (přes rozodnuti)
  const rozRes = await fetch(
    `${SUPABASE_URL}/rest/v1/rozhodnuti?faktura_id=eq.${fakturaId}&transakce_id=eq.${transakceId}&typ=eq.parovani&stav=eq.proposed&select=id,pravidlo_id&order=created_at.desc&limit=1`,
    { headers: SBR }
  )
  const [rozhodnuti] = await rozRes.json().catch(() => [])
  const pravidloId: number | null = rozhodnuti?.pravidlo_id ?? null

  // 3. Spáruj v Supabase
  await Promise.all([
    fetch(`${SUPABASE_URL}/rest/v1/transakce?id=eq.${transakceId}`, {
      method: 'PATCH', headers: SB,
      body: JSON.stringify({ stav: 'sparovano', faktura_id: fakturaId }),
    }),
    fetch(`${SUPABASE_URL}/rest/v1/faktury?id=eq.${fakturaId}`, {
      method: 'PATCH', headers: SB,
      body: JSON.stringify({
        stav: 'zaplacena',
        stav_workflow: 'POSTED',
        blocker: null,
        zauctovano_at: new Date().toISOString(),
      }),
    }),
  ])

  // 4. Posilni pravidlo na confidence 90 (tiché potvrzení → jde příště automaticky)
  if (pravidloId) {
    try {
      const pRes = await fetch(`${SUPABASE_URL}/rest/v1/pravidla?id=eq.${pravidloId}&select=confidence`, { headers: SBR })
      const [pravidlo] = await pRes.json().catch(() => [])
      if (pravidlo && Number(pravidlo.confidence) < 90) {
        await fetch(`${SUPABASE_URL}/rest/v1/pravidla?id=eq.${pravidloId}`, {
          method: 'PATCH', headers: SB,
          body: JSON.stringify({ confidence: 90 }),
        })
      }
    } catch { /* non-blocking */ }
  }

  // 5. Zapiš rozhodnutí — lidské potvrzení
  await writeRozhodnuti({
    entity_type: 'faktura',
    entity_id: fakturaId,
    faktura_id: fakturaId,
    transakce_id: transakceId,
    typ: 'parovani',
    agent: 'human',
    pravidlo_id: pravidloId,
    navrh: { match_type: 'card_confirmed', confidence_after: 90 },
    confidence: 100,
    stav: 'accepted',
    zdroj: 'manual_confirmation',
  })

  return NextResponse.json({
    ok: true,
    transakce_id: transakceId,
    faktura_id: fakturaId,
    pravidlo_id: pravidloId,
    confidence_set: pravidloId ? 90 : null,
    message: pravidloId
      ? 'Spárováno. Pravidlo posíleno na conf 90 — příště proběhne automaticky.'
      : 'Spárováno. Pravidlo nenalezeno — confidence nezměněna.',
  })
}
