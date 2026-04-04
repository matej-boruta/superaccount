'use client'

import { useEffect, useState, useCallback } from 'react'

// ── Types ─────────────────────────────────────────────────────────────────────

type KpiPoint = { date: string; value: number; status: string }

type AccountantKpi = {
  accuracy: number | null
  auto_rate: number | null
  high_conf_accuracy: number | null
  repeat_error_rate: number
  feedback_conversion: number | null
  _total_decisions: number
  _corrections: number
  _high_conf_decisions: number
  _feedback_count: number
  _agent_rules: number
}

type CtData = {
  snapshot: Record<string, unknown>
  analysis: {
    system_health: { overall_score: number; accounting_quality: number; audit_quality: number; workflow_quality: number; data_quality: number; architecture_quality: number; learning_quality: number; summary: string }
    critical_issues: Array<{ severity: string; type: string; owner_agent: string; title: string; symptom: string; root_cause: string; impact: string; recommended_fix: string }>
    quick_wins: Array<{ action: string; effort: string; impact: string }>
  } | null
  agent_trend: Record<string, Array<{ week: string; avg_confidence: number; decisions: number; error_rate_pct: number }>>
  agent_kpi: Record<string, { total_decisions: number; error_rate_pct: number; fix_rate_pct: number }>
  accountant_kpi?: AccountantKpi
  generated_at: string
}

type AbraResult = {
  diff: Array<{ id: number; dodavatel: string; vs: string; sb_stav: string }> | null
  onlySB: Array<{ id: number; dodavatel: string; vs: string }> | null
  onlyABRA: Array<{ kod: string; dodavatel: string }> | null
  stats: { sbTotal: number; abraTotal: number; matched: number; abraBankaTotal?: number }
}

// ── Constants ─────────────────────────────────────────────────────────────────

const YEAR = 2026

const KPI_COLORS: Record<string, string> = {
  accountant: '#3b82f6', auditor: '#8b5cf6', pm: '#10b981', architect: '#f59e0b',
}

type AgentStatus = 'no_data' | 'blocked' | 'at_risk' | 'ok'

const AGENT_STATUS_CFG: Record<AgentStatus, { label: string; bg: string; border: string; dot: string; text: string }> = {
  no_data: { label: 'NO DATA',  bg: 'bg-gray-50',   border: 'border-gray-100',   dot: 'bg-gray-300',  text: 'text-gray-400'   },
  blocked: { label: 'BLOCKED',  bg: 'bg-orange-50',  border: 'border-orange-200', dot: 'bg-orange-400', text: 'text-orange-600' },
  at_risk: { label: 'AT RISK',  bg: 'bg-amber-50',   border: 'border-amber-200',  dot: 'bg-amber-400', text: 'text-amber-700'  },
  ok:      { label: 'OK',       bg: 'bg-green-50',   border: 'border-green-100',  dot: 'bg-green-500', text: 'text-green-700'  },
}

// ── Sparkline ─────────────────────────────────────────────────────────────────

function Sparkline({ pts, color = '#9ca3af', w = 80, h = 28 }: { pts: number[]; color?: string; w?: number; h?: number }) {
  if (pts.length < 2) return <div style={{ width: w, height: h }} className="shrink-0" />
  const pad = 2
  const min = Math.min(...pts), max = Math.max(...pts)
  const range = max - min || 1
  const px = (i: number) => pad + (i / (pts.length - 1)) * (w - pad * 2)
  const py = (v: number) => h - pad - ((v - min) / range) * (h - pad * 2)
  const d = pts.map((v, i) => `${i === 0 ? 'M' : 'L'}${px(i).toFixed(1)},${py(v).toFixed(1)}`).join(' ')
  return (
    <svg width={w} height={h} className="shrink-0 overflow-visible">
      <path d={`${d} L${(w - pad).toFixed(1)},${h} L${pad},${h} Z`} fill={color} fillOpacity="0.12" />
      <path d={d} stroke={color} strokeWidth="1.5" fill="none" strokeLinejoin="round" />
      <circle cx={px(pts.length - 1).toFixed(1)} cy={py(pts[pts.length - 1]).toFixed(1)} r="2" fill={color} />
    </svg>
  )
}

// ── DeltaBadge ────────────────────────────────────────────────────────────────

function DeltaBadge({ label, delta, goodUp }: { label: string; delta: number | null; goodUp: boolean }) {
  if (delta == null) return (
    <div className="flex items-center gap-1">
      <span className="text-[8px] text-gray-300 font-medium w-5">{label}</span>
      <span className="text-[10px] text-gray-300">—</span>
    </div>
  )
  const isGood = goodUp ? delta >= 0 : delta <= 0
  const sign   = delta > 0 ? '+' : ''
  const col    = Math.abs(delta) < 0.5 ? 'text-gray-400' : isGood ? 'text-green-500' : 'text-red-500'
  return (
    <div className="flex items-center gap-1">
      <span className="text-[8px] text-gray-300 font-medium w-5">{label}</span>
      <span className={`text-[10px] font-semibold tabular-nums ${col}`}>{sign}{typeof delta === 'number' && !Number.isInteger(delta) ? delta.toFixed(1) : delta}</span>
    </div>
  )
}

// ── Trend helpers ─────────────────────────────────────────────────────────────

function trendOf(pts: KpiPoint[]): '↑' | '↓' | '→' | '' {
  if (pts.length < 2) return ''
  const last = pts[pts.length - 1].value, prev = pts[pts.length - 2].value
  if (last > prev * 1.02) return '↑'
  if (last < prev * 0.98) return '↓'
  return '→'
}

function trendColor(arrow: string, goodUp: boolean): string {
  if (!arrow || arrow === '→') return 'text-gray-400'
  if (goodUp) return arrow === '↑' ? 'text-green-500' : 'text-red-500'
  return arrow === '↓' ? 'text-green-500' : 'text-red-500'
}

