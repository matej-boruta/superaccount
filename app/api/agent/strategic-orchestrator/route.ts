/**
 * POST /api/agent/strategic-orchestrator
 *
 * Strategic Orchestrator — systémová inteligence SuperAccount.
 *
 * Odpovídá na otázku: "Co má systém dělat TEĎ, aby se dostal k autonomii?"
 *
 * Neřeší jednotlivé faktury. Řídí agenty jako celek:
 * 1. Změří stav systému (SB = zdroj pravdy)
 * 2. Vyhodnotí odchylku od cíle (autonomie + zákonná shoda)
 * 3. Sestaví plán: které agenty spustit, v jakém pořadí, s jakým zadáním
 * 4. Spustí je přes dispatcher
 * 5. Ověří výsledek a zaloguje
 *
 * Body: { year?: number, dry_run?: boolean }
 * Returns: { goals, state, plan, execution, summary }
 */

import { NextResponse } from 'next/server'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY!
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY!
const BASE = process.env.NEXTAUTH_URL ?? (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000')

const SB = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }

async function sbGet(path: string) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: SB })
  const d = await r.json()
  return Array.isArray(d) ? d : []
}

// ── Systémový stav — všechny KPI na jednom místě ─────────────────────────────

async function getSystemState(year: number) {
  const [faktury, transakce, agentLog, pravidla] = await Promise.all([
    sbGet(`faktury?datum_vystaveni=gte.${year}-01-01&datum_vystaveni=lte.${year}-12-31&select=id,stav,stav_workflow,kategorie_id,castka_s_dph,blocker,datum_splatnosti`),
    sbGet(`transakce?datum=gte.${year}-01-01&datum=lte.${year}-12-31&select=id,stav,castka`),
    sbGet(`agent_log?created_at=gte.${year}-01-01&select=typ,rezim,confidence,feedback_type,zmena_stavu&order=created_at.desc&limit=500`),
    sbGet(`ucetni_pravidla?select=id,confidence,zdroj,aktivni`),
  ])

  const today = new Date().toISOString().split('T')[0]

  const nova = faktury.filter((f: Record<string, unknown>) => f.stav === 'nova')
  const schvalena = faktury.filter((f: Record<string, unknown>) => f.stav === 'schvalena')
  const zaplacena = faktury.filter((f: Record<string, unknown>) => f.stav === 'zaplacena')
  const bezKategorie = nova.filter((f: Record<string, unknown>) => !f.kategorie_id)
  const needsInfo = faktury.filter((f: Record<string, unknown>) => f.stav_workflow === 'NEEDS_INFO')
  const overdue = faktury.filter((f: Record<string, unknown>) =>
    (f.stav === 'nova' || f.stav === 'schvalena') && f.datum_splatnosti && String(f.datum_splatnosti) < today
  )
  const nesparovane = transakce.filter((t: Record<string, unknown>) => t.stav === 'nesparovano' && Number(t.castka) < 0)
  const sparovane = transakce.filter((t: Record<string, unknown>) => t.stav === 'sparovano')

  const korekce = agentLog.filter((l: Record<string, unknown>) => l.typ === 'korekce').length
  const rozhodnuti = agentLog.filter((l: Record<string, unknown>) => l.typ === 'rozhodnuti').length
  const highConf = agentLog.filter((l: Record<string, unknown>) => Number(l.confidence ?? 0) >= 85).length
  const lowConf = agentLog.filter((l: Record<string, unknown>) => Number(l.confidence ?? 0) < 60 && Number(l.confidence ?? 0) > 0).length

  return {
    year,
    faktury: {
      total: faktury.length,
      nova: nova.length,
      schvalena: schvalena.length,
      zaplacena: zaplacena.length,
      bez_kategorie: bezKategorie.length,
      needs_info: needsInfo.length,
      overdue: overdue.length,
    },
    transakce: {
      sparovane: sparovane.length,
      nesparovane: nesparovane.length,
      parovani_pct: Math.round(sparovane.length / (sparovane.length + nesparovane.length || 1) * 100),
    },
    agenti: {
      rozhodnuti,
      korekce,
      high_conf: highConf,
      low_conf: lowConf,
      chybovost_pct: rozhodnuti > 0 ? Math.round(korekce / rozhodnuti * 100) : 0,
    },
    pravidla: {
      total: pravidla.length,
      aktivni: pravidla.filter((p: Record<string, unknown>) => p.aktivni).length,
    },
  }
}

