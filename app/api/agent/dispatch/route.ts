/**
 * POST /api/agent/dispatch
 *
 * Orchestrátor dispatcher — routuje task ke správnému agentovi.
 * ZDROJ PRAVDY: Supabase. ABRA je zákonný výstup. Verifikace vždy měří stav SB.
 *
 * Body: { owner_agent, task, description, type, year }
 * Returns: { log, summary, ok, agent_called, verification }
 */

import { NextResponse } from 'next/server'

const BASE = process.env.NEXTAUTH_URL ?? (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000')
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY!
const SB = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }

async function verify(year: number): Promise<{ faktury_bez_kategorie: number; needs_info: number; accounting_proposed: number; audit_checked: number }> {
  const [f1, f2, f3, f4] = await Promise.all([
    fetch(`${SUPABASE_URL}/rest/v1/faktury?stav=in.(nova,schvalena)&kategorie_id=is.null&datum_vystaveni=gte.${year}-01-01&select=id`, { headers: SB }),
    fetch(`${SUPABASE_URL}/rest/v1/faktury?stav_workflow=eq.NEEDS_INFO&datum_vystaveni=gte.${year}-01-01&select=id`, { headers: SB }),
    fetch(`${SUPABASE_URL}/rest/v1/faktury?stav_workflow=eq.ACCOUNTING_PROPOSED&datum_vystaveni=gte.${year}-01-01&select=id`, { headers: SB }),
    fetch(`${SUPABASE_URL}/rest/v1/faktury?stav_workflow=eq.AUDIT_CHECKED&datum_vystaveni=gte.${year}-01-01&select=id`, { headers: SB }),
  ])
  const [bez_kat, needs_info, acc_proposed, audit_checked] = await Promise.all([f1.json(), f2.json(), f3.json(), f4.json()])
  return {
    faktury_bez_kategorie: Array.isArray(bez_kat) ? bez_kat.length : 0,
    needs_info: Array.isArray(needs_info) ? needs_info.length : 0,
    accounting_proposed: Array.isArray(acc_proposed) ? acc_proposed.length : 0,
    audit_checked: Array.isArray(audit_checked) ? audit_checked.length : 0,
  }
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}))
  const { owner_agent, task, description, type: actionType, year = new Date().getFullYear() } = body

  // Nelze auto-provést
  if (actionType === 'schema_change' || actionType === 'prompt_update') {
    return NextResponse.json({
      ok: false,
      agent_called: null,
      log: [{ type: 'warn', text: 'Vyžaduje manuální zásah — změna schématu nebo promptu nelze automatizovat.' }],
      summary: 'Manuální zásah vyžadován.',
      verification: null,
    })
  }

  let agentEndpoint: string
  let agentBody: Record<string, unknown>

  switch (owner_agent) {
    case 'accountant':
      agentEndpoint = `${BASE}/api/agent/accountant`
      agentBody = { year, task: `${task}. ${description ?? ''}`.trim() }
      break
    case 'auditor':
      agentEndpoint = `${BASE}/api/agent/auditor`
      agentBody = { year, task: `${task}. ${description ?? ''}`.trim() }
      break
    case 'pm':
      agentEndpoint = `${BASE}/api/agent/pm`
      agentBody = { year, orchestrator_task: `${task}. ${description ?? ''}`.trim() }
      break
    case 'architect':
      // ARCHITECT = log finding + vrať doporučení (nelze auto-provést systémové změny)
      return NextResponse.json({
        ok: true,
        agent_called: 'architect_log',
        log: [{ type: 'info', text: `ARCHITECT task zalogován: ${task}` }],
        summary: `ARCHITECT: "${task}" — systémové doporučení zaznamenáno. Vyžaduje manuální implementaci.`,
        verification: null,
      })
    default:
      agentEndpoint = `${BASE}/api/agent/pm`
      agentBody = { year, orchestrator_task: task }
  }

  // Stav před
  const before = await verify(year)

  // Spusť agenta
  const agentRes = await fetch(agentEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(agentBody),
  })
  const agentData = await agentRes.json().catch(() => ({ log: [], summary: 'Chyba při volání agenta' }))

  // Stav po (verifikace)
  const after = await verify(year)

  const verification = {
    before,
    after,
    delta: {
      faktury_bez_kategorie: after.faktury_bez_kategorie - before.faktury_bez_kategorie,
      needs_info: after.needs_info - before.needs_info,
      accounting_proposed: after.accounting_proposed - before.accounting_proposed,
      audit_checked: after.audit_checked - before.audit_checked,
    },
    ok: (() => {
      if (owner_agent === 'accountant') return after.faktury_bez_kategorie <= before.faktury_bez_kategorie
      if (owner_agent === 'auditor') return after.audit_checked >= before.audit_checked || after.needs_info <= before.needs_info
      return true
    })(),
    verdict: (() => {
      if (owner_agent === 'accountant') {
        const fixed = before.faktury_bez_kategorie - after.faktury_bez_kategorie
        return fixed > 0 ? `✓ Klasifikováno ${fixed} faktur` : after.faktury_bez_kategorie === 0 ? '✓ Vše klasifikováno' : `⚠ Bez změny (${after.faktury_bez_kategorie} stále bez kategorie)`
      }
      if (owner_agent === 'auditor') {
        return after.audit_checked > before.audit_checked
          ? `✓ ${after.audit_checked - before.audit_checked} faktur posunuto do AUDIT_CHECKED`
          : after.needs_info < before.needs_info
          ? `✓ Odblokováno ${before.needs_info - after.needs_info} NEEDS_INFO`
          : '→ Auditní sweep dokončen'
      }
      return '→ Task dokončen'
    })(),
  }

  return NextResponse.json({
    ok: !agentData.error,
    agent_called: owner_agent,
    log: agentData.log ?? [],
    summary: agentData.summary ?? 'Hotovo',
    verification,
  })
}
