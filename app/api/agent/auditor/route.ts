/**
 * POST /api/agent/auditor
 *
 * AUDITOR agent — kontroluje rozhodnutí s nízkou confidence, audituje CASE workflow.
 * Volaný Orchestrátorem pro audit tasky.
 *
 * ZDROJ PRAVDY: Supabase. ABRA je zákonný výstup — musí zrcadlit SB přesně (tolerance 0).
 * Pokud SB a ABRA nesedí → problém je vždy v ABRA, nikdy v SB.
 *
 * Body: { year?: number, task?: string }
 * Returns: { log, summary, flagged, approved }
 */

import { NextResponse } from 'next/server'
import { logDecision } from '@/lib/rules'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY!
const SB = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
const SBW = { ...SB, 'Content-Type': 'application/json', Prefer: 'return=minimal' }

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}))
  const year: number = body.year ?? new Date().getFullYear()
  const task: string = body.task ?? 'Audituj rozhodnutí agentů s nízkou confidence'

  const log: { type: 'action' | 'info' | 'warn'; text: string }[] = []
  log.push({ type: 'info', text: `AUDITOR spuštěn: ${task}` })

  // 1. Načti agent_log s nízkou confidence (< 60) pro tento rok
  const [lowConfRes, needsInfoRes] = await Promise.all([
    fetch(
      `${SUPABASE_URL}/rest/v1/agent_log` +
      `?created_at=gte.${year}-01-01&created_at=lte.${year}-12-31` +
      `&confidence=lt.60&confidence=gt.0` +
      `&typ=eq.rozhodnuti` +
      `&select=id,faktura_id,confidence,rezim,source_of_rule,vstup,vystup,created_at` +
      `&order=confidence.asc&limit=50`,
      { headers: SB }
    ),
    fetch(
      `${SUPABASE_URL}/rest/v1/faktury` +
      `?stav_workflow=eq.NEEDS_INFO` +
      `&datum_vystaveni=gte.${year}-01-01` +
      `&select=id,dodavatel,blocker,stav_workflow`,
      { headers: SB }
    ),
  ])

  const lowConfLogs: Record<string, unknown>[] = await lowConfRes.json().catch(() => [])
  const needsInfoFaktury: Record<string, unknown>[] = await needsInfoRes.json().catch(() => [])

  // 2. Zkontroluj ACCOUNTING_PROPOSED faktury — ověř kategorie
  const accountingRes = await fetch(
    `${SUPABASE_URL}/rest/v1/faktury` +
    `?stav_workflow=eq.ACCOUNTING_PROPOSED` +
    `&datum_vystaveni=gte.${year}-01-01` +
    `&select=id,dodavatel,kategorie_id,castka_s_dph,mena`,
    { headers: SB }
  )
  const accountingProposed: Record<string, unknown>[] = await accountingRes.json().catch(() => [])

  let flagged = 0
  let approved = 0

  // Audit: low confidence decisions
  if (Array.isArray(lowConfLogs) && lowConfLogs.length > 0) {
    log.push({ type: 'warn', text: `${lowConfLogs.length} rozhodnutí s confidence < 60% — vyžadují kontrolu` })
    for (const l of lowConfLogs.slice(0, 10)) {
      const vstup = l.vstup as Record<string, unknown> ?? {}
      log.push({ type: 'warn', text: `FKT #${l.faktura_id ?? '?'} · ${vstup.dodavatel ?? '?'} · conf ${l.confidence}% · ${l.source_of_rule ?? '?'}` })
      flagged++
    }
    if (lowConfLogs.length > 10) log.push({ type: 'warn', text: `… a dalších ${lowConfLogs.length - 10}` })
  } else {
    log.push({ type: 'action', text: 'Žádná rozhodnutí s nízkou confidence.' })
  }

  // Audit: NEEDS_INFO bloky
  if (Array.isArray(needsInfoFaktury) && needsInfoFaktury.length > 0) {
    log.push({ type: 'warn', text: `${needsInfoFaktury.length} faktur blokováno v NEEDS_INFO:` })
    for (const f of needsInfoFaktury) {
      log.push({ type: 'warn', text: `FKT #${f.id} · ${f.dodavatel} · ${f.blocker ?? 'bez popisu'}` })
      flagged++
    }
  }

  // Audit: ACCOUNTING_PROPOSED — ověř kategorie
  if (Array.isArray(accountingProposed) && accountingProposed.length > 0) {
    const withoutKat = accountingProposed.filter(f => !f.kategorie_id)
    if (withoutKat.length > 0) {
      log.push({ type: 'warn', text: `${withoutKat.length} faktur v ACCOUNTING_PROPOSED bez kategorie — vráceno ACCOUNTANTOVI` })
      for (const f of withoutKat) {
        await fetch(`${SUPABASE_URL}/rest/v1/faktury?id=eq.${f.id}`, {
          method: 'PATCH',
          headers: SBW,
          body: JSON.stringify({ stav_workflow: 'DATA_READY', blocker: 'AUDITOR: chybí kategorie, vráceno k překlasifikaci' }),
        })
        flagged++
      }
    } else {
      log.push({ type: 'action', text: `${accountingProposed.length} ACCOUNTING_PROPOSED → kategorie OK, posuvám do AUDIT_CHECKED` })
      for (const f of accountingProposed) {
        await fetch(`${SUPABASE_URL}/rest/v1/faktury?id=eq.${f.id}`, {
          method: 'PATCH',
          headers: SBW,
          body: JSON.stringify({ stav_workflow: 'AUDIT_CHECKED' }),
        })
        approved++
      }
    }
  }

  // Log AUDITOR rozhodnutí
  await logDecision({
    typ: flagged > 0 ? 'korekce' : 'rozhodnuti',
    vstup: { task, low_conf_count: lowConfLogs.length, needs_info_count: needsInfoFaktury.length },
    vystup: { flagged, approved, accounting_proposed: accountingProposed.length },
    confidence: flagged > 0 ? 50 : 90,
    pravidlo_zdroj: 'auditor_sweep',
    // @ts-expect-error rezim not in type
    rezim: 'AUDITOR',
    zmena_stavu: flagged > 0 ? 'AUDIT_FLAGGED' : 'AUDIT_CHECKED',
  })

  const summary = `AUDITOR: ${approved} schváleno, ${flagged} označeno/vráceno. ${lowConfLogs.length} nízkých confidence.`
  log.push({ type: flagged > 0 ? 'warn' : 'action', text: summary })

  return NextResponse.json({ log, summary, flagged, approved })
}