// ── Cíle systému — deterministické, ne AI ────────────────────────────────────

function evaluateGoals(state: Awaited<ReturnType<typeof getSystemState>>) {
  return [
    {
      id: 'klasifikace',
      label: 'Klasifikace faktur',
      target: 'bez_kategorie = 0',
      current: state.faktury.bez_kategorie,
      ok: state.faktury.bez_kategorie === 0,
      urgency: state.faktury.bez_kategorie > 10 ? 'critical' : state.faktury.bez_kategorie > 0 ? 'high' : 'ok',
      owner: 'accountant',
      action: state.faktury.bez_kategorie > 0
        ? `Klasifikovat ${state.faktury.bez_kategorie} faktur bez kategorie`
        : null,
    },
    {
      id: 'eskalace',
      label: 'Odblokovány eskalace',
      target: 'needs_info = 0',
      current: state.faktury.needs_info,
      ok: state.faktury.needs_info === 0,
      urgency: state.faktury.needs_info > 5 ? 'critical' : state.faktury.needs_info > 0 ? 'high' : 'ok',
      owner: 'pm',
      action: state.faktury.needs_info > 0
        ? `Vyřešit ${state.faktury.needs_info} eskalací NEEDS_INFO`
        : null,
    },
    {
      id: 'splatnost',
      label: 'Žádné faktury po splatnosti',
      target: 'overdue = 0',
      current: state.faktury.overdue,
      ok: state.faktury.overdue === 0,
      urgency: state.faktury.overdue > 0 ? 'critical' : 'ok',
      owner: 'pm',
      action: state.faktury.overdue > 0
        ? `Urgentně zpracovat ${state.faktury.overdue} faktur po splatnosti`
        : null,
    },
    {
      id: 'parovani',
      label: 'Párování transakcí',
      target: 'parovani_pct ≥ 90%',
      current: `${state.transakce.parovani_pct}%`,
      ok: state.transakce.parovani_pct >= 90,
      urgency: state.transakce.parovani_pct < 70 ? 'high' : state.transakce.parovani_pct < 90 ? 'medium' : 'ok',
      owner: 'pm',
      action: state.transakce.parovani_pct < 90
        ? `Spárovat ${state.transakce.nesparovane} nesparovaných transakcí`
        : null,
    },
    {
      id: 'audit',
      label: 'Audit trail bez korekcí',
      target: 'chybovost < 5%',
      current: `${state.agenti.chybovost_pct}%`,
      ok: state.agenti.chybovost_pct < 5,
      urgency: state.agenti.chybovost_pct > 15 ? 'high' : state.agenti.chybovost_pct > 5 ? 'medium' : 'ok',
      owner: 'auditor',
      action: state.agenti.low_conf > 0
        ? `Auditovat ${state.agenti.low_conf} rozhodnutí s nízkou confidence`
        : null,
    },
  ]
}

// ── Sestavení plánu — deterministické priority ────────────────────────────────

function buildPlan(goals: ReturnType<typeof evaluateGoals>, state: Awaited<ReturnType<typeof getSystemState>>) {
  const steps: Array<{ order: number; owner: string; task: string; urgency: string; why: string }> = []

  // Seřadit cíle dle urgency: critical > high > medium
  const urgencyOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, ok: 3 }
  const pending = goals
    .filter(g => g.action && !g.ok)
    .sort((a, b) => (urgencyOrder[a.urgency] ?? 3) - (urgencyOrder[b.urgency] ?? 3))

  pending.forEach((g, i) => {
    steps.push({
      order: i + 1,
      owner: g.owner,
      task: g.action!,
      urgency: g.urgency,
      why: `Cíl "${g.label}": aktuální stav ${g.current}, cíl ${g.target}`,
    })
  })

  // Vždy přidat audit na konec pokud přeskočil
  if (!steps.find(s => s.owner === 'auditor') && state.faktury.nova > 0) {
    steps.push({
      order: steps.length + 1,
      owner: 'auditor',
      task: 'Auditovat nová rozhodnutí ACCOUNTANTA a posunout schválené do AUDIT_CHECKED',
      urgency: 'medium',
      why: 'Preventivní audit — ověřit kvalitu klasifikací',
    })
  }

  return steps
}

