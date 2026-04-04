/**
 * PM/Orchestrátor agent v2 — řídí CASE workflow dle ústavy v2.0.
 *
 * CASE = faktura jako řídicí objekt s stav_workflow:
 *   NEW → DATA_READY → ACCOUNTING_PROPOSED → AUDIT_CHECKED → READY_FOR_APPROVAL → APPROVED → POSTED
 *   Blokované: NEEDS_INFO | BLOCKED | REJECTED | ERROR
 *
 * Tool use loop:
 *   1. get_cases() → snapshot CASEů s pre-computed pravidla + VS shody
 *   2. Claude plánuje a jedná (advance_case po advance_case)
 *   3. ask_user → zastav loop, vrať otázku do UI (CASE → NEEDS_INFO)
 *   4. UI pošle odpověď → loop pokračuje
 *
 * Každé rozhodnutí loguje: role, confidence, source_of_rule, zmena_stavu, case_id.
 *
 * POST body:
 *   { year?: number, messages?: ClaudeMessage[], tool_use_id?: string, answer?: string }
 */

import { NextResponse } from 'next/server'
import { SYSTEM_PM } from '@/lib/claude'
import { logDecision as sharedLogDecision } from '@/lib/rules'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY!
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY!
const BASE_URL = process.env.NEXTAUTH_URL ?? process.env.VERCEL_URL
  ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000'

const SB = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
const SBW = { ...SB, 'Content-Type': 'application/json', Prefer: 'return=minimal' }

// ─── Tools ────────────────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'get_cases',
    description: 'Načte aktivní CASEy (faktury) s jejich stav_workflow, prioritou, blockerem a pre-computed shodami (pravidla, VS match transakcí). Volej jako první a pouze jednou.',
    input_schema: {
      type: 'object' as const,
      properties: { year: { type: 'number' } },
      required: [],
    },
  },
  {
    name: 'advance_case',
    description: 'Posune CASE do dalšího stavu workflow. Vyžaduje: jaká role rozhoduje, confidence, source_of_rule. Při APPROVED volá schvalit API. Při POSTED volá sparovat API. Při NEEDS_INFO nastaví blocker.',
    input_schema: {
      type: 'object' as const,
      properties: {
        case_id: { type: 'number', description: 'ID faktury/CASE' },
        next_state: {
          type: 'string',
          enum: ['DATA_READY', 'ACCOUNTING_PROPOSED', 'AUDIT_CHECKED', 'READY_FOR_APPROVAL', 'APPROVED', 'POSTED', 'NEEDS_INFO', 'BLOCKED', 'REJECTED', 'ERROR'],
        },
        role: { type: 'string', enum: ['accountant', 'auditor', 'pm'] },
        confidence: { type: 'number', description: 'Confidence 0–100' },
        source_of_rule: { type: 'string', description: 'Zdroj pravidla: explicit_rule | pattern | context | escalation' },
        kategorie_id: { type: 'number', description: 'Vyžadováno při next_state=APPROVED' },
        transakce_id: { type: 'number', description: 'Vyžadováno při next_state=POSTED' },
        reason: { type: 'string', description: 'Stručné zdůvodnění pro audit log' },
        blocker: { type: 'string', description: 'Popis blokeru při NEEDS_INFO nebo BLOCKED' },
      },
      required: ['case_id', 'next_state', 'role', 'confidence', 'source_of_rule', 'reason'],
    },
  },
  {
    name: 'ask_user',
    description: 'Eskaluje případ na člověka. Nastaví CASE do NEEDS_INFO. Použij POUZE po vyčerpání všech dostupných dat. Otázka musí být konkrétní s kontextem.',
    input_schema: {
      type: 'object' as const,
      properties: {
        case_id: { type: 'number' },
        otazka: { type: 'string' },
        kontext: { type: 'string', description: 'Proč se ptáš, co z odpovědi vyplyne' },
        moznosti: { type: 'array', items: { type: 'string' } },
      },
      required: ['case_id', 'otazka', 'kontext'],
    },
  },
]

// ─── Tool implementations ─────────────────────────────────────────────────────

