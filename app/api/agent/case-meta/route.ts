/**
 * GET /api/agent/case-meta?rok=2026
 * Vrátí poslední agent_log metadata per faktura_id:
 *   { [faktura_id]: { confidence, source_of_rule, rezim } }
 * Slouží pro zobrazení confidence + source_of_rule u Schválit tlačítka.
 */
import { NextResponse } from 'next/server'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY!

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const rok = searchParams.get('rok') ?? String(new Date().getFullYear())

  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/agent_log?created_at=gte.${rok}-01-01` +
    `&select=faktura_id,confidence,source_of_rule,rezim&order=created_at.desc&limit=500`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
  )
  const logs = await res.json()
  if (!Array.isArray(logs)) return NextResponse.json({})

  // Deduplicate: nejnovější záznam per faktura_id
  const meta: Record<number, { confidence: number; source_of_rule: string; rezim: string }> = {}
  for (const log of logs) {
    if (log.faktura_id != null && !meta[log.faktura_id]) {
      meta[log.faktura_id] = {
        confidence: log.confidence ?? 0,
        source_of_rule: log.source_of_rule ?? '',
        rezim: log.rezim ?? '',
      }
    }
  }
  return NextResponse.json(meta)
}
