/**
 * GET /api/agent/control-tower?rok=2026
 *
 * Agent Control Tower — systémová analýza zdraví SuperAccount.
 * Fetchuje real metriky z Supabase, analyzuje přes Claude ARCHITECT,
 * vrací strukturovaný dashboard + orchestrator tasking.
 */

import { NextResponse } from 'next/server'
import { SYSTEM_ARCHITECT } from '@/lib/claude'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY!
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY!
const SB = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }

async function sb(path: string) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: SB })
  const data = await res.json()
  return Array.isArray(data) ? data : []
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const rok = searchParams.get('rok') ?? String(new Date().getFullYear())
  const rokFilter = `datum_vystaveni=gte.${rok}-01-01&datum_vystaveni=lte.${rok}-12-31`

  // ── 1. Paralelní snapshot dat ─────────────────────────────────────────────
  const [faktury, transakce, agentLog, pravidla, pravidlaUcetni, agentLogWeekly, agentKorekce] = await Promise.all([
    sb(`faktury?${rokFilter}&select=id,stav,stav_workflow,kategorie_id,castka_s_dph,variabilni_symbol,blocker,datum_splatnosti,dodavatel`),
    sb(`transakce?datum=gte.${rok}-01-01&datum=lte.${rok}-12-31&select=id,stav,castka`),
    sb(`agent_log?created_at=gte.${rok}-01-01&select=id,typ,rezim,confidence,source_of_rule,zmena_stavu,feedback_type,created_at&order=created_at.desc&limit=200`),
    sb(`dodavatel_pravidla?select=id,auto_schvalit,auto_parovat,kategorie_id`),
    sb(`ucetni_pravidla?select=id,confidence,zdroj,kategorie_id`),
    // Trend data: agent_log posledních 90 dní s datem pro týdenní agregaci
    sb(`agent_log?created_at=gte.${rok}-01-01&select=confidence,rezim,zmena_stavu,created_at&order=created_at.asc&limit=1000`),
    // Korekce a eskalace — chyby agentů pro CT dashboard
    sb(`agent_log?typ=in.(korekce,eskalace)&select=id,typ,rezim,confidence,feedback_type,vstup,vystup,created_at,faktura_id&order=created_at.desc&limit=30`),
  ])

  // ── 2. Výpočet metrik ────────────────────────────────────────────────────
  const today = new Date().toISOString().split('T')[0]

  const nova = faktury.filter((f: Record<string, unknown>) => f.stav === 'nova')
  const schvalena = faktury.filter((f: Record<string, unknown>) => f.stav === 'schvalena')
  const zaplacena = faktury.filter((f: Record<string, unknown>) => f.stav === 'zaplacena')
  const zamitnuta = faktury.filter((f: Record<string, unknown>) => f.stav === 'zamitnuta')

  const needsInfo = faktury.filter((f: Record<string, unknown>) => f.stav_workflow === 'NEEDS_INFO')
  const withWorkflow = faktury.filter((f: Record<string, unknown>) => f.stav_workflow && f.stav_workflow !== 'NEW')
  const withKategorie = faktury.filter((f: Record<string, unknown>) => f.kategorie_id)
  const withoutKategorie = nova.filter((f: Record<string, unknown>) => !f.kategorie_id)
  const overdueFaktury = faktury.filter((f: Record<string, unknown>) =>
    (f.stav === 'nova' || f.stav === 'schvalena') && f.datum_splatnosti && String(f.datum_splatnosti) < today
  )

  const nesparovane = transakce.filter((t: Record<string, unknown>) => t.stav === 'nesparovano' && Number(t.castka) < 0)
  const sparovane = transakce.filter((t: Record<string, unknown>) => t.stav === 'sparovano')

  const logByRezim = agentLog.reduce((acc: Record<string, number>, l: Record<string, unknown>) => {
    const r = String(l.rezim ?? 'unknown')
    acc[r] = (acc[r] ?? 0) + 1
    return acc
  }, {})

  const logWithConfidence = agentLog.filter((l: Record<string, unknown>) => l.confidence != null)
  const avgConfidence = logWithConfidence.length
    ? Math.round(logWithConfidence.reduce((s: number, l: Record<string, unknown>) => s + Number(l.confidence), 0) / logWithConfidence.length)
    : 0

  const highConfLogs = logWithConfidence.filter((l: Record<string, unknown>) => Number(l.confidence) >= 85).length
  const lowConfLogs = logWithConfidence.filter((l: Record<string, unknown>) => Number(l.confidence) < 60).length
  const midConfLogs = logWithConfidence.filter((l: Record<string, unknown>) => Number(l.confidence) >= 60 && Number(l.confidence) < 85).length

  const feedbackTypes = agentLog.reduce((acc: Record<string, number>, l: Record<string, unknown>) => {
    if (l.feedback_type) {
      const ft = String(l.feedback_type)
      acc[ft] = (acc[ft] ?? 0) + 1
    }
    return acc
  }, {})

  const manualPravidla = pravidlaUcetni.filter((p: Record<string, unknown>) => p.zdroj === 'manual').length
  const agentPravidla = pravidlaUcetni.filter((p: Record<string, unknown>) => p.zdroj === 'agent').length
  const pendingPravidla = pravidlaUcetni.filter((p: Record<string, unknown>) => p.zdroj === 'rule_proposal_pending').length
  const avgPravidloConf = pravidlaUcetni.length
    ? Math.round(pravidlaUcetni.reduce((s: number, p: Record<string, unknown>) => s + Number(p.confidence ?? 0), 0) / pravidlaUcetni.length)
    : 0

  // ── 3. Skóre (0–100) ─────────────────────────────────────────────────────
  const totalFaktury = faktury.length || 1

  const accountingQuality = Math.min(100, Math.round(
    (withKategorie.length / totalFaktury) * 50 +
    (avgConfidence / 100) * 30 +
    ((nova.length - withoutKategorie.length) / (nova.length || 1)) * 20
  ))

  const auditQuality = Math.min(100, Math.round(
    (highConfLogs / (logWithConfidence.length || 1)) * 60 +
    (agentLog.filter((l: Record<string, unknown>) => l.zmena_stavu?.toString().includes('AUDIT')).length > 0 ? 40 : 10)
  ))

  const workflowQuality = Math.min(100, Math.round(
    (withWorkflow.length / totalFaktury) * 40 +
    (needsInfo.length === 0 ? 30 : Math.max(0, 30 - needsInfo.length * 5)) +
    (overdueFaktury.length === 0 ? 30 : Math.max(0, 30 - overdueFaktury.length * 3))
  ))

  const dataQuality = Math.min(100, Math.round(
    ((totalFaktury - withoutKategorie.length) / totalFaktury) * 40 +
    (withWorkflow.length / totalFaktury) * 30 +
    (sparovane.length / (sparovane.length + nesparovane.length || 1)) * 30
  ))

  const architectureQuality = Math.min(100, Math.round(
    (withWorkflow.length > 0 ? 40 : 0) +
    (agentLog.filter((l: Record<string, unknown>) => l.source_of_rule).length / (agentLog.length || 1)) * 30 +
    (agentLog.filter((l: Record<string, unknown>) => l.feedback_type).length > 0 ? 30 : 10)
  ))

  const learningQuality = Math.min(100, Math.round(
    (manualPravidla > 0 ? 30 : 0) +
    (Object.keys(feedbackTypes).length >= 2 ? 30 : 10) +
    (avgPravidloConf / 100) * 20 +
    (pendingPravidla === 0 ? 20 : Math.max(0, 20 - pendingPravidla * 5))
  ))

  const overallScore = Math.round(
    (accountingQuality * 0.2) + (auditQuality * 0.15) + (workflowQuality * 0.2) +
    (dataQuality * 0.2) + (architectureQuality * 0.15) + (learningQuality * 0.1)
  )

  // ── 4. Trend data — týdenní agregace confidence z agent_log ─────────────
  type WeekBucket = { week: string; avg_confidence: number; count: number; high: number; low: number }
  const weekBuckets = new Map<string, { sum: number; count: number; high: number; low: number }>()

  for (const l of Array.isArray(agentLogWeekly) ? agentLogWeekly : []) {
    if (!l.created_at || l.confidence == null) continue
    const d = new Date(l.created_at)
    // ISO week key: YYYY-Www
    const startOfYear = new Date(d.getFullYear(), 0, 1)
    const weekNum = Math.ceil(((d.getTime() - startOfYear.getTime()) / 86400000 + startOfYear.getDay() + 1) / 7)
    const key = `${d.getFullYear()}-W${String(weekNum).padStart(2, '0')}`
    const prev = weekBuckets.get(key) ?? { sum: 0, count: 0, high: 0, low: 0 }
    prev.sum += Number(l.confidence)
    prev.count++
    if (Number(l.confidence) >= 85) prev.high++
    if (Number(l.confidence) < 60) prev.low++
    weekBuckets.set(key, prev)
  }

  const weeklyTrend: WeekBucket[] = [...weekBuckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-12) // posledních 12 týdnů
    .map(([week, v]) => ({
      week,
      avg_confidence: Math.round(v.sum / v.count),
      count: v.count,
      high: v.high,
      low: v.low,
    }))

  // ── Per-agent KPI — chybovost, opravovost, false negatives ──────────────
  // Semantika agent_log.typ:
  //   typ='korekce', rezim='ACCOUNTANT' → ACC udělal chybu (AUDITOR ji vrátil)
  //   typ='korekce', rezim='AUDITOR'    → AUDITOR propustil chybu (false negative)
  //   typ='rozhodnuti', rezim='ACCOUNTANT', zmena_stavu='CORRECTED' → ACC chybu opravil
  //   typ='rozhodnuti', rezim='AUDITOR'  → AUDITOR schválil (normální průchod)

  const REZIM_LIST = ['ACCOUNTANT', 'AUDITOR', 'PM', 'ARCHITECT'] as const

  type AgentTrendBucket = {
    week: string
    avg_confidence: number
    decisions: number            // celkem rozhodnutí
    acc_errors: number           // chyby ACC (vráceno AUDITOREM)
    auditor_false_neg: number    // chyby AUDITORA (propustil chybu)
    fixed: number                // ACC opravil flagovanou chybu
    error_rate_pct: number       // chybovost v %
  }

  const agentWeekBuckets: Record<string, Map<string, {
    sumConf: number; decisions: number; acc_errors: number; auditor_false_neg: number; fixed: number
  }>> = {}
  for (const r of REZIM_LIST) agentWeekBuckets[r] = new Map()

  function weekKey(dateStr: string): string {
    const d = new Date(dateStr)
    const startOfYear = new Date(d.getFullYear(), 0, 1)
    const weekNum = Math.ceil(((d.getTime() - startOfYear.getTime()) / 86400000 + startOfYear.getDay() + 1) / 7)
    return `${d.getFullYear()}-W${String(weekNum).padStart(2, '0')}`
  }

  // Procházíme všechny logy (agentLogWeekly má víc záznamů)
  for (const l of Array.isArray(agentLogWeekly) ? agentLogWeekly : []) {
    if (!l.created_at) continue
    const rezim = String(l.rezim ?? '').toUpperCase()
    const key = weekKey(String(l.created_at))

    // Confidence agregace (všechny rezim)
    if (agentWeekBuckets[rezim]) {
      const prev = agentWeekBuckets[rezim].get(key) ?? { sumConf: 0, decisions: 0, acc_errors: 0, auditor_false_neg: 0, fixed: 0 }
      if (l.confidence != null) { prev.sumConf += Number(l.confidence); prev.decisions++ }

      const typ = String(l.typ ?? '')
      const zmena = String(l.zmena_stavu ?? '')

      if (typ === 'korekce' && rezim === 'ACCOUNTANT') prev.acc_errors++
      if (typ === 'korekce' && rezim === 'AUDITOR') prev.auditor_false_neg++
      if (typ === 'rozhodnuti' && rezim === 'ACCOUNTANT' && zmena === 'CORRECTED') prev.fixed++

      agentWeekBuckets[rezim].set(key, prev)
    }
  }

  // Přidáme korekce z agentLog (limit 200, přesnější typ data)
  for (const l of Array.isArray(agentLog) ? agentLog : []) {
    if (!l.created_at || !l.rezim) continue
    const rezim = String(l.rezim).toUpperCase()
    if (!agentWeekBuckets[rezim]) continue
    const key = weekKey(String(l.created_at))
    const prev = agentWeekBuckets[rezim].get(key) ?? { sumConf: 0, decisions: 0, acc_errors: 0, auditor_false_neg: 0, fixed: 0 }

    if (l.typ === 'korekce' && rezim === 'ACCOUNTANT') prev.acc_errors++
    if (l.typ === 'korekce' && rezim === 'AUDITOR') prev.auditor_false_neg++
    if (l.typ === 'rozhodnuti' && rezim === 'ACCOUNTANT' && String(l.zmena_stavu ?? '') === 'CORRECTED') prev.fixed++

    agentWeekBuckets[rezim].set(key, prev)
  }

  const agentTrend: Record<string, AgentTrendBucket[]> = {}
  for (const r of REZIM_LIST) {
    agentTrend[r.toLowerCase()] = [...agentWeekBuckets[r].entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(-8)
      .map(([week, v]) => {
        const errors = r === 'AUDITOR' ? v.auditor_false_neg : v.acc_errors
        return {
          week,
          avg_confidence: v.decisions > 0 ? Math.round(v.sumConf / v.decisions) : 0,
          decisions: v.decisions,
          acc_errors: v.acc_errors,
          auditor_false_neg: v.auditor_false_neg,
          fixed: v.fixed,
          error_rate_pct: v.decisions > 0 ? Math.round((errors / v.decisions) * 100) : 0,
        }
      })
  }

  // ── Souhrnné KPI agentů (celé období) ────────────────────────────────────
  const agentKpiSummary: Record<string, {
    total_decisions: number
    acc_errors: number
    auditor_false_neg: number
    fixed: number
    error_rate_pct: number
    fix_rate_pct: number
  }> = {}

  for (const r of REZIM_LIST) {
    const buckets = [...agentWeekBuckets[r].values()]
    const total = buckets.reduce((s, b) => s + b.decisions, 0)
    const acc_errors = buckets.reduce((s, b) => s + b.acc_errors, 0)
    const auditor_false_neg = buckets.reduce((s, b) => s + b.auditor_false_neg, 0)
    const fixed = buckets.reduce((s, b) => s + b.fixed, 0)
    const errors = r === 'AUDITOR' ? auditor_false_neg : acc_errors
    agentKpiSummary[r.toLowerCase()] = {
      total_decisions: total,
      acc_errors,
      auditor_false_neg,
      fixed,
      error_rate_pct: total > 0 ? Math.round((errors / total) * 100) : 0,
      fix_rate_pct: acc_errors > 0 ? Math.round((fixed / acc_errors) * 100) : 100,
    }
  }

  // ── 5. Sestavení kontextu pro Claude ─────────────────────────────────────
  const systemSnapshot = {
    rok,
    faktury: {
      total: faktury.length,
      nova: nova.length,
      schvalena: schvalena.length,
      zaplacena: zaplacena.length,
      zamitnuta: zamitnuta.length,
      bez_kategorie: withoutKategorie.length,
      needs_info: needsInfo.length,
      s_workflow: withWorkflow.length,
      overdue: overdueFaktury.length,
    },
    transakce: {
      sparovane: sparovane.length,
      nesparovane: nesparovane.length,
      parovani_rate_pct: Math.round(sparovane.length / (sparovane.length + nesparovane.length || 1) * 100),
    },
    agent_log: {
      total: agentLog.length,
      by_rezim: logByRezim,
      avg_confidence: avgConfidence,
      high_conf_pct: Math.round(highConfLogs / (logWithConfidence.length || 1) * 100),
      low_conf_pct: Math.round(lowConfLogs / (logWithConfidence.length || 1) * 100),
      mid_conf_pct: Math.round(midConfLogs / (logWithConfidence.length || 1) * 100),
      feedback_types: feedbackTypes,
    },
    pravidla: {
      dodavatel_pravidla: pravidla.length,
      ucetni_pravidla_total: pravidlaUcetni.length,
      manual: manualPravidla,
      agent: agentPravidla,
      pending_approval: pendingPravidla,
      avg_confidence: avgPravidloConf,
    },
    scores: {
      overall: overallScore,
      accounting: accountingQuality,
      audit: auditQuality,
      workflow: workflowQuality,
      data: dataQuality,
      architecture: architectureQuality,
      learning: learningQuality,
    },
  }

  // ── 5. Claude analýza ─────────────────────────────────────────────────────
  // Kompaktní prompt — SYSTEM_ARCHITECT je příliš dlouhý pro Haiku, inline jen klíčová pravidla
  const CONTROL_TOWER_PROMPT = `Jsi ARCHITECT agenta SuperAccount. Analyzuješ zdraví systému z dat a navrhneš akce.

ABSOLUTNÍ PRAVIDLO: Supabase je jediný zdroj pravdy. ABRA je zákonný výstup — musí zrcadlit SB přesně, tolerance 0.
Jakýkoli rozdíl SB vs ABRA = kritický problém. Nikdy nehodnoť ABRA jako zdroj dat.

Pravidla: odděluj fakta/návrhy/review/schválení. Buď kritický pokud: DB míchá fakta a návrhy, chybí audit trail, AI rozhoduje místo pravidel, confidence si potvrzuje chyby, ABRA není synchronizována.
Odpovídej VÝHRADNĚ validním JSON bez markdown.

DATA (rok ${rok}): ${JSON.stringify(systemSnapshot)}

Vrať přesně tento JSON (vyplň hodnoty):
{
  "system_health": {
    "overall_score": <číslo 0-100 z dat>,
    "accounting_quality": <číslo>,
    "audit_quality": <číslo>,
    "workflow_quality": <číslo>,
    "data_quality": <číslo>,
    "architecture_quality": <číslo>,
    "learning_quality": <číslo>,
    "summary": "<1 věta o celkovém stavu>"
  },
  "kpi_by_agent": [
    {
      "agent_name": "accountant|auditor|pm|architect",
      "strongest_area": "<string>",
      "weakest_area": "<string>",
      "risk_level": "low|medium|high|critical",
      "performance_summary": "<1 věta>"
    }
  ],
  "critical_issues": [
    {
      "severity": "critical|high|medium|low",
      "type": "case|pattern|rule|data|architecture",
      "owner_agent": "accountant|auditor|pm|architect",
      "title": "<string>",
      "symptom": "<string>",
      "root_cause": "<string>",
      "impact": "<string>",
      "recommended_fix": "<string>"
    }
  ],
  "patterns": [
    { "description": "<string>", "trend": "worsening|stable|improving" }
  ],
  "database_health": {
    "null_fields": ["<string>"],
    "missing_relationships": ["<string>"],
    "mixed_tables": ["<string>"],
    "source_of_truth_risks": ["<string>"],
    "schema_recommendations": ["<string>"]
  },
  "learning_health": {
    "override_analysis": "<string>",
    "disagreement_analysis": "<string>",
    "confidence_problems": "<string>",
    "learning_gaps": ["<string>"]
  },
  "quick_wins": [
    { "action": "<string>", "effort": "low|medium", "impact": "high|medium" }
  ],
  "strategic_improvements": [
    { "title": "<string>", "description": "<string>", "priority": "high|medium" }
  ],
  "orchestrator_tasking": {
    "action_list": [
      {
        "action": "<string>",
        "priority": "high|medium|low",
        "owner_agent": "accountant|auditor|pm|architect",
        "type": "data_fix|schema_change|rule_creation|prompt_update|workflow_change",
        "description": "<string>",
        "expected_impact": "<string>"
      }
    ],
    "system_decisions": {
      "database": ["<string>"],
      "rules": ["<string>"],
      "prompts": ["<string>"],
      "workflow": ["<string>"]
    },
    "agent_task_assignments": {
      "accountant": ["<string>"],
      "auditor": ["<string>"],
      "pm": ["<string>"],
      "architect": ["<string>"]
    },
    "learning_actions": ["<string>"],
    "top3_priorities": ["<string>", "<string>", "<string>"]
  }
}`

  // ── Fallback analýza z vypočtených metrik (bez Claude) ───────────────────
  const fallbackAnalysis = {
    system_health: {
      overall_score: overallScore,
      accounting_quality: accountingQuality,
      audit_quality: auditQuality,
      workflow_quality: workflowQuality,
      data_quality: dataQuality,
      architecture_quality: architectureQuality,
      learning_quality: learningQuality,
      summary: `Systém zpracoval ${faktury.length} faktur v roce ${rok}. ${needsInfo.length > 0 ? `${needsInfo.length} CASE čeká na odpověď.` : 'Žádné blokery.'} ${overdueFaktury.length > 0 ? `${overdueFaktury.length} faktur po splatnosti.` : ''}`,
    },
    kpi_by_agent: [
      { agent_name: 'accountant', strongest_area: 'klasifikace', weakest_area: withoutKategorie.length > 0 ? `${withoutKategorie.length} faktur bez kategorie` : 'vše OK', risk_level: withoutKategorie.length > 5 ? 'high' : 'low', performance_summary: `Zpracoval ${faktury.length} faktur, ${withKategorie.length} s kategorií.` },
      { agent_name: 'auditor', strongest_area: 'kontrola confidence', weakest_area: avgConfidence < 70 ? 'nízká průměrná confidence' : 'audit trail', risk_level: avgConfidence < 60 ? 'critical' : avgConfidence < 75 ? 'medium' : 'low', performance_summary: `Průměrná confidence ${avgConfidence}%. Vysoká: ${Math.round(highConfLogs / (logWithConfidence.length || 1) * 100)}%.` },
      { agent_name: 'pm', strongest_area: 'workflow orchestrace', weakest_area: needsInfo.length > 0 ? `${needsInfo.length} NEEDS_INFO` : 'auto-trigger', risk_level: needsInfo.length > 3 ? 'high' : overdueFaktury.length > 0 ? 'medium' : 'low', performance_summary: `${withWorkflow.length} CASE s workflow stavem. ${overdueFaktury.length} po splatnosti.` },
      { agent_name: 'architect', strongest_area: 'CASE schema', weakest_area: pendingPravidla > 0 ? `${pendingPravidla} pending rule proposals` : 'learning feedback loop', risk_level: pendingPravidla > 0 ? 'medium' : 'low', performance_summary: `${pravidlaUcetni.length} pravidel, prům. confidence ${avgPravidloConf}%.` },
    ],
    critical_issues: [
      ...(withoutKategorie.length > 5 ? [{ severity: 'high', type: 'data', owner_agent: 'accountant', title: `${withoutKategorie.length} faktur bez kategorie`, symptom: 'Faktury ke schválení nemají přiřazenou kategorii', root_cause: 'Chybějící pravidlo nebo nízká confidence klasifikace', impact: 'Nelze zaúčtovat do ABRA', recommended_fix: 'Spustit PM agenta pro dávkovou klasifikaci' }] : []),
      ...(needsInfo.length > 0 ? [{ severity: 'medium', type: 'case', owner_agent: 'pm', title: `${needsInfo.length} CASE čeká na odpověď`, symptom: 'Faktury v stavu NEEDS_INFO', root_cause: 'Agent eskaloval na člověka, bez odpovědi', impact: 'Workflow zablokován', recommended_fix: 'Otevřít PM Agent tab a odpovědět na otázky' }] : []),
      ...(overdueFaktury.length > 0 ? [{ severity: 'high', type: 'case', owner_agent: 'pm', title: `${overdueFaktury.length} faktur po splatnosti`, symptom: 'Datum splatnosti překročeno', root_cause: 'Neschváleno nebo nespárováno včas', impact: 'Riziko penále, poškození vztahu s dodavatelem', recommended_fix: 'Prioritní schválení a párování' }] : []),
      ...(avgConfidence < 65 ? [{ severity: 'medium', type: 'pattern', owner_agent: 'auditor', title: 'Nízká průměrná confidence', symptom: `Průměrná confidence ${avgConfidence}%`, root_cause: 'Chybějící pravidla, mnoho nových dodavatelů', impact: 'Agent eskaluje příliš často', recommended_fix: 'Přidat explicitní pravidla pro opakující se dodavatele' }] : []),
    ],
    patterns: [
      { description: `Párování transakcí: ${Math.round(sparovane.length / (sparovane.length + nesparovane.length || 1) * 100)}% spárováno`, trend: sparovane.length > nesparovane.length ? 'improving' : 'worsening' },
      { description: `${agentPravidla} pravidel z agenta vs ${manualPravidla} manuálních`, trend: agentPravidla > manualPravidla ? 'improving' : 'stable' },
    ],
    quick_wins: [
      ...(withoutKategorie.length > 0 ? [{ action: `Klasifikovat ${withoutKategorie.length} faktur bez kategorie přes PM agenta`, effort: 'low', impact: 'high' }] : []),
      ...(needsInfo.length > 0 ? [{ action: `Odpovědět na ${needsInfo.length} eskalaci v PM Agent tabu`, effort: 'low', impact: 'high' }] : []),
      ...(pendingPravidla > 0 ? [{ action: `Schválit ${pendingPravidla} rule proposals`, effort: 'low', impact: 'medium' }] : []),
      { action: 'Spustit PM agenta pro aktuální backlog', effort: 'low', impact: 'high' },
    ],
    strategic_improvements: [
      { title: 'Auto-trigger PM agenta', description: 'Vercel Cron nakonfigurován (0 7 * * 1-5) — zkontrolovat deployment', priority: 'high' },
      { title: 'Feedback loop klasifikace', description: 'Každá manuální korekce kategorie by měla posilovat pravidlo přes /api/agent/learn', priority: 'medium' },
    ],
    orchestrator_tasking: {
      action_list: [
        ...(overdueFaktury.length > 0 ? [{ action: 'Zpracovat faktury po splatnosti', priority: 'high', owner_agent: 'pm', type: 'workflow_change', description: `${overdueFaktury.length} faktur po splatnosti — urgentní schválení nebo eskalace`, expected_impact: 'Eliminace rizika penále' }] : []),
        ...(withoutKategorie.length > 0 ? [{ action: 'Dávková klasifikace', priority: 'high', owner_agent: 'accountant', type: 'data_fix', description: `${withoutKategorie.length} faktur bez kategorie — spustit klasifikaci`, expected_impact: 'Odblokování ABRA zaúčtování' }] : []),
        { action: 'Audit confidence distribuce', priority: 'medium', owner_agent: 'auditor', type: 'rule_creation', description: 'Identifikovat dodavatele s opakovaně nízkou confidence a vytvořit pravidla', expected_impact: 'Snížení eskalací o 30-50%' },
      ],
      system_decisions: {
        database: ['Ověřit že stav_workflow je naplněn pro všechny faktury roku'],
        rules: [pendingPravidla > 0 ? `Schválit ${pendingPravidla} čekající rule proposals` : 'Pravidla v pořádku'],
        prompts: ['Control Tower přešel na Haiku — monitorovat kvalitu analýzy'],
        workflow: ['Vercel Cron /api/agent/cron aktivovat po deployi'],
      },
      agent_task_assignments: {
        accountant: [`Klasifikovat ${withoutKategorie.length} faktur bez kategorie`, 'Ověřit DPH u zahraničních SaaS'],
        auditor: [`Zkontrolovat ${lowConfLogs} rozhodnutí s confidence < 60%`, 'Auditovat reverse charge faktury'],
        pm: [`Vyřešit ${needsInfo.length} NEEDS_INFO eskalací`, `Zpracovat ${overdueFaktury.length} faktur po splatnosti`],
        architect: [pendingPravidla > 0 ? `Schválit ${pendingPravidla} rule proposals` : 'Monitoring feedback loop', 'Validovat stav_workflow backfill'],
      },
      learning_actions: [
        'Manuální korekce kategorií → /api/agent/learn (pattern_update)',
        'Schválené rule proposals zvýší confidence na 90+',
        'Tiché potvrzení (case prošel bez zásahu) = slabý signál, neposilovat agresivně',
      ],
      top3_priorities: [
        overdueFaktury.length > 0 ? `Schválit ${overdueFaktury.length} faktur po splatnosti` : `Klasifikovat ${withoutKategorie.length} faktur bez kategorie`,
        needsInfo.length > 0 ? `Odpovědět na ${needsInfo.length} eskalaci agenta` : 'Spustit PM agenta pro backlog',
        'Aktivovat Vercel Cron pro automatický daily run',
      ],
    },
    _source: 'fallback_metrics',
  }

  let claudeAnalysis: Record<string, unknown> | null = null

  try {
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2048,
        messages: [{ role: 'user', content: CONTROL_TOWER_PROMPT }],
      }),
    })
    const claudeData = await claudeRes.json()
    const text = claudeData?.content?.[0]?.text?.trim() ?? ''
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0])
      // Přepiš skóre z reálných dat — Claude může být nepřesný
      if (parsed?.system_health) {
        parsed.system_health.overall_score = overallScore
        parsed.system_health.accounting_quality = accountingQuality
        parsed.system_health.audit_quality = auditQuality
        parsed.system_health.workflow_quality = workflowQuality
        parsed.system_health.data_quality = dataQuality
        parsed.system_health.architecture_quality = architectureQuality
        parsed.system_health.learning_quality = learningQuality
      }
      claudeAnalysis = parsed
    }
  } catch {
    claudeAnalysis = null
  }

  // ── 6. Chyby agentů — korekce pro CT dashboard ───────────────────────────
  const agentErrors = (Array.isArray(agentKorekce) ? agentKorekce : []).map((k: Record<string, unknown>) => ({
    id: k.id,
    typ: k.typ,
    rezim: k.rezim ?? 'unknown',
    feedback_type: k.feedback_type ?? null,
    faktura_id: k.faktura_id ?? null,
    popis: (() => {
      const v = k.vystup as Record<string, unknown> | null
      if (v?.discrepancy) return String(v.discrepancy)
      if (v?.korekce) return String(v.korekce)
      if (k.typ === 'eskalace') return 'Agent eskaloval na člověka — nízká confidence nebo chybí pravidlo'
      return 'Korekce zaznamenána'
    })(),
    korekce_popis: (() => {
      const v = k.vystup as Record<string, unknown> | null
      return v?.korekce ? String(v.korekce) : null
    })(),
    created_at: k.created_at,
  }))

  return NextResponse.json({
    ok: true,
    snapshot: systemSnapshot,
    analysis: claudeAnalysis ?? fallbackAnalysis,
    analysis_source: claudeAnalysis ? 'claude' : 'fallback_metrics',
    weekly_trend: weeklyTrend,
    agent_errors: agentErrors,
    agent_trend: agentTrend,
    agent_kpi: agentKpiSummary,
    generated_at: new Date().toISOString(),
  })
}