// ── LiveKpiRow ────────────────────────────────────────────────────────────────

function LiveKpiRow({ label, value, trend, pts, color, goodUp = true }: {
  label: string; value: string; trend: string; pts: number[]; color?: string; goodUp?: boolean
}) {
  return (
    <div className="flex items-center gap-3 py-2 border-b border-gray-50 last:border-0">
      <div className="flex-1 min-w-0">
        <div className="text-[10px] text-gray-400">{label}</div>
        <div className="flex items-baseline gap-1 mt-0.5">
          <span className="text-[15px] font-bold text-gray-800 tabular-nums">{value}</span>
          {trend && <span className={`text-[11px] font-medium ${trendColor(trend, goodUp)}`}>{trend}</span>}
        </div>
      </div>
      <Sparkline pts={pts} color={color ?? '#9ca3af'} w={64} h={20} />
    </div>
  )
}

// ── AgentRow ──────────────────────────────────────────────────────────────────

const AGENT_ACCENT: Record<string, string> = {
  accountant: 'border-l-blue-400',
  auditor:    'border-l-violet-400',
  pm:         'border-l-emerald-400',
  architect:  'border-l-amber-400',
}
const AGENT_VALUE_COLOR: Record<string, string> = {
  accountant: 'text-blue-600',
  auditor:    'text-violet-600',
  pm:         'text-emerald-600',
  architect:  'text-amber-600',
}

function kpiColor(val: number | null, thresholds: { ok: number; warn: number }, goodUp = true): string {
  if (val == null) return 'text-gray-400'
  if (goodUp) {
    if (val >= thresholds.ok) return 'text-green-600'
    if (val >= thresholds.warn) return 'text-amber-600'
    return 'text-red-600'
  } else {
    if (val <= thresholds.ok) return 'text-green-600'
    if (val <= thresholds.warn) return 'text-amber-600'
    return 'text-red-600'
  }
}

function kpiBg(val: number | null, thresholds: { ok: number; warn: number }, goodUp = true): string {
  if (val == null) return 'bg-gray-50'
  if (goodUp) {
    if (val >= thresholds.ok) return 'bg-green-50'
    if (val >= thresholds.warn) return 'bg-amber-50'
    return 'bg-red-50'
  } else {
    if (val <= thresholds.ok) return 'bg-green-50'
    if (val <= thresholds.warn) return 'bg-amber-50'
    return 'bg-red-50'
  }
}