async function toolGetCases(year: number) {
  const today = new Date().toISOString().split('T')[0]

  const [novaRes, schvalenaRes, transakceRes, pravidlaRes] = await Promise.all([
    fetch(
      `${SUPABASE_URL}/rest/v1/faktury?stav=in.(nova,schvalena)&datum_vystaveni=gte.${year}-01-01&datum_vystaveni=lte.${year}-12-31` +
      `&select=id,dodavatel,castka_s_dph,mena,datum_splatnosti,datum_vystaveni,kategorie_id,cislo_faktury,variabilni_symbol,popis,stav,stav_workflow,priorita,blocker` +
      `&order=priorita.desc,datum_splatnosti.asc`,
      { headers: SB }
    ),
    fetch(
      `${SUPABASE_URL}/rest/v1/transakce?stav=eq.nesparovano&castka=lt.0&datum=gte.${year}-01-01&datum=lte.${year}-12-31` +
      `&select=id,castka,mena,zprava,variabilni_symbol,datum`,
      { headers: SB }
    ),
    fetch(
      `${SUPABASE_URL}/rest/v1/pravidla?select=dodavatel,dodavatel_pattern,kategorie_id,auto_schvalit,auto_parovat`,
      { headers: SB }
    ),
    fetch(
      `${SUPABASE_URL}/rest/v1/kategorie?select=id,l1,l2,ucetni_kod`,
      { headers: SB }
    ),
  ])

  const [faktury, transakce, pravidla, kategorie] = await Promise.all([
    novaRes.json(), schvalenaRes.json(), transakceRes.json(), pravidlaRes.json(),
  ])

  const pravidlaArr = Array.isArray(pravidla) ? pravidla : []
  const transakceArr = Array.isArray(transakce) ? transakce : []
  const kategorieArr = Array.isArray(kategorie) ? kategorie : []
  const katMap = new Map(kategorieArr.map((k: Record<string, unknown>) => [k.id, k]))

  const cases = (Array.isArray(faktury) ? faktury : []).map((f: Record<string, unknown>) => {
    const dodavatelUpper = String(f.dodavatel ?? '').toUpperCase()
    const fVS = String(f.variabilni_symbol ?? '')

    // Match pravidla
    const matchedPravidlo = pravidlaArr.find((p: Record<string, unknown>) => {
      const pat = String(p.dodavatel_pattern ?? '').replace(/%/g, '').toUpperCase()
      return pat.length >= 3 && dodavatelUpper.includes(pat)
    })

    // Match transakce by VS or supplier name in zprava
    const matchedTransakce = transakceArr.filter((t: Record<string, unknown>) => {
      const tVS = String(t.variabilni_symbol ?? '')
      const zprava = String(t.zprava ?? '').toLowerCase()
      const dodLower = String(f.dodavatel ?? '').toLowerCase()
      const dodWords = dodLower.split(/\s+/).filter((w: string) => w.length >= 4)
      return (fVS && tVS && fVS === tVS) || dodWords.some((w: string) => zprava.includes(w))
    })

    const overdue = f.datum_splatnosti && String(f.datum_splatnosti) < today
    const kat = f.kategorie_id ? katMap.get(Number(f.kategorie_id)) : null

    return {
      id: f.id,
      dodavatel: f.dodavatel,
      castka_s_dph: f.castka_s_dph,
      mena: f.mena,
      datum_splatnosti: f.datum_splatnosti,
      variabilni_symbol: f.variabilni_symbol,
      popis: f.popis,
      stav: f.stav,
      stav_workflow: f.stav_workflow ?? (f.stav === 'nova' ? 'NEW' : f.stav === 'schvalena' ? 'APPROVED' : 'NEW'),
      priorita: f.priorita ?? 50,
      blocker: f.blocker,
      overdue,
      kategorie: kat ?? null,
      pravidlo: matchedPravidlo ?? null,
      kandidati_transakce: matchedTransakce.slice(0, 3),
    }
  })

  return {
    cases,
    total: cases.length,
    overdue_count: cases.filter((c: Record<string, unknown>) => c.overdue).length,
    with_pravidlo: cases.filter((c: Record<string, unknown>) => c.pravidlo).length,
    with_transakce_match: cases.filter((c: Record<string, unknown>) => (c.kandidati_transakce as unknown[]).length > 0).length,
    summary: `${cases.length} aktivních CASE: ${cases.filter((c: Record<string, unknown>) => c.overdue).length} po splatnosti, ${cases.filter((c: Record<string, unknown>) => c.pravidlo).length} s pravidlem, ${cases.filter((c: Record<string, unknown>) => (c.kandidati_transakce as unknown[]).length > 0).length} s kandidátem transakce`,
  }
}

