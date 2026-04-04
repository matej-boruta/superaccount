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
import { logDecision, findBestPravidlo, writeFeedback } from '@/lib/rules'

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
      { headers: { ...SB, Range: '0-9999' } }
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

    // Feedback → Architekt: příliš mnoho nízkých confidence = slabá pravidla
    if (lowConfLogs.length > 5) {
      await writeFeedback({
        trigger: 'high_low_confidence_rate',
        from_agent: 'auditor',
        to_agent: 'architect',
        issue: `${lowConfLogs.length} rozhodnutí s confidence < 60% — pravidla jsou příliš slabá nebo chybí`,
        action: 'update_rule',
        priority: lowConfLogs.length > 20 ? 'high' : 'medium',
        context: { low_conf_count: lowConfLogs.length, sample_faktura_ids: lowConfLogs.slice(0, 5).map(l => l.faktura_id) },
      })
    }
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
      // Feedback → Architekt: broken pipeline
      await writeFeedback({
        trigger: 'approved_without_category',
        from_agent: 'auditor',
        to_agent: 'architect',
        issue: `${withoutKat.length} faktur prošlo schválením bez kategorie — pipeline je přerušena`,
        action: 'fix_case',
        priority: 'high',
        context: { count: withoutKat.length, ids: withoutKat.map(f => f.id) },
      })
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

  // ── 4. Kontrola kategorií — faktury bez kategorie vs. pravidla ──────────────
  const bezKatRes = await fetch(
    `${SUPABASE_URL}/rest/v1/faktury` +
    `?stav=in.(nova,schvalena)` +
    `&datum_vystaveni=gte.${year}-01-01` +
    `&kategorie_id=is.null` +
    `&select=id,dodavatel,ico,castka_s_dph,mena,stav_workflow`,
    { headers: { ...SB, Range: '0-9999' } }
  )
  const bezKatFaktury: Record<string, unknown>[] = await bezKatRes.json().catch(() => [])

  let autoAssigned = 0
  let noRule = 0

  if (Array.isArray(bezKatFaktury) && bezKatFaktury.length > 0) {
    log.push({ type: 'info', text: `Kontrola kategorií: ${bezKatFaktury.length} faktur bez kategorie` })

    for (const f of bezKatFaktury) {
      const dodavatel = String(f.dodavatel ?? '')
      const ico = f.ico ? String(f.ico) : null

      // 1. Zkus pravidlo (pravidla → pravidla → ucetni_vzory)
      const pravidlo = await findBestPravidlo(dodavatel, ico, 'predkontace')

      if (pravidlo?.kategorie_id && pravidlo.confidence >= 60) {
        await fetch(`${SUPABASE_URL}/rest/v1/faktury?id=eq.${f.id}`, {
          method: 'PATCH',
          headers: SBW,
          body: JSON.stringify({
            kategorie_id: pravidlo.kategorie_id,
            stav_workflow: 'ACCOUNTING_PROPOSED',
          }),
        })
        log.push({ type: 'action', text: `${dodavatel} → kat ${pravidlo.kategorie_id} z ${pravidlo.zdroj} (${pravidlo.confidence}%)` })
        autoAssigned++
        approved++
        continue
      }

      // 2. Fallback: hledej v historii faktur stejného dodavatele
      if (f.ico || dodavatel) {
        const histField = f.ico ? `ico=eq.${encodeURIComponent(String(f.ico))}` : `dodavatel=eq.${encodeURIComponent(dodavatel)}`
        const histRes = await fetch(
          `${SUPABASE_URL}/rest/v1/faktury?${histField}&kategorie_id=not.is.null&id=neq.${f.id}&select=kategorie_id&order=id.desc&limit=1`,
          { headers: SB }
        )
        const [prev] = await histRes.json().catch(() => [])
        if (prev?.kategorie_id) {
          await fetch(`${SUPABASE_URL}/rest/v1/faktury?id=eq.${f.id}`, {
            method: 'PATCH',
            headers: SBW,
            body: JSON.stringify({ kategorie_id: prev.kategorie_id, stav_workflow: 'ACCOUNTING_PROPOSED' }),
          })
          log.push({ type: 'action', text: `${dodavatel} → kat ${prev.kategorie_id} z history (65%)` })
          autoAssigned++
          approved++
          continue
        }
      }

      log.push({ type: 'warn', text: `${dodavatel} — žádné pravidlo ani historie, eskaluji` })
      noRule++
    }

    log.push({ type: autoAssigned > 0 ? 'action' : 'info', text: `Kontrola kategorií: ${autoAssigned} přiřazeno, ${noRule} bez pravidla` })
  }

  // Log AUDITOR rozhodnutí
  await logDecision({
    typ: flagged > 0 ? 'korekce' : 'validace',
    agent_id: 'auditor',
    vstup: { task, low_conf_count: lowConfLogs.length, needs_info_count: needsInfoFaktury.length },
    vystup: { flagged, approved, accounting_proposed: accountingProposed.length },
    confidence: flagged > 0 ? 50 : 90,
    pravidlo_zdroj: 'auditor_sweep',
    to_agent: flagged > 0 ? 'architect' : undefined,
    recommended_action: flagged > 0 ? 'review_flagged' : undefined,
    create_task: flagged > 5,
  })

  const summary = `AUDITOR: ${approved} schváleno, ${flagged} označeno/vráceno. ${lowConfLogs.length} nízkých confidence.`
  log.push({ type: flagged > 0 ? 'warn' : 'action', text: summary })

  return NextResponse.json({ log, summary, flagged, approved })
}