function AgentCard({ agentKey, label, kpi, trend, snapshot, series, accountantKpi }: {
  agentKey: string; label: string
  kpi?: { total_decisions: number; error_rate_pct: number; fix_rate_pct: number }
  trend?: Array<{ week: string; avg_confidence: number; decisions: number; error_rate_pct: number }>
  snapshot?: Record<string, unknown>
  series?: Record<string, KpiPoint[]>
  accountantKpi?: AccountantKpi
}) {
  const faktury   = snapshot?.faktury   as Record<string, number> | undefined
  const transakce = snapshot?.transakce as Record<string, number> | undefined
  const pravidla  = snapshot?.pravidla  as Record<string, number> | undefined

  const hasDecisions = (kpi?.total_decisions ?? 0) > 0
  const bezKatCount  = faktury?.bez_kategorie ?? 0
  const novaCount    = faktury?.nova ?? 0
  const nesparCount  = transakce?.nesparovane ?? 0
  const totalFakturyCount = faktury?.total ?? 0

  let status: AgentStatus = 'no_data'
  if (agentKey === 'accountant') {
    if (bezKatCount > 0) status = 'blocked'
    else if (totalFakturyCount > 0) status = hasDecisions && kpi!.error_rate_pct > 10 ? 'at_risk' : 'ok'
  } else if (agentKey === 'auditor') {
    if (hasDecisions) status = kpi!.error_rate_pct > 10 ? 'at_risk' : 'ok'
    else if (totalFakturyCount > 0 && bezKatCount === 0) status = 'ok'
  } else if (agentKey === 'pm') {
    if (nesparCount > 20) status = 'blocked'
    else status = 'ok'
  } else if (agentKey === 'architect') {
    status = hasDecisions ? (kpi!.error_rate_pct > 10 ? 'at_risk' : 'ok') : 'ok'
  }

  const cfg          = AGENT_STATUS_CFG[status]
  const color        = KPI_COLORS[agentKey] ?? '#6b7280'
  const accentBorder = AGENT_ACCENT[agentKey] ?? 'border-l-gray-300'
  const valueColor   = AGENT_VALUE_COLOR[agentKey] ?? 'text-gray-700'

  // ── Primary KPI ───────────────────────────────────────────────────────────
  let primaryLabel = ''
  let primaryValue = '—'
  let primarySub   = ''
  let primarySeriesKey = ''
  let primaryGoodUp = true
  type SecMetric = { label: string; value: string; sub?: string; goodUp?: boolean; thresholds?: { ok: number; warn: number } }
  let secondaryMetrics: SecMetric[] = []

  if (agentKey === 'accountant') {
    const total      = faktury?.total || 1
    const bezKat     = faktury?.bez_kategorie ?? 0
    const classified = Math.round(((total - bezKat) / total) * 100)
    primaryLabel     = 'Klasifikováno'
    primaryValue     = `${classified}%`
    primarySub       = `${total - bezKat} z ${total} faktur`
    primarySeriesKey = 'acc_classification_rate'
    primaryGoodUp    = true
    secondaryMetrics = [] // rendered separately via accountantKpi
  } else if (agentKey === 'auditor') {
    const overdue   = faktury?.overdue ?? 0
    const needsInfo = faktury?.needs_info ?? 0
    primaryLabel     = 'Overdue faktury'
    primaryValue     = String(overdue)
    primarySub       = overdue === 0 ? 'vše v pořádku' : 'překročena splatnost'
    primarySeriesKey = 'aud_fix_rate'
    primaryGoodUp    = false
    secondaryMetrics = [
      { label: 'Čeká na info', value: String(needsInfo),                              goodUp: false, thresholds: { ok: 0, warn: 3 } },
      { label: 'Fix rate',     value: hasDecisions ? `${kpi!.fix_rate_pct}%` : '—',  goodUp: true,  thresholds: { ok: 80, warn: 50 } },
      { label: 'Chybovost',    value: hasDecisions ? `${kpi!.error_rate_pct}%` : '—', goodUp: false, thresholds: { ok: 5, warn: 15 } },
    ]
  } else if (agentKey === 'pm') {
    const nespar  = transakce?.nesparovane ?? 0
    const sparRate = Math.round((transakce?.sparovane ?? 0) / ((transakce?.sparovane ?? 0) + nespar || 1) * 100)
    primaryLabel     = 'Nespárované TX'
    primaryValue     = String(nespar)
    primarySub       = `${sparRate}% spárováno`
    primarySeriesKey = 'pm_unmatched_txn'
    primaryGoodUp    = false
    secondaryMetrics = [
      { label: 'Bez kategorie', value: String(bezKatCount),            goodUp: false, thresholds: { ok: 0, warn: 5 } },
      { label: 'Nové faktury',  value: String(faktury?.nova ?? 0),    goodUp: true  },
      { label: 'Schváleno',     value: String(faktury?.schvalena ?? 0), goodUp: true },
    ]
  } else if (agentKey === 'architect') {
    const totalRules = pravidla?.pravidla_total ?? 0
    const agentRules = pravidla?.agent ?? 0
    primaryLabel     = 'Pravidla celkem'
    primaryValue     = String(totalRules)
    primarySub       = `${agentRules} od agenta`
    primarySeriesKey = 'sys_health_pct'
    primaryGoodUp    = true
    secondaryMetrics = [
      { label: 'Avg confidence', value: pravidla?.avg_confidence != null ? `${pravidla.avg_confidence}%` : '—', goodUp: true, thresholds: { ok: 80, warn: 65 } },
      { label: 'Pending',        value: String(pravidla?.pending_approval ?? 0),                                 goodUp: false, thresholds: { ok: 0, warn: 3 } },
      { label: 'Manuální',       value: String(pravidla?.manual ?? 0) },
    ]
  }

  // Trend — preferuj weekly agent trend (conf), fallback na KPI series
  const weekPts    = (trend ?? []).slice(-8).map(w => w.avg_confidence)
  const primaryPts = (series?.[primarySeriesKey] ?? []).map(p => p.value)
  const displayPts = weekPts.length >= 2 ? weekPts : primaryPts.length >= 2 ? primaryPts : []

  // Week labels pro tooltip-like info
  const weekLabels = (trend ?? []).slice(-8).map(w => w.week)
  const trendArrow = displayPts.length >= 2
    ? displayPts[displayPts.length - 1] > displayPts[displayPts.length - 2] * 1.02 ? '↑'
    : displayPts[displayPts.length - 1] < displayPts[displayPts.length - 2] * 0.98 ? '↓' : '→'
    : ''
  const trendCol = trendArrow === '→' || !trendArrow ? 'text-gray-400'
    : primaryGoodUp ? (trendArrow === '↑' ? 'text-green-500' : 'text-red-500')
    : (trendArrow === '↓' ? 'text-green-500' : 'text-red-500')

  // Delta týden/týden
  const lastW  = displayPts.length > 0 ? displayPts[displayPts.length - 1] : null
  const prevW  = displayPts.length > 1 ? displayPts[displayPts.length - 2] : null
  const prev4W = displayPts.length > 4 ? displayPts[displayPts.length - 5] : null
  const deltaW  = lastW != null && prevW != null  ? Math.round((lastW - prevW) * 10) / 10 : null
  const delta4w = lastW != null && prev4W != null ? Math.round((lastW - prev4W) * 10) / 10 : null

  let statusNote = ''
  if (status === 'blocked') {
    if (agentKey === 'accountant') statusNote = `${bezKatCount} faktur bez kategorie`
    else if (agentKey === 'pm')    statusNote = `${nesparCount} TX nespárováno`
  } else if (status === 'ok') {
    if (agentKey === 'pm' && novaCount > 0) statusNote = `${novaCount} faktur čeká CEO`
    if (agentKey === 'architect') statusNote = 'Monitoring'
  }

  // ── Accountant 5 KPI definitions ─────────────────────────────────────────
  const accKpis = accountantKpi ? [
    { label: 'Accuracy',   value: accountantKpi.accuracy,            thresholds: { ok: 90, warn: 75 }, goodUp: true,  sub: 'bez korekce' },
    { label: 'Auto-rate',  value: accountantKpi.auto_rate,           thresholds: { ok: 80, warn: 60 }, goodUp: true,  sub: 'bez zásahu' },
    { label: 'High-conf',  value: accountantKpi.high_conf_accuracy,  thresholds: { ok: 97, warn: 90 }, goodUp: true,  sub: 'conf ≥90%' },
    { label: 'Opakované',  value: accountantKpi.repeat_error_rate,   thresholds: { ok: 2,  warn: 10 }, goodUp: false, sub: 'stejný dodavatel' },
    { label: 'FB → rule',  value: accountantKpi.feedback_conversion, thresholds: { ok: 60, warn: 30 }, goodUp: true,  sub: 'konverze' },
  ] : []

  return (
    <div className={`bg-white rounded-2xl border border-gray-100 border-l-4 ${accentBorder} p-5`}>

      {/* ── Řádek 1: Agent identita + status + primary KPI ── */}
      <div className="flex items-start justify-between mb-4">
        <div className="flex items-center gap-3">
          <div>
            <div className="text-[13px] font-bold uppercase tracking-widest text-gray-800">{label}</div>
            <div className="flex items-center gap-1.5 mt-1">
              <span className={`w-2 h-2 rounded-full ${cfg.dot}`} />
              <span className={`text-[10px] font-bold uppercase tracking-wide ${cfg.text}`}>{cfg.label}</span>
              {statusNote && (
                <span className={`ml-2 text-[9px] font-medium px-2 py-0.5 rounded-full ${
                  status === 'blocked' ? 'text-orange-700 bg-orange-100' : 'text-gray-500 bg-gray-100'
                }`}>{statusNote}</span>
              )}
            </div>
          </div>
        </div>

        {/* Primary KPI */}
        <div className="text-right">
          <div className="text-[9px] text-gray-400 uppercase tracking-wide">{primaryLabel}</div>
          <div className={`text-[28px] font-black leading-none tabular-nums mt-0.5 ${valueColor}`}>{primaryValue}</div>
          {primarySub && <div className="text-[10px] text-gray-400 mt-0.5">{primarySub}</div>}
        </div>
      </div>

      {/* ── Řádek 2: Sekundární KPIs ── */}
      {agentKey === 'accountant' && accKpis.length > 0 ? (
        <div className="grid grid-cols-5 gap-2 mb-4">
          {accKpis.map((k, i) => {
            const col = kpiColor(k.value, k.thresholds, k.goodUp)
            const bg  = kpiBg(k.value, k.thresholds, k.goodUp)
            return (
              <div key={i} className={`rounded-xl px-3 py-2.5 ${bg}`}>
                <div className="text-[9px] text-gray-500 font-semibold uppercase tracking-wide truncate">{k.label}</div>
                <div className={`text-[18px] font-bold tabular-nums leading-tight mt-0.5 ${col}`}>
                  {k.value != null ? `${k.value}%` : '—'}
                </div>
                <div className="text-[9px] text-gray-400 mt-0.5 truncate">{k.sub}</div>
              </div>
            )
          })}
        </div>
      ) : secondaryMetrics.length > 0 ? (
        <div className="grid grid-cols-3 gap-3 mb-4">
          {secondaryMetrics.map((m, i) => {
            const numVal = m.thresholds ? parseFloat(m.value) : null
            const col = m.thresholds ? kpiColor(isNaN(numVal!) ? null : numVal, m.thresholds, m.goodUp ?? true) : 'text-gray-700'
            const bg  = m.thresholds ? kpiBg(isNaN(numVal!) ? null : numVal, m.thresholds, m.goodUp ?? true) : 'bg-gray-50'
            return (
              <div key={i} className={`rounded-xl px-3 py-2.5 ${bg}`}>
                <div className="text-[9px] text-gray-500 font-semibold uppercase tracking-wide">{m.label}</div>
                <div className={`text-[18px] font-bold tabular-nums leading-tight mt-0.5 ${col}`}>{m.value}</div>
                {m.sub && <div className="text-[9px] text-gray-400 mt-0.5">{m.sub}</div>}
              </div>
            )
          })}
        </div>
      ) : null}

      {/* ── Řádek 3: Trend sparkline + deltas ── */}
      <div className="flex items-end justify-between pt-3 border-t border-gray-50">
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-[9px] text-gray-400 uppercase tracking-wide">Trend (conf, týdně)</span>
            {trendArrow && <span className={`text-[11px] font-bold ${trendCol}`}>{trendArrow}</span>}
            {weekLabels.length > 0 && (
              <span className="text-[9px] text-gray-300">{weekLabels[0]} → {weekLabels[weekLabels.length - 1]}</span>
            )}
          </div>
          {displayPts.length >= 2
            ? <Sparkline pts={displayPts} color={color} w={200} h={36} />
            : <div className="h-9 flex items-center text-[9px] text-gray-300">žádná historická data</div>
          }
        </div>
        <div className="flex gap-4 shrink-0 ml-6">
          <div className="text-right">
            <div className="text-[9px] text-gray-400 uppercase tracking-wide">Δ 1W</div>
            <div className={`text-[14px] font-bold tabular-nums ${
              deltaW == null ? 'text-gray-300'
              : primaryGoodUp ? (deltaW >= 0 ? 'text-green-500' : 'text-red-500')
              : (deltaW <= 0 ? 'text-green-500' : 'text-red-500')
            }`}>{deltaW != null ? (deltaW > 0 ? `+${deltaW}` : String(deltaW)) : '—'}</div>
          </div>
          <div className="text-right">
            <div className="text-[9px] text-gray-400 uppercase tracking-wide">Δ 4W</div>
            <div className={`text-[14px] font-bold tabular-nums ${
              delta4w == null ? 'text-gray-300'
              : primaryGoodUp ? (delta4w >= 0 ? 'text-green-500' : 'text-red-500')
              : (delta4w <= 0 ? 'text-green-500' : 'text-red-500')
            }`}>{delta4w != null ? (delta4w > 0 ? `+${delta4w}` : String(delta4w)) : '—'}</div>
          </div>
        </div>
      </div>

    </div>
  )

}

