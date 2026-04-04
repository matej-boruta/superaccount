import { NextResponse } from 'next/server'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY!
const SB = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, Range: '0-9999' }
const SBW = { ...SB, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' }

/**
 * POST /api/agent/kpi-history
 * Zapíše dnešní snapshot všech KPI metrik do agent_kpi_measurements.
 * Voláno z CT dashboardu při každém refreshi (nebo cronu).
 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}))
  const rok: number = body.rok ?? new Date().getFullYear()
  const today = new Date().toISOString().slice(0, 10)
  const rokFilter = `datum_vystaveni=gte.${rok}-01-01&datum_vystaveni=lte.${rok}-12-31`

  // Načti data pro výpočet KPI
  const [faktury, transakce, agentLog, ucetniPravidla, kpis] = await Promise.all([
    fetch(`${SUPABASE_URL}/rest/v1/faktury?${rokFilter}&select=id,stav,kategorie_id,datum_splatnosti`, { headers: SB }).then(r => r.json()).catch(() => []),
    fetch(`${SUPABASE_URL}/rest/v1/transakce?datum=gte.${rok}-01-01&datum=lte.${rok}-12-31&select=id,stav,castka`, { headers: SB }).then(r => r.json()).catch(() => []),
    fetch(`${SUPABASE_URL}/rest/v1/agent_log?created_at=gte.${rok}-01-01&select=typ,confidence&order=created_at.desc&limit=500`, { headers: SB }).then(r => r.json()).catch(() => []),
    fetch(`${SUPABASE_URL}/rest/v1/ucetni_pravidla?select=id,confidence&aktivni=eq.true`, { headers: SB }).then(r => r.json()).catch(() => []),
    fetch(`${SUPABASE_URL}/rest/v1/agent_kpis?active=eq.true&select=id,key`, { headers: SB }).then(r => r.json()).catch(() => []),
  ])

  if (!Array.isArray(kpis) || kpis.length === 0) return NextResponse.json({ ok: false, error: 'no kpis defined' })

  const kpiMap: Record<string, string> = {}
  for (const k of kpis) kpiMap[k.key] = k.id

  const total = Array.isArray(faktury) ? faktury.length || 1 : 1
  const bezKat = Array.isArray(faktury) ? faktury.filter((f: Record<string,unknown>) => !f.kategorie_id).length : 0
  const nespar = Array.isArray(transakce) ? transakce.filter((t: Record<string,unknown>) => t.stav === 'nesparovano' && Number(t.castka) < 0).length : 0
  const spar = Array.isArray(transakce) ? transakce.filter((t: Record<string,unknown>) => t.stav === 'sparovano').length : 0
  const korekce = Array.isArray(agentLog) ? agentLog.filter((l: Record<string,unknown>) => l.typ === 'korekce').length : 0
  const rozhodnuti = Array.isArray(agentLog) ? agentLog.filter((l: Record<string,unknown>) => l.typ === 'rozhodnuti').length : 0
  const avgConf = Array.isArray(ucetniPravidla) && ucetniPravidla.length > 0
    ? Math.round(ucetniPravidla.reduce((s: number, p: Record<string,unknown>) => s + Number(p.confidence ?? 0), 0) / ucetniPravidla.length)
    : 0
  const overdue = Array.isArray(faktury)
    ? faktury.filter((f: Record<string,unknown>) => (f.stav === 'nova' || f.stav === 'schvalena') && f.datum_splatnosti && String(f.datum_splatnosti) < today).length
    : 0
  const errorRate = rozhodnuti > 0 ? Math.round((korekce / rozhodnuti) * 100) : 0

  // Sestavení hodnot per KPI key
  const values: Record<string, number> = {
    acc_classification_rate: Math.round(((total - bezKat) / total) * 100),
    acc_error_rate: errorRate,
    aud_false_negative_rate: errorRate,  // proxy — není přesnější zdroj
    aud_fix_rate: rozhodnuti > 0 ? Math.round(((rozhodnuti - korekce) / rozhodnuti) * 100) : 100,
    pm_coverage_rate: Math.round(((total - bezKat) / total) * 100),
    pm_unmatched_txn: nespar,
    sys_health_pct: Math.round((spar / (spar + nespar || 1)) * 40 + ((total - bezKat) / total) * 40 + (avgConf / 100) * 20),
    sys_overdue_count: overdue,
  }

  // Upsert (merge-duplicates) do agent_kpi_measurements
  // KPIs kde nižší = lepší (error rate, unmatched)
  const lowerIsBetter = new Set(['acc_error_rate', 'aud_false_negative_rate', 'pm_unmatched_txn', 'abra_sync_delta'])

  const rows = Object.entries(values)
    .filter(([key]) => kpiMap[key])
    .map(([key, value]) => {
      const kpi = kpis.find((k: { id: string; key: string }) => k.key === key)
      const target = (kpi as Record<string, unknown>)?.target_value as number | null ?? 90
      const isGood = lowerIsBetter.has(key) ? value <= (target ?? 10) : value >= (target ?? 90)
      return {
        kpi_id: kpiMap[key],
        period_from: today,
        period_to: today,
        value,
        status: isGood ? 'good' : 'bad',
      }
    })

  if (rows.length === 0) return NextResponse.json({ ok: false, error: 'no matching kpis' })

  const res = await fetch(`${SUPABASE_URL}/rest/v1/agent_kpi_measurements`, {
    method: 'POST',
    headers: SBW,
    body: JSON.stringify(rows),
  })

  return NextResponse.json({ ok: res.ok || res.status === 204, saved: rows.length, date: today, values })
}

export async function GET() {
  const [kpisRes, measurementsRes] = await Promise.all([
    fetch(`${SUPABASE_URL}/rest/v1/agent_kpis?select=id,key,name,owner_role,target_value,unit&active=eq.true&order=owner_role.asc`, { headers: SB, cache: 'no-store' }),
    fetch(`${SUPABASE_URL}/rest/v1/agent_kpi_measurements?select=kpi_id,period_from,value,status,measured_at&order=measured_at.asc`, { headers: SB, cache: 'no-store' }),
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