async function logDecision(params: {
  caseId: number; role: string; confidence: number; sourceOfRule: string
  zmenaStavu: string; reason: string
}) {
  await sharedLogDecision({
    typ: 'rozhodnuti',
    faktura_id: params.caseId,
    vstup: { role: params.role },
    vystup: { reason: params.reason },
    confidence: params.confidence,
    pravidlo_zdroj: params.sourceOfRule,
    // @ts-expect-error extended fields not in type
    rezim: params.role,
    source_of_rule: params.sourceOfRule,
    zmena_stavu: params.zmenaStavu,
  })
}

async function toolAdvanceCase(input: {
  case_id: number; next_state: string; role: string; confidence: number
  source_of_rule: string; reason: string; kategorie_id?: number; transakce_id?: number; blocker?: string
}) {
  const { case_id, next_state, role, confidence, source_of_rule, reason, kategorie_id, transakce_id, blocker } = input

  // Hard guard: confidence < 60 or amount > 50k should not reach APPROVED via agent
  if (next_state === 'APPROVED' || next_state === 'POSTED') {
    const fRes = await fetch(`${SUPABASE_URL}/rest/v1/faktury?id=eq.${case_id}&select=castka_s_dph,kategorie_id`, { headers: SB })
    const [f] = await fRes.json()
    if (f && Number(f.castka_s_dph) > 50000) {
      return { ok: false, blocked: true, reason: 'Částka > 50 000 Kč — vyžaduje lidské schválení (ústava §4)' }
    }
    if (confidence < 60) {
      return { ok: false, blocked: true, reason: `Confidence ${confidence} % < 60 % — eskaluj na člověka (ústava §4)` }
    }
    // PRAVIDLO: nelze schválit bez kategorie
    if (next_state === 'APPROVED' && !kategorie_id && !(f?.kategorie_id)) {
      return { ok: false, blocked: true, reason: 'Faktura nemá kategorii — ACCOUNTANT musí přiřadit kategorii před schválením' }
    }
  }

  // Update stav_workflow + blocker
  await fetch(`${SUPABASE_URL}/rest/v1/faktury?id=eq.${case_id}`, {
    method: 'PATCH',
    headers: SBW,
    body: JSON.stringify({
      stav_workflow: next_state,
      ...(blocker !== undefined ? { blocker } : {}),
    }),
  })

  // Side effects per state
  if (next_state === 'APPROVED' && kategorie_id) {
    // Schválit fakturu (sets stav=schvalena, creates ABRA record)
    await fetch(`${BASE_URL}/api/schvalit/${case_id}`, { method: 'POST' })
    await fetch(`${SUPABASE_URL}/rest/v1/faktury?id=eq.${case_id}`, {
      method: 'PATCH',
      headers: SBW,
      body: JSON.stringify({ kategorie_id }),
    })
  }

  if (next_state === 'POSTED' && transakce_id) {
    // Sparovat transakci (sets stav=zaplacena, creates ABRA banka)
    await fetch(`${BASE_URL}/api/sparovat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fakturaId: case_id, transakceId: transakce_id }),
    })
  }

  await logDecision({
    caseId: case_id,
    role,
    confidence,
    sourceOfRule: source_of_rule,
    zmenaStavu: `→ ${next_state}`,
    reason,
  })

  return { ok: true, case_id, next_state, role, confidence }
}

// ─── Main handler ─────────────────────────────────────────────────────────────

type ClaudeMessage = { role: 'user' | 'assistant'; content: unknown }

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}))
  const year: number = body.year ?? new Date().getFullYear()
  let messages: ClaudeMessage[] = body.messages ?? []
  const incomingToolUseId: string | null = body.tool_use_id ?? null
  const incomingAnswer: string | null = body.answer ?? null

  const log: { type: 'action' | 'info' | 'warn'; text: string }[] = []

  const orchestratorTask: string | null = body.orchestrator_task ?? null

  if (messages.length === 0) {
    const taskInstruction = orchestratorTask
      ? `Máš konkrétní úkol od Orchestrátoru: "${orchestratorTask}". Začni get_cases() a zaměř se primárně na tento úkol.`
      : `Zpracuj CASE backlog pro rok ${year}. Začni get_cases(). Postupuj podle ústavy: nejdřív CASEy s pravidlem a VS shodou, pak ostatní. Ptej se jen pokud musíš.`
    messages = [{ role: 'user', content: taskInstruction }]
    log.push({ type: 'info', text: orchestratorTask ? `Orchestrátor task: ${orchestratorTask}` : `PM agent spuštěn pro rok ${year}…` })
  }

  if (incomingToolUseId && incomingAnswer !== null) {
    messages.push({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: incomingToolUseId, content: incomingAnswer }],
    })
    log.push({ type: 'info', text: `Odpověď přijata, pokračuji…` })
  }

  // Tool use loop — max 25 iterací
  for (let iter = 0; iter < 25; iter++) {
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 2048,
        system: SYSTEM_PM,
        tools: TOOLS,
        messages,
      }),
    })

    const claudeData = await claudeRes.json()
    const content = claudeData.content ?? []
    const stopReason = claudeData.stop_reason

    messages.push({ role: 'assistant', content })

    if (stopReason === 'end_turn') {
      const summary = content.find((c: Record<string, unknown>) => c.type === 'text')?.text ?? 'Hotovo.'
      return NextResponse.json({ type: 'done', summary, log })
    }

    if (stopReason !== 'tool_use') {
      return NextResponse.json({ type: 'done', summary: 'Agent dokončil bez dalších akcí.', log })
    }

    const toolUses = content.filter((c: Record<string, unknown>) => c.type === 'tool_use')
    const toolResults: unknown[] = []

    for (const toolUse of toolUses) {
      const { id, name, input } = toolUse as { id: string; name: string; input: Record<string, unknown> }

      if (name === 'ask_user') {
        // Set CASE to NEEDS_INFO before returning
        if (input.case_id) {
          await fetch(`${SUPABASE_URL}/rest/v1/faktury?id=eq.${input.case_id}`, {
            method: 'PATCH',
            headers: SBW,
            body: JSON.stringify({ stav_workflow: 'NEEDS_INFO', blocker: String(input.otazka) }),
          })
          await logDecision({
            caseId: Number(input.case_id), role: 'pm', confidence: 40,
            sourceOfRule: 'escalation', zmenaStavu: '→ NEEDS_INFO', reason: String(input.otazka),
          })
        }
        return NextResponse.json({
          type: 'question',
          tool_use_id: id,
          case_id: input.case_id,
          otazka: input.otazka,
          kontext: input.kontext,
          moznosti: input.moznosti ?? [],
          messages,
          log,
        })
      }

      let result: unknown
      try {
        if (name === 'get_cases') {
          log.push({ type: 'info', text: `Načítám CASE backlog ${year}…` })
          result = await toolGetCases(year)
          const r = result as { summary: string }
          log.push({ type: 'info', text: r.summary })
        } else if (name === 'advance_case') {
          result = await toolAdvanceCase(input as Parameters<typeof toolAdvanceCase>[0])
          const r = result as { ok: boolean; blocked?: boolean; next_state?: string; reason?: string }
          if (r.ok) {
            const stateLabel: Record<string, string> = {
              APPROVED: 'Schváleno', POSTED: 'Spárováno a zaúčtováno',
              NEEDS_INFO: 'Čeká na info', BLOCKED: 'Zablokováno',
              ACCOUNTING_PROPOSED: 'Návrh připraven', AUDIT_CHECKED: 'Audit OK',
            }
            log.push({ type: 'action', text: `CASE #${input.case_id}: ${stateLabel[String(input.next_state)] ?? input.next_state} — ${input.reason}` })
          } else if (r.blocked) {
            log.push({ type: 'warn', text: `CASE #${input.case_id} blokován: ${r.reason}` })
          }
        } else {
          result = { error: `Neznámý nástroj: ${name}` }
        }
      } catch (e) {
        result = { error: String(e) }
        log.push({ type: 'warn', text: `Chyba při ${name}: ${String(e).substring(0, 100)}` })
      }

      toolResults.push({ type: 'tool_result', tool_use_id: id, content: JSON.stringify(result) })
    }

    messages.push({ role: 'user', content: toolResults })
  }

  return NextResponse.json({ type: 'done', summary: 'Dosažen limit iterací.', log })
}
