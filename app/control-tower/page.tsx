'use client'

import { useEffect, useState, useCallback } from 'react'

// ── KPI line chart ────────────────────────────────────────────────────────────

type KpiPoint = { date: string; value: number; status: string }
type KpiDef = { id: string; key: string; name: string; owner_role: string; target_value: number | null; unit: string | null }

const KPI_COLORS: Record<string, string> = {
  accountant: '#3b82f6',
  auditor: '#8b5cf6',
  pm: '#10b981',
  architect: '#f59e0b',
  orchestrator: '#6366f1',
}

function LineChart({ points, target, unit, color }: {
  points: KpiPoint[]
  target: number | null
  unit: string | null
  color: string
}) {
  if (points.length === 0) return (
    <div className="h-20 flex items-center justify-center text-[11px] text-gray-400">Žádná data</div>
  )

  const W = 280, H = 72, PAD = { t: 8, r: 8, b: 20, l: 32 }
  const iw = W - PAD.l - PAD.r
  const ih = H - PAD.t - PAD.b

  // value range
  const vals = points.map(p => p.value)
  const hasTarget = target !== null
  const allVals = hasTarget ? [...vals, target] : vals
  const minV = Math.min(...allVals)
  const maxV = Math.max(...allVals)
  const range = maxV - minV || 1

  const x = (i: number) => PAD.l + (i / Math.max(points.length - 1, 1)) * iw
  const y = (v: number) => PAD.t + ih - ((v - minV) / range) * ih

  const pathD = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ')

  // Labels: show first, last, and every N-th
  const step = Math.ceil(points.length / 4)
  const labelIdxs = new Set([0, points.length - 1])
  for (let i = step; i < points.length - 1; i += step) labelIdxs.add(i)

  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="overflow-visible w-full">
      {/* grid lines */}
      {[0, 0.5, 1].map(t => {
        const yy = (PAD.t + ih * (1 - t)).toFixed(1)
        const val = (minV + range * t).toFixed(unit === '%' ? 0 : 1)
        return (
          <g key={t}>
            <line x1={PAD.l} x2={W - PAD.r} y1={yy} y2={yy} stroke="#e5e7eb" strokeWidth="1" />
            <text x={PAD.l - 4} y={Number(yy) + 3} textAnchor="end" fontSize="8" fill="#9ca3af">{val}</text>
          </g>
        )
      })}
      {/* target line */}
      {hasTarget && (
        <line
          x1={PAD.l} x2={W - PAD.r}
          y1={y(target!).toFixed(1)} y2={y(target!).toFixed(1)}
          stroke={color} strokeWidth="1" strokeDasharray="3 3" opacity="0.5"
        />
      )}
      {/* area fill */}
      <path
        d={`${pathD} L${x(points.length - 1).toFixed(1)},${(PAD.t + ih).toFixed(1)} L${PAD.l.toFixed(1)},${(PAD.t + ih).toFixed(1)} Z`}
        fill={color} fillOpacity="0.08"
      />
      {/* line */}
      <path d={pathD} stroke={color} strokeWidth="1.5" fill="none" strokeLinejoin="round" strokeLinecap="round" />
      {/* dots */}
      {points.map((p, i) => (
        <circle key={i} cx={x(i)} cy={y(p.value)} r="2.5" fill={color}
          opacity={p.status === 'bad' ? 1 : 0.7}
          stroke={p.status === 'bad' ? '#ef4444' : p.status === 'warning' ? '#f59e0b' : 'none'}
          strokeWidth="1.5">
          <title>{p.date}: {p.value}{unit}</title>
        </circle>
      ))}
      {/* x labels */}
      {[...labelIdxs].map(i => (
        <text key={i} x={x(i)} y={H - 2} textAnchor="middle" fontSize="8" fill="#9ca3af">
          {points[i].date.slice(5)}
        </text>
      ))}
    </svg>
  )
}

// ── typy ──────────────────────────────────────────────────────────────────────

