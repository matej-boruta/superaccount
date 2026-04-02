/**
 * GET /api/agent/status
 * Vrátí počet NEEDS_INFO CASE (faktury čekající na odpověď člověka).
 * Slouží pro notification badge na Agent tlačítku v UI.
 */
import { NextResponse } from 'next/server'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY!

export async function GET() {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/faktury?stav_workflow=eq.NEEDS_INFO&select=id,dodavatel,blocker`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
  )
  const data = await res.json()
  const cases = Array.isArray(data) ? data : []
  return NextResponse.json({
    needs_info_count: cases.length,
    cases: cases.map((c: { id: number; dodavatel: string; blocker: string }) => ({
      id: c.id,
      dodavatel: c.dodavatel,
      blocker: c.blocker,
    })),
  })
}