// ── ScoreBar ──────────────────────────────────────────────────────────────────

function ScoreBar({ label, value }: { label: string; value: number }) {
  const col = value >= 80 ? 'text-green-600' : value >= 60 ? 'text-amber-600' : 'text-red-500'
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-[11px] text-gray-500">{label}</span>
        <span className={`text-[11px] font-semibold tabular-nums ${col}`}>{value}</span>
      </div>
      <div className="h-1 bg-gray-100 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${value >= 80 ? 'bg-green-500' : value >= 60 ? 'bg-amber-400' : 'bg-red-400'}`} style={{ width: `${value}%` }} />
      </div>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export default function ControlTowerPage() {
  const [year, setYear]         = useState(YEAR)
  const [ctData, setCtData]     = useState<CtData | null>(null)
  const [abraData, setAbraData] = useState<AbraResult | null>(null)
  const [loading, setLoading]   = useState(false)
  const [loadingAbra, setLoadingAbra] = useState(false)
  const [kpiHistory, setKpiHistory] = useState<{ series: Record<string, KpiPoint[]> } | null>(null)
  const [orchRunning, setOrchRunning] = useState(false)
  const [orchData, setOrchData] = useState<{
    system_health_pct: number; dry_run: boolean; summary: string
    goals: Array<{ id: string; label: string; target: string; current: unknown; ok: boolean; urgency: string; action: string | null; owner: string }>
    plan: Array<{ order: number; owner: string; task: string; urgency: string; why: string }>
    execution: Array<{ step: number; owner: string; task: string; result: string; ok: boolean }>
    strategic_insight: string | null
  } | null>(null)
  const [showOrch, setShowOrch] = useState(false)
  const [auditRunning, setAuditRunning] = useState(false)
  const [auditResult, setAuditResult] = useState<{ log: Array<{ type: string; text: string }>; summary: string; flagged: number; approved: number } | null>(null)

  const runAudit = async () => {
    if (auditRunning) return
    setAuditRunning(true)
    try {
      const res = await fetch('/api/agent/auditor', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ year }),
      })
      setAuditResult(await res.json())
    } catch { /* silent */ }
    setAuditRunning(false)
  }

  const load = useCallback(async () => {
    setLoading(true)
    try { setCtData(await (await fetch(`/api/agent/control-tower?rok=${year}`)).json()) } catch { /* silent */ }
    setLoading(false)
  }, [year])

  const loadAbra = useCallback(async () => {
    setLoadingAbra(true)
    try { setAbraData(await (await fetch(`/api/abra-reconcile?rok=${year}`)).json()) } catch { /* silent */ }
    setLoadingAbra(false)
  }, [year])

  const loadKpi = useCallback(async () => {
    try {
      // Zapiš dnešní snapshot a pak načti historii
      await fetch('/api/agent/kpi-history', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rok: year }) }).catch(() => {})
      setKpiHistory(await (await fetch('/api/agent/kpi-history')).json())
    } catch { /* silent */ }
  }, [year])

  useEffect(() => { load(); loadAbra(); loadKpi() }, [load, loadAbra, loadKpi])

  const runOrch = async (dryRun = false) => {
    if (orchRunning) return
    setOrchRunning(true)
    try {
      const res = await fetch('/api/agent/strategic-orchestrator', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ year, dry_run: dryRun }),
      })
      setOrchData(await res.json())
    } catch { /* silent */ }
    setOrchRunning(false)
  }

  const abraBad = abraData && ((abraData.diff?.length ?? 0) + (abraData.onlySB?.length ?? 0) + (abraData.onlyABRA?.length ?? 0)) > 0
  const abraOk  = abraData && !abraBad
  const series  = kpiHistory?.series ?? {}

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="sticky top-0 z-10 bg-white border-b border-gray-100 px-6 py-3 flex items-center justify-between">
        <div>
          <div className="text-[15px] font-semibold text-gray-900">Control Tower</div>
          <div className="text-[11px] text-gray-400">Systémový puls · SuperAccount {year}</div>
        </div>
        <div className="flex items-center gap-3">
          <select value={year} onChange={e => setYear(Number(e.target.value))}
            className="text-[12px] border border-gray-200 rounded-lg px-2 py-1 text-gray-700">
            {[2026, 2025].map(y => <option key={y} value={y}>{y}</option>)}
          </select>
          <button onClick={() => { load(); loadAbra(); loadKpi() }} disabled={loading}
            className="text-[11px] px-3 py-1.5 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-40">
            {loading ? 'Analyzuji…' : 'Obnovit'}
          </button>
        </div>
      </div>

      <div className="p-6">
        {loading && <div className="text-center py-16 text-[13px] text-gray-400 animate-pulse">Analyzuji systém…</div>}

        {!loading && !ctData && (
          <div className="text-center py-16">
            <button onClick={load} className="px-5 py-2.5 bg-[#0071e3] text-white rounded-xl text-[13px] font-medium">Spustit analýzu</button>
          </div>
        )}

        {!loading && ctData?.analysis && (() => {
          const { system_health: sh, critical_issues, quick_wins } = ctData.analysis
          const snap      = ctData.snapshot as Record<string, unknown>
          const faktury   = snap?.faktury   as Record<string, number> | undefined
          const transakce = snap?.transakce as Record<string, number> | undefined

          const sysScore  = sh.overall_score
          const sysStatus: AgentStatus = sysScore >= 80 ? 'ok' : sysScore >= 60 ? 'at_risk' : 'blocked'
          const sysStatusCfg = AGENT_STATUS_CFG[sysStatus]
          const sysTrend  = trendOf(series['sys_health_pct'] ?? [])
          const sysPts    = (series['sys_health_pct'] ?? []).map(p => p.value)

          // NaN-safe coverage
          const bezKat    = faktury?.bez_kategorie ?? 0
          const total     = faktury?.total || 1  // || catches 0 and undefined
          const nespar    = transakce?.nesparovane ?? 0
          const needsInfo = faktury?.needs_info ?? 0
          const coveragePct = Math.round(((total - bezKat) / total) * 100)

          const liveKpis = [
            { label: 'Data completeness', value: `${coveragePct}%`,  key: 'pm_coverage_rate',       goodUp: true,  color: '#10b981' },
            { label: 'Unmatched TX',      value: String(nespar),      key: 'pm_unmatched_txn',       goodUp: false, color: nespar > 0 ? '#ef4444' : '#10b981' },
            { label: 'Auto processed',    value: `${coveragePct}%`,  key: 'acc_classification_rate', goodUp: true,  color: '#3b82f6' },
            { label: 'Avg confidence',    value: (() => {
                const confs = Object.values(ctData.agent_kpi ?? {}).filter(k => k.total_decisions > 0)
                return confs.length > 0 ? `${Math.round(confs.reduce((a, k) => a + (100 - k.error_rate_pct), 0) / confs.length)}%` : '—'
              })(), key: 'sys_health_pct', goodUp: true, color: '#8b5cf6' },
          ]

          const critFlags: string[] = [
            ...(nespar > 0 ? [`${nespar} unmatched transactions`] : []),
            ...(bezKat > 0 ? [`${bezKat} faktur bez kategorie`] : []),
            ...(abraBad ? ['ABRA sync — nalezeny rozdíly'] : []),
            ...(needsInfo > 0 ? [`${needsInfo} faktur v NEEDS_INFO`] : []),
          ]

          const urgencyColor = (u: string) => u === 'critical' ? 'bg-red-50 border-red-200 text-red-700' : u === 'high' ? 'bg-orange-50 border-orange-200 text-orange-700' : 'bg-amber-50 border-amber-200 text-amber-700'

          return (
            <div className="space-y-5 max-w-5xl">

              {/* ── BLOCK 1: System Status + Live KPIs ── */}
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">

                {/* System Health */}
                <div className={`rounded-2xl border px-5 py-5 ${sysStatus === 'ok' ? 'bg-green-50 border-green-100' : sysStatus === 'at_risk' ? 'bg-amber-50 border-amber-200' : 'bg-red-50 border-red-200'}`}>
                  <div className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-3">System Health</div>
                  <div className="flex items-end gap-3 mb-2">
                    <div className={`text-[36px] font-bold leading-none tabular-nums ${sysStatus === 'ok' ? 'text-green-700' : sysStatus === 'at_risk' ? 'text-amber-700' : 'text-red-700'}`}>{sysScore}%</div>
                    {sysTrend && <span className={`text-[18px] font-medium pb-1 ${trendColor(sysTrend, true)}`}>{sysTrend}</span>}
                  </div>
                  <div className="flex items-center gap-1.5 mb-3">
                    <span className={`w-2 h-2 rounded-full ${sysStatusCfg.dot}`} />
                    <span className={`text-[11px] font-bold uppercase tracking-wide ${sysStatusCfg.text}`}>{sysStatusCfg.label}</span>
                  </div>
                  {sysPts.length > 1 && <div className="mb-3"><Sparkline pts={sysPts.slice(-10)} color={sysStatus === 'ok' ? '#10b981' : sysStatus === 'at_risk' ? '#f59e0b' : '#ef4444'} w={64} h={20} /></div>}
                  <div className="text-[11px] text-gray-600 leading-snug">{sh.summary}</div>
                </div>

                {/* Live KPIs */}
                <div className="bg-white rounded-2xl border border-gray-100 px-5 py-5">
                  <div className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-2">Live KPI</div>
                  <div className="divide-y divide-gray-50">
                    {liveKpis.map(kpi => {
                      const pts   = (series[kpi.key] ?? []).map(p => p.value)
                      const arrow = trendOf(series[kpi.key] ?? [])
                      return <LiveKpiRow key={kpi.key + kpi.label} label={kpi.label} value={kpi.value} trend={arrow} pts={pts.slice(-8)} color={kpi.color} goodUp={kpi.goodUp} />
                    })}
                  </div>
                </div>

                {/* Sync + Critical Flags */}
                <div className="flex flex-col gap-3">
                  <div className="bg-white rounded-2xl border border-gray-100 px-5 py-4">
                    <div className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-3">Sync Status</div>
                    <div className="space-y-2">
                      {[
                        { name: 'ABRA',  ok: !!abraOk, status: loadingAbra ? 'Loading…' : abraData ? (abraBad ? 'FAILED' : 'OK') : '—', detail: abraOk ? `${abraData!.stats.matched} matched` : abraBad ? `${(abraData?.onlySB?.length ?? 0) + (abraData?.diff?.length ?? 0)} rozdílů` : undefined },
                        { name: 'Gmail', ok: true,     status: 'OK',       detail: undefined },
                        { name: 'Fio',   ok: true,     status: 'OK',       detail: undefined },
                      ].map(s => (
                        <div key={s.name} className="flex items-center gap-2">
                          <span className={`text-[12px] ${s.ok ? 'text-green-500' : 'text-red-500'}`}>{s.ok ? '✓' : '✗'}</span>
                          <span className="text-[11px] font-medium text-gray-700 w-10">{s.name}</span>
                          <span className={`text-[10px] font-semibold ${s.ok ? 'text-green-600' : 'text-red-600'}`}>{s.status}</span>
                          {s.detail && <span className="text-[10px] text-gray-400 ml-auto">{s.detail}</span>}
                        </div>
                      ))}
                    </div>
                  </div>

                  {critFlags.length > 0 ? (
                    <div className="bg-red-50 rounded-2xl border border-red-100 px-5 py-4">
                      <div className="text-[10px] font-bold text-red-400 uppercase tracking-wider mb-2">Critical Flags</div>
                      <div className="space-y-1.5">
                        {critFlags.map((f, i) => (
                          <div key={i} className="flex items-start gap-2 text-[11px] text-red-700">
                            <span className="shrink-0">❗</span><span>{f}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <div className="bg-green-50 rounded-2xl border border-green-100 px-5 py-4 text-[11px] text-green-700">
                      ✓ Žádné kritické problémy
                    </div>
                  )}
                </div>
              </div>

              {/* ── BLOCK 2: Agent Performance ── */}
              <div>
                <div className="text-[11px] font-bold text-gray-400 uppercase tracking-wider mb-3">Agent Performance</div>
                <div className="grid grid-cols-2 gap-3">
                  {(['accountant', 'auditor', 'pm', 'architect'] as const).map(key => (
                    <AgentCard key={key} agentKey={key} label={key.toUpperCase()}
                      kpi={ctData.agent_kpi?.[key]} trend={ctData.agent_trend?.[key]}
                      snapshot={snap} series={series}
                      accountantKpi={key === 'accountant' ? ctData.accountant_kpi : undefined} />
                  ))}
                </div>
              </div>

              {/* ── BLOCK 3: Integrations ── */}
              <div className="bg-white rounded-2xl border border-gray-100 px-5 py-4">
                <div className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-3">Integrations</div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                  {[
                    { name: 'ABRA Flexi',  ok: !!abraOk, detail: abraOk ? `${abraData!.stats.abraTotal} FP, ${abraData!.stats.abraBankaTotal ?? 0} banka` : abraBad ? `${abraData?.onlySB?.length ?? 0} chybí v ABRA` : '—', lastSync: abraBad ? '⚠ rozdíly' : 'OK' },
                    { name: 'Supabase',    ok: true,      detail: `${faktury?.total ?? 0} faktur, ${transakce?.total ?? 0} TX`, lastSync: 'Live' },
                    { name: 'Fio banka',   ok: true,      detail: `${nespar} nesparováno`, lastSync: 'OK' },
                    { name: 'Gmail/Drive', ok: true,      detail: `${faktury?.total ?? 0} importováno`, lastSync: 'OK' },
                  ].map(s => (
                    <div key={s.name}>
                      <div className="flex items-center gap-1.5 mb-1">
                        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${s.ok ? 'bg-green-500' : 'bg-red-500'}`} />
                        <span className="text-[11px] font-semibold text-gray-700">{s.name}</span>
                      </div>
                      <div className={`text-[10px] font-medium ${s.ok ? 'text-green-600' : 'text-red-600'}`}>{s.lastSync}</div>
                      <div className="text-[10px] text-gray-400 mt-0.5">{s.detail}</div>
                    </div>
                  ))}
                </div>
              </div>

              {/* ── BLOCK 4: Critical Issues + Next Actions ── */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                <div className="bg-white rounded-2xl border border-gray-100 px-5 py-5">
                  <div className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-3">Critical Issues</div>
                  {critical_issues?.length > 0 ? (
                    <div className="space-y-2">
                      {critical_issues.slice(0, 5).map((issue, i) => (
                        <div key={i} className={`rounded-xl border px-3 py-2.5 ${issue.severity === 'critical' ? 'bg-red-50 border-red-200' : issue.severity === 'high' ? 'bg-orange-50 border-orange-200' : 'bg-amber-50 border-amber-200'}`}>
                          <div className="flex items-center gap-2 mb-0.5">
                            <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded ${issue.severity === 'critical' ? 'bg-red-100 text-red-700' : 'bg-orange-100 text-orange-700'}`}>{issue.severity}</span>
                            <span className="text-[10px] font-bold text-gray-500 uppercase">{issue.owner_agent}</span>
                          </div>
                          <div className="text-[12px] font-medium text-gray-800">{issue.title}</div>
                          <div className="text-[10px] text-blue-600 mt-1">→ {issue.recommended_fix}</div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-[12px] text-green-600 bg-green-50 rounded-xl px-3 py-3">Žádné kritické problémy</div>
                  )}
                </div>

                <div className="bg-white rounded-2xl border border-gray-100 px-5 py-5">
                  <div className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-3">Next Actions</div>
                  {quick_wins?.length > 0 ? (
                    <div className="space-y-1.5">
                      {quick_wins.slice(0, 6).map((w, i) => (
                        <div key={i} className="flex items-start gap-2.5 py-1.5 border-b border-gray-50 last:border-0">
                          <span className="text-[11px] font-bold text-gray-300 shrink-0 mt-0.5">{i + 1}.</span>
                          <div className="flex-1 min-w-0">
                            <div className="text-[12px] text-gray-700">{w.action}</div>
                            <div className="text-[10px] text-gray-400 mt-0.5">{w.impact}</div>
                          </div>
                          <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded shrink-0 ${w.effort === 'low' ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-700'}`}>{w.effort}</span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-[12px] text-gray-400 py-4">Spusť orchestrátor pro doporučení kroků.</div>
                  )}
                </div>
              </div>

              {/* ── BLOCK 5: Health Breakdown ── */}
              <div className="bg-white rounded-2xl border border-gray-100 px-5 py-5">
                <div className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-4">Health Breakdown</div>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-x-8 gap-y-3">
                  <ScoreBar label="Účetnictví"    value={sh.accounting_quality} />
                  <ScoreBar label="Audit"         value={sh.audit_quality} />
                  <ScoreBar label="Workflow"      value={sh.workflow_quality} />
                  <ScoreBar label="Data"          value={sh.data_quality} />
                  <ScoreBar label="Architektura"  value={sh.architecture_quality} />
                  <ScoreBar label="Learning"      value={sh.learning_quality} />
                </div>
              </div>

              {/* ── BLOCK 6: Audit ── */}
              <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
                <div className="px-5 py-4 flex items-center justify-between border-b border-gray-50">
                  <div>
                    <div className="text-[13px] font-semibold text-gray-900">Auditor</div>
                    <div className="text-[11px] text-gray-400 mt-0.5">Kontrola rozhodnutí · nízká confidence · sweep</div>
                  </div>
                  <button onClick={runAudit} disabled={auditRunning}
                    className="text-[11px] px-4 py-1.5 rounded-lg bg-purple-600 hover:bg-purple-700 text-white font-medium disabled:opacity-40">
                    {auditRunning ? 'Audituji…' : 'Spustit audit'}
                  </button>
                </div>

                {auditResult && (
                  <div className="px-5 py-4 space-y-3">
                    <div className="grid grid-cols-2 gap-3">
                      <div className="rounded-xl bg-gray-50 px-4 py-3 text-center">
                        <div className={`text-[24px] font-bold ${auditResult.approved > 0 ? 'text-green-600' : 'text-gray-400'}`}>{auditResult.approved}</div>
                        <div className="text-[10px] text-gray-500 mt-0.5">schváleno → AUDIT_CHECKED</div>
                      </div>
                      <div className="rounded-xl bg-gray-50 px-4 py-3 text-center">
                        <div className={`text-[24px] font-bold ${auditResult.flagged > 0 ? 'text-red-600' : 'text-gray-400'}`}>{auditResult.flagged}</div>
                        <div className="text-[10px] text-gray-500 mt-0.5">označeno / vráceno</div>
                      </div>
                    </div>
                    <div className="space-y-0.5 max-h-40 overflow-y-auto">
                      {auditResult.log.map((l, i) => (
                        <div key={i} className={`flex items-start gap-2 text-[11px] px-3 py-1 rounded-lg ${l.type === 'warn' ? 'bg-orange-50 text-orange-700' : l.type === 'action' ? 'bg-green-50 text-green-700' : 'text-gray-400'}`}>
                          <span className="shrink-0 font-bold">{l.type === 'warn' ? '⚠' : l.type === 'action' ? '✓' : '·'}</span>
                          <span>{l.text}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {!auditRunning && !auditResult && (
                  <div className="px-5 py-6 text-center text-[12px] text-gray-400">
                    Spusť audit pro kontrolu rozhodnutí agentů.
                  </div>
                )}
                {auditRunning && <div className="px-5 py-6 text-center text-[12px] text-gray-400 animate-pulse">Audituji…</div>}
              </div>

              {/* ── ORCHESTRÁTOR (collapsible) ── */}
              <div className="bg-gray-900 rounded-2xl overflow-hidden">
                <div onClick={() => setShowOrch(v => !v)} role="button"
                  className="w-full px-5 py-4 flex items-center justify-between text-left cursor-pointer">
                  <div>
                    <div className="text-[13px] font-semibold text-white">Strategic Orchestrator</div>
                    <div className="text-[11px] text-gray-400 mt-0.5">Vyhodnotí cíle a spustí agenty</div>
                  </div>
                  <div className="flex gap-2 shrink-0">
                    <button onClick={e => { e.stopPropagation(); runOrch(true) }} disabled={orchRunning}
                      className="text-[11px] px-3 py-1.5 rounded-lg border border-gray-600 text-gray-300 hover:bg-gray-800 disabled:opacity-40">
                      {orchRunning ? '…' : 'Dry run'}
                    </button>
                    <button onClick={e => { e.stopPropagation(); runOrch(false) }} disabled={orchRunning}
                      className="text-[11px] px-4 py-1.5 rounded-lg bg-[#0071e3] text-white font-medium disabled:opacity-40">
                      {orchRunning ? 'Běží…' : 'Spustit'}
                    </button>
                  </div>
                </div>

                {showOrch && orchData && !orchRunning && (
                  <div className="px-5 pb-5 space-y-3">
                    <div className="flex items-center gap-3">
                      <div className={`text-[28px] font-bold leading-none ${orchData.system_health_pct >= 80 ? 'text-green-400' : orchData.system_health_pct >= 50 ? 'text-amber-400' : 'text-red-400'}`}>{orchData.system_health_pct}%</div>
                      <div className="text-[11px] text-gray-300">{orchData.summary}</div>
                      {orchData.dry_run && <span className="ml-auto text-[10px] px-2 py-0.5 rounded-full bg-gray-700 text-gray-400">DRY RUN</span>}
                    </div>

                    {orchData.strategic_insight && (
                      <div className="bg-amber-950/40 border border-amber-700/50 rounded-xl px-4 py-3 text-[12px] text-amber-200">{orchData.strategic_insight}</div>
                    )}

                    <div className="space-y-1.5">
                      {orchData.goals.map(g => (
                        <div key={g.id} className={`flex items-center gap-3 rounded-xl px-3 py-2 ${g.ok ? 'bg-green-950/40 border border-green-800/30' : 'bg-gray-800/60 border border-gray-700'}`}>
                          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${g.ok ? 'bg-green-500' : g.urgency === 'critical' ? 'bg-red-500' : g.urgency === 'high' ? 'bg-orange-500' : 'bg-amber-400'}`} />
                          <span className="flex-1 text-[12px] text-gray-200">{g.label}</span>
                          <span className="text-[10px] text-gray-400">{String(g.current)} → {g.target}</span>
                          {g.ok && <span className="text-green-500">✓</span>}
                        </div>
                      ))}
                    </div>

                    {orchData.plan.length > 0 && (
                      <div className="space-y-1.5">
                        {orchData.plan.map(step => {
                          const exec = orchData.execution.find(e => e.step === step.order)
                          return (
                            <div key={step.order} className="flex items-start gap-3 bg-gray-800/60 rounded-xl px-4 py-3">
                              <span className="text-[10px] font-bold text-gray-500 w-4 shrink-0 mt-0.5">{step.order}.</span>
                              <div className="flex-1 min-w-0">
                                <div className="text-[12px] text-gray-200">{step.task}</div>
                                <div className="text-[10px] text-gray-500 mt-0.5">{step.why}</div>
                              </div>
                              <div className="shrink-0 text-right">
                                <span className="text-[9px] text-gray-500 uppercase">{step.owner}</span>
                                {exec && <div className={`text-[10px] mt-0.5 ${exec.ok ? 'text-green-400' : 'text-red-400'}`}>{exec.ok ? '✓' : '✗'} {exec.result}</div>}
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                )}

                {orchRunning && <div className="px-5 pb-5 text-center text-[12px] text-gray-400 animate-pulse">Analyzuji systém…</div>}
              </div>

            </div>
          )
        })()}
      </div>
    </div>
  )
}