type CtData = {
  snapshot: Record<string, unknown>
  analysis: {
    system_health: { overall_score: number; accounting_quality: number; audit_quality: number; workflow_quality: number; data_quality: number; architecture_quality: number; learning_quality: number; summary: string }
    kpi_by_agent: Array<{ agent_name: string; strongest_area: string; weakest_area: string; risk_level: string; performance_summary: string }>
    critical_issues: Array<{ severity: string; type: string; owner_agent: string; title: string; symptom: string; root_cause: string; impact: string; recommended_fix: string }>
    patterns: Array<{ description: string; trend: string }>
    quick_wins: Array<{ action: string; effort: string; impact: string }>
    strategic_improvements: Array<{ title: string; description: string; priority: string }>
  } | null
  agent_errors: Array<{ id: number; typ: string; rezim: string; feedback_type: string | null; faktura_id: number | null; created_at: string }>
  agent_trend: Record<string, Array<{ week: string; avg_confidence: number; decisions: number; error_rate_pct: number }>>
  agent_kpi: Record<string, { total_decisions: number; error_rate_pct: number; fix_rate_pct: number }>
  generated_at: string
}

type AbraResult = {
  diff: Array<{ id: number; dodavatel: string; vs: string; sb_stav: string }> | null
  onlySB: Array<{ id: number; dodavatel: string; vs: string }> | null
  onlyABRA: Array<{ kod: string; dodavatel: string }> | null
  stats: { sbTotal: number; abraTotal: number; matched: number; abraBankaTotal?: number }
}

// ── helpers ───────────────────────────────────────────────────────────────────

const YEAR = new Date().getFullYear()

function ScoreBar({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-[11px] text-gray-500">{label}</span>
        <span className={`text-[11px] font-semibold ${color}`}>{value}</span>
      </div>
      <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
        <div className={`h-full rounded-full transition-all ${value >= 80 ? 'bg-green-500' : value >= 60 ? 'bg-amber-400' : 'bg-red-400'}`} style={{ width: `${value}%` }} />
      </div>
    </div>
  )
}

function AgentCard({ agentKey, label, color, bg, border, kpi, trend }: {
  agentKey: string; label: string; color: string; bg: string; border: string
  kpi?: { total_decisions: number; error_rate_pct: number; fix_rate_pct: number }
  trend?: Array<{ week: string; avg_confidence: number; decisions: number; error_rate_pct: number }>
}) {
  const weeks = trend?.slice(-6) ?? []
  const maxConf = 100
  return (
    <div className={`rounded-2xl border ${border} ${bg} px-4 py-4`}>
      <div className="flex items-start justify-between mb-3">
        <div>
          <div className={`text-[11px] font-bold uppercase tracking-wider ${color}`}>{label}</div>
          {kpi && kpi.total_decisions > 0 ? (
            <div className="text-[10px] text-gray-400 mt-0.5">{kpi.total_decisions} rozh.</div>
          ) : (
            <div className="text-[10px] text-gray-400 mt-0.5">žádná data</div>
          )}
        </div>
        {kpi && kpi.total_decisions > 0 && (
          <div className="text-right">
            <div className={`text-[15px] font-bold leading-none ${kpi.error_rate_pct > 10 ? 'text-red-600' : kpi.error_rate_pct > 5 ? 'text-amber-600' : 'text-green-600'}`}>
              {kpi.error_rate_pct}%
            </div>
            <div className="text-[9px] text-gray-400 mt-0.5">chybovost</div>
          </div>
        )}
      </div>
      {/* Sparkline */}
      {weeks.length > 0 && (
        <div className="flex items-end gap-0.5 h-8">
          {weeks.map((w, i) => (
            <div key={i} className="flex-1 flex flex-col items-center justify-end gap-0.5 h-full">
              <div
                className="w-full rounded-sm bg-blue-300 opacity-60"
                style={{ height: `${Math.round((w.avg_confidence / maxConf) * 100)}%`, minHeight: 2 }}
                title={`${w.week}: conf ${w.avg_confidence}%`}
              />
              {w.error_rate_pct > 0 && (
                <div
                  className="w-full rounded-sm bg-red-400"
                  style={{ height: `${Math.min(w.error_rate_pct, 30)}%`, minHeight: 1 }}
                  title={`chyb: ${w.error_rate_pct}%`}
                />
              )}
            </div>
          ))}
        </div>
      )}
      {kpi && kpi.total_decisions > 0 && (
        <div className="flex gap-3 mt-2">
          <div className="text-[10px] text-gray-500">Fix rate: <span className="font-medium text-gray-700">{kpi.fix_rate_pct}%</span></div>
        </div>
      )}
    </div>
  )
}

