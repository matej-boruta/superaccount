import { NextResponse } from 'next/server'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY!
const SB = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, Range: '0-9999' }

export async function GET() {
  const [kpisRes, measurementsRes] = await Promise.all([
    fetch(`${SUPABASE_URL}/rest/v1/agent_kpis?select=id,key,name,owner_role,target_value,unit&active=eq.true&order=owner_role.asc`, { headers: SB }),
    fetch(`${SUPABASE_URL}/rest/v1/agent_kpi_measurements?select=kpi_id,period_from,value,status,measured_at&order=measured_at.asc`, { headers: SB }),
  ])

  const kpis: Array<{ id: string; key: string; name: string; owner_role: string; target_value: number | null; unit: string | null }> =
    await kpisRes.json().catch(() => [])
  const measurements: Array<{ kpi_id: string; period_from: string; value: number; status: string; measured_at: string }> =
    await measurementsRes.json().catch(() => [])

  if (!Array.isArray(kpis)) return NextResponse.json({ kpis: [], series: {} })

  // Group measurements by kpi_id → sorted by date
  const byKpi: Record<string, Array<{ date: string; value: number; status: string }>> = {}
  for (const m of Array.isArray(measurements) ? measurements : []) {
    if (!byKpi[m.kpi_id]) byKpi[m.kpi_id] = []
    byKpi[m.kpi_id].push({ date: m.period_from, value: Number(m.value), status: m.status })
  }

  // Deduplicate by date (keep last per day per kpi)
  const series: Record<string, Array<{ date: string; value: number; status: string }>> = {}
  for (const kpi of kpis) {
    const raw = byKpi[kpi.id] ?? []
    const seen = new Map<string, { value: number; status: string }>()
    for (const p of raw) seen.set(p.date, { value: p.value, status: p.status })
    series[kpi.key] = [...seen.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, v]) => ({ date, ...v }))
  }

  return NextResponse.json({ kpis, series })
}