// ── Spuštění plánu přes dispatcher ───────────────────────────────────────────

async function executePlan(
  steps: ReturnType<typeof buildPlan>,
  year: number,
  dryRun: boolean
): Promise<Array<{ step: number; owner: string; task: string; result: string; ok: boolean }>> {
  const results = []

  for (const step of steps) {
    if (dryRun) {
      results.push({ step: step.order, owner: step.owner, task: step.task, result: '[dry run] nespuštěno', ok: true })
      continue
    }

    try {
      const res = await fetch(`${BASE}/api/agent/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ owner_agent: step.owner, task: step.task, type: 'data_fix', year }),
      })
      const data = await res.json()
      const verdict = data.verification?.verdict ?? data.summary ?? 'Hotovo'
      results.push({ step: step.order, owner: step.owner, task: step.task, result: verdict, ok: data.ok !== false })
    } catch (e) {
      results.push({ step: step.order, owner: step.owner, task: step.task, result: `Chyba: ${String(e)}`, ok: false })
    }
  }

  return results
}

// ── Claude strategická analýza — pouze pokud je potřeba ──────────────────────

async function getStrategicInsight(state: Awaited<ReturnType<typeof getSystemState>>, goals: ReturnType<typeof evaluateGoals>) {
  const criticalGoals = goals.filter(g => g.urgency === 'critical').map(g => g.label)
  if (criticalGoals.length === 0 && state.agenti.chybovost_pct < 5) return null // systém zdravý, nepotřebuje AI insight

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 600,
        messages: [{
          role: 'user',
          content: `Jsi Strategic Orchestrator účetního systému. Supabase je zdroj pravdy, ABRA je zákonný výstup.

Kritické problémy: ${criticalGoals.join(', ') || 'žádné'}
Stav: ${JSON.stringify({ faktury: state.faktury, agenti: state.agenti })}

Napiš max 3 věty: co je nejvýznamnější systémový problém a proč. Buď konkrétní, ne obecný. Odpověz česky, bez markdown.`,
        }],
      }),
    })
    const d = await res.json()
    return d?.content?.[0]?.text?.trim() ?? null
  } catch {
    return null
  }
}

// ── Handler ───────────────────────────────────────────────────────────────────

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}))
  const year: number = body.year ?? new Date().getFullYear()
  const dryRun: boolean = body.dry_run ?? false

  const state = await getSystemState(year)
  const goals = evaluateGoals(state)
  const plan = buildPlan(goals, state)
  const [execution, strategicInsight] = await Promise.all([
    executePlan(plan, year, dryRun),
    getStrategicInsight(state, goals),
  ])

  const goalsOk = goals.filter(g => g.ok).length
  const goalsFailed = goals.filter(g => !g.ok).length
  const systemHealthPct = Math.round(goalsOk / goals.length * 100)

  // Log do agent_log
  await fetch(`${SUPABASE_URL}/rest/v1/agent_log`, {
    method: 'POST',
    headers: { ...SB, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({
      typ: goalsFailed > 0 ? 'eskalace' : 'rozhodnuti',
      rezim: 'ARCHITECT',
      confidence: systemHealthPct,
      pravidlo_zdroj: 'strategic_orchestrator',
      vstup: { goals: goals.map(g => ({ id: g.id, ok: g.ok, urgency: g.urgency })), state: { faktury: state.faktury } },
      vystup: { plan_steps: plan.length, executed: execution.length, dry_run: dryRun, system_health_pct: systemHealthPct },
      zmena_stavu: dryRun ? 'STRATEGIC_DRY_RUN' : 'STRATEGIC_EXECUTED',
    }),
  }).catch(() => {})

  return NextResponse.json({
    year,
    dry_run: dryRun,
    state,
    goals,
    plan,
    execution,
    system_health_pct: systemHealthPct,
    strategic_insight: strategicInsight,
    summary: dryRun
      ? `Plán: ${plan.length} kroků (dry run). ${goalsFailed} cílů nesplněno.`
      : `Spuštěno ${execution.length} kroků. ${execution.filter(e => e.ok).length} úspěšných. Zdraví systému: ${systemHealthPct}%.`,
    generated_at: new Date().toISOString(),
  })
}