// ── hlavní komponenta ─────────────────────────────────────────────────────────

export default function ControlTowerPage() {
  const [year, setYear] = useState(YEAR)
  const [ctData, setCtData] = useState<CtData | null>(null)
  const [abraData, setAbraData] = useState<AbraResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadingAbra, setLoadingAbra] = useState(false)
  const [tab, setTab] = useState<'dashboard' | 'orchestrator' | 'abra' | 'agent'>('dashboard')
  const [kpiHistory, setKpiHistory] = useState<{ kpis: KpiDef[]; series: Record<string, KpiPoint[]> } | null>(null)
  const [kpiLoading, setKpiLoading] = useState(false)

  // Strategic Orchestrator
  const [orchRunning, setOrchRunning] = useState(false)
  const [orchData, setOrchData] = useState<{
    system_health_pct: number; dry_run: boolean; summary: string
    goals: Array<{ id: string; label: string; target: string; current: unknown; ok: boolean; urgency: string; action: string | null; owner: string }>
    plan: Array<{ order: number; owner: string; task: string; urgency: string; why: string }>
    execution: Array<{ step: number; owner: string; task: string; result: string; ok: boolean }>
    strategic_insight: string | null
  } | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`/api/agent/control-tower?rok=${year}`)
      const data = await res.json()
      setCtData(data)
    } catch { /* silent */ }
    setLoading(false)
  }, [year])

  const loadAbra = useCallback(async () => {
    setLoadingAbra(true)
    try {
      const res = await fetch(`/api/abra-reconcile?rok=${year}`)
      const data = await res.json()
      setAbraData(data)
    } catch { /* silent */ }
    setLoadingAbra(false)
  }, [year])

  const loadKpi = useCallback(async () => {
    setKpiLoading(true)
    try {
      const res = await fetch('/api/agent/kpi-history')
      setKpiHistory(await res.json())
    } catch { /* silent */ }
    setKpiLoading(false)
  }, [])

  useEffect(() => { load(); loadAbra(); loadKpi() }, [load, loadAbra, loadKpi])

  const runOrch = async (dryRun = false) => {
    if (orchRunning) return
    setOrchRunning(true)
    try {
      const res = await fetch('/api/agent/strategic-orchestrator', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ year, dry_run: dryRun }),
      })
      setOrchData(await res.json())
    } catch { /* silent */ }
    setOrchRunning(false)
  }

  const sh = ctData?.analysis?.system_health
  const abraBad = abraData && (
    (abraData.diff?.length ?? 0) > 0 ||
    (abraData.onlySB?.length ?? 0) > 0 ||
    (abraData.onlyABRA?.length ?? 0) > 0
  )
  const urgencyColor = (u: string) => u === 'critical' ? 'bg-red-50 border-red-200 text-red-700' : u === 'high' ? 'bg-orange-50 border-orange-200 text-orange-700' : u === 'medium' ? 'bg-amber-50 border-amber-200 text-amber-700' : 'bg-green-50 border-green-200 text-green-700'

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="sticky top-0 z-10 bg-white border-b border-gray-100 px-6 py-3 flex items-center justify-between">
        <div>
          <div className="text-[15px] font-semibold text-gray-900">Control Tower</div>
          <div className="text-[11px] text-gray-400">Systémová inteligence · SuperAccount {year}</div>
        </div>
        <div className="flex items-center gap-3">
          <select
            value={year}
            onChange={e => setYear(Number(e.target.value))}
            className="text-[12px] border border-gray-200 rounded-lg px-2 py-1 text-gray-700"
          >
            {[2026, 2025].map(y => <option key={y} value={y}>{y}</option>)}
          </select>
          <button
            onClick={() => { load(); loadAbra() }}
            disabled={loading}
            className="text-[11px] px-3 py-1.5 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-40"
          >
            {loading ? 'Analyzuji…' : 'Obnovit'}
          </button>
        </div>
      </div>

      {/* System Health bar */}
      {sh && (
        <div className={`px-6 py-3 flex items-center gap-4 border-b ${sh.overall_score >= 80 ? 'bg-green-50 border-green-100' : sh.overall_score >= 60 ? 'bg-amber-50 border-amber-100' : 'bg-red-50 border-red-100'}`}>
          <div className={`text-[24px] font-bold leading-none ${sh.overall_score >= 80 ? 'text-green-700' : sh.overall_score >= 60 ? 'text-amber-700' : 'text-red-700'}`}>
            {sh.overall_score}%
          </div>
          <div className="flex-1">
            <div className="text-[11px] font-medium text-gray-700">{sh.summary}</div>
          </div>
          {abraBad && (
            <div className="text-[11px] px-2.5 py-1 rounded-lg bg-orange-500 text-white font-medium">
              ABRA nesynchronizována
            </div>
          )}
        </div>
      )}

      {/* Tabs */}
      <div className="flex border-b border-gray-100 bg-white px-6">
        {(['dashboard', 'orchestrator', 'abra', 'agent'] as const).map(t => {
          const label = t === 'dashboard' ? 'Dashboard' : t === 'orchestrator' ? 'Orchestrátor' : t === 'abra' ? 'ABRA sync' : 'PM Agent'
          return (
            <button key={t}
              onClick={() => setTab(t)}
              className={`px-4 py-3 text-[12px] font-medium border-b-2 transition-colors whitespace-nowrap ${tab === t ? 'border-[#0071e3] text-[#0071e3]' : 'border-transparent text-gray-500 hover:text-gray-700'}`}
            >
              {label}
              {t === 'abra' && abraBad && (
                <span className="ml-1.5 inline-flex items-center justify-center min-w-[14px] h-[14px] rounded-full bg-orange-500 text-white text-[9px] font-bold px-0.5">!</span>
              )}
            </button>
          )
        })}
      </div>

      <div className="p-6">
        {loading && (
          <div className="text-center py-16 text-[13px] text-gray-400 animate-pulse">Analyzuji systém…</div>
        )}

        {/* ── DASHBOARD ── */}
        {!loading && tab === 'dashboard' && ctData?.analysis && (() => {
          const { system_health: sh2, kpi_by_agent, critical_issues, quick_wins } = ctData.analysis
          return (
            <div className="space-y-6 max-w-5xl">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {/* System Health detail */}
                <div className="bg-white rounded-2xl border border-gray-100 px-5 py-5 space-y-3">
                  <div className="text-[11px] font-bold text-gray-400 uppercase tracking-wider">Zdraví systému</div>
                  <ScoreBar label="Účetnictví" value={sh2.accounting_quality} color={sh2.accounting_quality >= 80 ? 'text-green-600' : 'text-amber-600'} />
                  <ScoreBar label="Audit" value={sh2.audit_quality} color={sh2.audit_quality >= 80 ? 'text-green-600' : 'text-amber-600'} />
                  <ScoreBar label="Workflow" value={sh2.workflow_quality} color={sh2.workflow_quality >= 80 ? 'text-green-600' : 'text-amber-600'} />
                  <ScoreBar label="Data" value={sh2.data_quality} color={sh2.data_quality >= 80 ? 'text-green-600' : 'text-amber-600'} />
                  <ScoreBar label="Learning" value={sh2.learning_quality} color={sh2.learning_quality >= 80 ? 'text-green-600' : 'text-amber-600'} />
                </div>

                {/* Critical issues */}
                <div className="bg-white rounded-2xl border border-gray-100 px-5 py-5">
                  <div className="text-[11px] font-bold text-gray-400 uppercase tracking-wider mb-3">Kritické problémy</div>
                  {critical_issues?.length > 0 ? (
                    <div className="space-y-2">
                      {critical_issues.slice(0, 5).map((issue, i) => (
                        <div key={i} className={`rounded-xl border px-3 py-2.5 ${issue.severity === 'critical' ? 'bg-red-50 border-red-200' : issue.severity === 'high' ? 'bg-orange-50 border-orange-200' : 'bg-amber-50 border-amber-200'}`}>
                          <div className="flex items-center gap-2 mb-0.5">
                            <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded ${issue.severity === 'critical' ? 'bg-red-100 text-red-700' : 'bg-orange-100 text-orange-700'}`}>{issue.severity}</span>
                            <span className="text-[10px] font-bold text-gray-500 uppercase">{issue.owner_agent}</span>
                          </div>
                          <div className="text-[12px] font-medium text-gray-800">{issue.title}</div>
                          <div className="text-[11px] text-gray-500 mt-0.5">{issue.recommended_fix}</div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-[12px] text-green-600 bg-green-50 rounded-xl px-3 py-3">Žádné kritické problémy</div>
                  )}
                </div>
              </div>

              {/* Výkonnost agentů */}
              {ctData.agent_kpi && (
                <div>
                  <div className="text-[11px] font-bold text-gray-400 uppercase tracking-wider mb-3">Výkonnost agentů</div>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    {[
                      { key: 'accountant', label: 'ACCOUNTANT', color: 'text-blue-700', bg: 'bg-blue-50', border: 'border-blue-100' },
                      { key: 'auditor', label: 'AUDITOR', color: 'text-purple-700', bg: 'bg-purple-50', border: 'border-purple-100' },
                      { key: 'pm', label: 'PM', color: 'text-green-700', bg: 'bg-green-50', border: 'border-green-100' },
                      { key: 'architect', label: 'ARCHITECT', color: 'text-amber-700', bg: 'bg-amber-50', border: 'border-amber-100' },
                    ].map(ag => (
                      <AgentCard
                        key={ag.key}
                        agentKey={ag.key}
                        label={ag.label}
                        color={ag.color}
                        bg={ag.bg}
                        border={ag.border}
                        kpi={ctData.agent_kpi?.[ag.key]}
                        trend={ctData.agent_trend?.[ag.key]}
                      />
                    ))}
                  </div>
                </div>
              )}

              {/* KPI by agent */}
              {kpi_by_agent?.length > 0 && (
                <div>
                  <div className="text-[11px] font-bold text-gray-400 uppercase tracking-wider mb-3">Hodnocení agentů</div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {kpi_by_agent.map((a, i) => (
                      <div key={i} className={`bg-white rounded-2xl border px-4 py-3 ${a.risk_level === 'high' ? 'border-red-200' : a.risk_level === 'medium' ? 'border-amber-200' : 'border-gray-100'}`}>
                        <div className="flex items-center justify-between mb-1">
                          <div className="text-[12px] font-bold text-gray-800">{a.agent_name}</div>
                          <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded ${a.risk_level === 'high' ? 'bg-red-100 text-red-700' : a.risk_level === 'medium' ? 'bg-amber-100 text-amber-700' : 'bg-green-100 text-green-700'}`}>{a.risk_level}</span>
                        </div>
                        <div className="text-[11px] text-gray-500">{a.performance_summary}</div>
                        <div className="flex gap-3 mt-1.5 text-[10px]">
                          <span className="text-green-600">{a.strongest_area}</span>
                          <span className="text-red-500">{a.weakest_area}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Quick wins */}
              {quick_wins?.length > 0 && (
                <div>
                  <div className="text-[11px] font-bold text-gray-400 uppercase tracking-wider mb-3">Quick wins</div>
                  <div className="space-y-2">
                    {quick_wins.map((w, i) => (
                      <div key={i} className="bg-white rounded-xl border border-gray-100 px-4 py-2.5 flex items-center gap-3">
                        <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded ${w.effort === 'low' ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-700'}`}>{w.effort}</span>
                        <span className="flex-1 text-[12px] text-gray-700">{w.action}</span>
                        <span className="text-[10px] text-gray-400">{w.impact}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* KPI trend grafy */}
              {kpiHistory && kpiHistory.kpis?.length > 0 && (() => {
                const { kpis, series } = kpiHistory
                const byRole: Record<string, KpiDef[]> = {}
                for (const k of kpis) {
                  if (!byRole[k.owner_role]) byRole[k.owner_role] = []
                  byRole[k.owner_role].push(k)
                }
                return (
                  <div>
                    <div className="text-[11px] font-bold text-gray-400 uppercase tracking-wider mb-3">KPI v čase</div>
                    <div className="space-y-4">
                      {Object.entries(byRole).map(([role, rolekpis]) => {
                        const color = KPI_COLORS[role] ?? '#6b7280'
                        return (
                          <div key={role} className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
                            <div className="px-5 py-2.5 border-b border-gray-50 flex items-center gap-2">
                              <span className="w-2 h-2 rounded-full shrink-0" style={{ background: color }} />
                              <span className="text-[11px] font-bold text-gray-500 uppercase tracking-wider">{role}</span>
                            </div>
                            <div className="grid grid-cols-2 lg:grid-cols-4 divide-x divide-gray-50">
                              {rolekpis.map(kpi => {
                                const pts = series[kpi.key] ?? []
                                const last = pts[pts.length - 1]
                                const statusColor = !last ? 'text-gray-400' : last.status === 'bad' ? 'text-red-600' : last.status === 'warning' ? 'text-amber-600' : 'text-green-600'
                                return (
                                  <div key={kpi.key} className="px-4 py-3">
                                    <div className="flex items-baseline justify-between mb-1 gap-1">
                                      <div className="text-[10px] text-gray-500 truncate flex-1">{kpi.name}</div>
                                      <div className={`text-[13px] font-bold tabular-nums shrink-0 ${statusColor}`}>
                                        {last ? `${last.value}${kpi.unit ?? ''}` : '—'}
                                      </div>
                                    </div>
                                    <LineChart points={pts} target={kpi.target_value} unit={kpi.unit} color={color} />
                                  </div>
                                )
                              })}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )
              })()}
            </div>
          )
        })()}

        {/* ── ORCHESTRÁTOR ── */}
        {!loading && tab === 'orchestrator' && (
          <div className="space-y-4 max-w-3xl">
            <div className="bg-gray-900 rounded-2xl px-5 py-4 flex items-center justify-between gap-4">
              <div>
                <div className="text-[13px] font-semibold text-white">Strategic Orchestrator</div>
                <div className="text-[11px] text-gray-400 mt-0.5">Vyhodnotí cíle systému a spustí agenty</div>
              </div>
              <div className="flex gap-2 shrink-0">
                <button onClick={() => runOrch(true)} disabled={orchRunning} className="text-[11px] px-3 py-1.5 rounded-lg border border-gray-600 text-gray-300 hover:bg-gray-800 disabled:opacity-40">
                  {orchRunning ? '…' : 'Dry run'}
                </button>
                <button onClick={() => runOrch(false)} disabled={orchRunning} className="text-[11px] px-4 py-1.5 rounded-lg bg-[#0071e3] hover:bg-[#0077ed] text-white font-medium disabled:opacity-40">
                  {orchRunning ? 'Běží…' : 'Spustit'}
                </button>
              </div>
            </div>

            {orchRunning && <div className="text-center py-8 text-[13px] text-gray-400 animate-pulse">Analyzuji systém…</div>}

            {orchData && !orchRunning && (
              <>
                <div className="flex items-center gap-3">
                  <div className={`text-[32px] font-bold leading-none ${orchData.system_health_pct >= 80 ? 'text-green-600' : orchData.system_health_pct >= 50 ? 'text-amber-600' : 'text-red-600'}`}>{orchData.system_health_pct}%</div>
                  <div>
                    <div className="text-[12px] font-medium text-gray-700">Zdraví systému</div>
                    <div className="text-[11px] text-gray-400">{orchData.summary}</div>
                  </div>
                  {orchData.dry_run && <span className="ml-auto text-[10px] px-2 py-0.5 rounded-full bg-gray-100 text-gray-500">DRY RUN</span>}
                </div>

                {orchData.strategic_insight && (
                  <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-[12px] text-amber-800">{orchData.strategic_insight}</div>
                )}

                <div>
                  <div className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-2">Cíle systému</div>
                  <div className="space-y-1.5">
                    {orchData.goals.map(g => (
                      <div key={g.id} className={`flex items-center gap-3 rounded-xl px-3 py-2 border ${g.ok ? 'bg-green-50 border-green-200' : urgencyColor(g.urgency)}`}>
                        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${g.ok ? 'bg-green-500' : g.urgency === 'critical' ? 'bg-red-500' : g.urgency === 'high' ? 'bg-orange-500' : 'bg-amber-400'}`} />
                        <span className="flex-1 text-[12px] font-medium">{g.label}</span>
                        <span className="text-[10px] text-gray-500">{String(g.current)} → {g.target}</span>
                        {!g.ok && <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded ${urgencyColor(g.urgency)}`}>{g.urgency}</span>}
                        {g.ok && <span className="text-green-500">✓</span>}
                      </div>
                    ))}
                  </div>
                </div>

                {orchData.plan.length > 0 && (
                  <div>
                    <div className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-2">Plán ({orchData.plan.length} kroků)</div>
                    <div className="space-y-1.5">
                      {orchData.plan.map(step => {
                        const exec = orchData.execution.find(e => e.step === step.order)
                        return (
                          <div key={step.order} className="flex items-start gap-3 bg-white rounded-xl border border-gray-100 px-4 py-3">
                            <span className="text-[10px] font-bold text-gray-400 w-4 shrink-0 mt-0.5">{step.order}.</span>
                            <div className="flex-1 min-w-0">
                              <div className="text-[12px] font-medium text-gray-800">{step.task}</div>
                              <div className="text-[10px] text-gray-400 mt-0.5">{step.why}</div>
                            </div>
                            <div className="shrink-0 text-right">
                              <span className="text-[9px] uppercase font-bold text-gray-400">{step.owner}</span>
                              {exec && <div className={`text-[10px] mt-0.5 ${exec.ok ? 'text-green-600' : 'text-red-500'}`}>{exec.ok ? '✓' : '✗'} {exec.result}</div>}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )}
              </>
            )}

            {!orchData && !orchRunning && (
              <div className="text-center py-12 text-[12px] text-gray-400 bg-white rounded-2xl border border-gray-100">
                Spusť orchestrátor pro automatickou analýzu a provedení kroků.
              </div>
            )}
          </div>
        )}

        {/* ── ABRA SYNC ── */}
        {!loading && tab === 'abra' && (
          <div className="space-y-4 max-w-3xl">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-[13px] font-semibold text-gray-800">ABRA sync</div>
                <div className="text-[11px] text-gray-400 mt-0.5">Supabase = zdroj pravdy · ABRA = zákonný výstup · tolerance 0</div>
              </div>
            </div>

            {loadingAbra && <div className="text-center py-10 text-[13px] text-gray-400 animate-pulse">Načítám z ABRA…</div>}

            {!loadingAbra && abraData && (() => {
              const allOk = !abraBad
              return (
                <>
                  <div className={`rounded-2xl border px-5 py-4 ${allOk ? 'bg-green-50 border-green-200' : 'bg-red-50 border-red-200'}`}>
                    <div className={`text-[13px] font-semibold ${allOk ? 'text-green-700' : 'text-red-700'}`}>
                      {allOk ? '✓ ABRA synchronizována' : '✗ Nalezeny rozdíly — ABRA není synchronizována'}
                    </div>
                    <div className="text-[11px] text-gray-500 mt-1">
                      SB: <b>{abraData.stats.sbTotal}</b> faktur · ABRA FP: <b>{abraData.stats.abraTotal}</b> · Spárováno: <b>{abraData.stats.matched}</b>
                      {abraData.stats.abraBankaTotal !== undefined && ` · Banka ABRA: ${abraData.stats.abraBankaTotal}`}
                    </div>
                  </div>

                  {(abraData.diff?.length ?? 0) > 0 && (
                    <div className="bg-white rounded-2xl border border-amber-200 px-5 py-4">
                      <div className="text-[11px] font-bold text-amber-700 uppercase tracking-wider mb-2">Rozdílný stav ({abraData.diff!.length})</div>
                      {abraData.diff!.map((d, i) => (
                        <div key={i} className="flex items-center gap-3 py-1.5 border-b border-gray-50 last:border-0">
                          <span className="flex-1 text-[12px] text-gray-700">{d.dodavatel}</span>
                          <span className="text-[10px] text-gray-400">{d.vs}</span>
                          <span className="text-[10px] text-green-600 bg-green-50 px-1.5 rounded">SB: {d.sb_stav}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  {(abraData.onlySB?.length ?? 0) > 0 && (
                    <div className="bg-white rounded-2xl border border-red-200 px-5 py-4">
                      <div className="text-[11px] font-bold text-red-700 uppercase tracking-wider mb-2">V SB, chybí v ABRA ({abraData.onlySB!.length})</div>
                      {abraData.onlySB!.map((d, i) => (
                        <div key={i} className="flex items-center gap-3 py-1.5 border-b border-gray-50 last:border-0">
                          <span className="flex-1 text-[12px] text-gray-700">{d.dodavatel}</span>
                          <span className="text-[10px] text-gray-400">{d.vs}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )
            })()}

            {!loadingAbra && !abraData && (
              <div className="text-center py-10">
                <button onClick={loadAbra} className="px-4 py-2 bg-[#0071e3] text-white rounded-xl text-[12px] font-medium">Načíst ABRA data</button>
              </div>
            )}
          </div>
        )}

        {/* ── PM AGENT ── */}
        {!loading && tab === 'agent' && (
          <div className="max-w-3xl">
            <PmAgentTab year={year} />
          </div>
        )}


        {!loading && !ctData && tab === 'dashboard' && (
          <div className="text-center py-16">
            <button onClick={load} className="px-5 py-2.5 bg-[#0071e3] text-white rounded-xl text-[13px] font-medium">Spustit analýzu</button>
          </div>
        )}
      </div>
    </div>
  )
}

// ── PM Agent tab ──────────────────────────────────────────────────────────────

function PmAgentTab({ year }: { year: number }) {
  const [running, setRunning] = useState(false)
  const [log, setLog] = useState<Array<{ type: string; text: string }>>([])
  const [summary, setSummary] = useState('')

  const run = async () => {
    setRunning(true)
    setLog([])
    setSummary('')
    try {
      const res = await fetch('/api/agent/pm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ year, orchestrator_task: 'Prověř kompletnost dat pro rok ' + year + '. Zkontroluj faktury, transakce, chybějící dokumenty, nespárované platby.' }),
      })
      const data = await res.json()
      setLog(data.log ?? [])
      setSummary(data.summary ?? '')
    } catch (e) {
      setSummary(String(e))
    }
    setRunning(false)
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-[13px] font-semibold text-gray-800">PM Agent</div>
          <div className="text-[11px] text-gray-400 mt-0.5">Garant kompletnosti dat · CASE workflow</div>
        </div>
        <button onClick={run} disabled={running} className="text-[11px] px-4 py-1.5 rounded-lg bg-green-600 hover:bg-green-700 text-white font-medium disabled:opacity-40">
          {running ? 'Běží…' : 'Spustit PM check'}
        </button>
      </div>

      {summary && (
        <div className="bg-gray-50 rounded-xl border border-gray-200 px-4 py-3 text-[12px] text-gray-700">{summary}</div>
      )}

      {log.length > 0 && (
        <div className="space-y-1">
          {log.map((l, i) => (
            <div key={i} className={`flex items-start gap-2 text-[11px] px-3 py-1.5 rounded-lg ${l.type === 'warn' ? 'bg-orange-50 text-orange-700' : l.type === 'action' ? 'bg-green-50 text-green-700' : 'text-gray-500'}`}>
              <span className="shrink-0 font-bold">{l.type === 'warn' ? '⚠' : l.type === 'action' ? '✓' : '·'}</span>
              <span>{l.text}</span>
            </div>
          ))}
        </div>
      )}

      {!running && log.length === 0 && (
        <div className="text-center py-10 text-[12px] text-gray-400 bg-white rounded-2xl border border-gray-100">
          Spusť PM check pro audit kompletnosti dat.
        </div>
      )}
    </div>
  )
}
