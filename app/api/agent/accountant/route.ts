/**
 * POST /api/agent/accountant
 *
 * ACCOUNTANT agent — klasifikuje faktury bez kategorie, navrhuje předkontaci.
 * Volaný Orchestrátorem pro konkrétní accounting tasky.
 *
 * ZDROJ PRAVDY: Supabase. ABRA je zákonný výstup. Všechna rozhodnutí se ukládají do SB.
 *
 * Body: { year?: number, task?: string }
 * Returns: { log, summary, processed, errors }
 */

import { NextResponse } from 'next/server'
import { findBestPravidlo, logDecision, writeFeedback, writeRozhodnuti } from '@/lib/rules'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY!
const SB = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
const SBW = { ...SB, 'Content-Type': 'application/json', Prefer: 'return=minimal' }

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}))
  const year: number = body.year ?? new Date().getFullYear()
  const task: string = body.task ?? 'Klasifikuj faktury bez kategorie'

  const log: { type: 'action' | 'info' | 'warn'; text: string }[] = []
  log.push({ type: 'info', text: `ACCOUNTANT spuštěn: ${task}` })

  // 1. Načti faktury bez kategorie (nova/schvalena)
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/faktury?stav=in.(nova,schvalena)` +
    `&datum_vystaveni=gte.${year}-01-01&datum_vystaveni=lte.${year}-12-31` +
    `&kategorie_id=is.null` +
    `&select=id,dodavatel,ico,castka_s_dph,mena,popis,stav_workflow`,
    { headers: { ...SB, Range: '0-9999' } }
  )
  const faktury: Record<string, unknown>[] = await res.json().catch(() => [])

  if (!Array.isArray(faktury) || faktury.length === 0) {
    log.push({ type: 'info', text: 'Žádné faktury bez kategorie.' })
    return NextResponse.json({ log, summary: 'Vše klasifikováno.', processed: 0, errors: 0 })
  }

  log.push({ type: 'info', text: `Nalezeno ${faktury.length} faktur bez kategorie.` })

  let processed = 0
  let errors = 0

  for (const f of faktury) {
    const dodavatel = String(f.dodavatel ?? '')
    const ico = f.ico ? String(f.ico) : null
    const fakturaId = Number(f.id)

    try {
      const pravidlo = await findBestPravidlo(dodavatel, ico, 'predkontace')

      if (!pravidlo || !pravidlo.kategorie_id) {
        log.push({ type: 'warn', text: `${dodavatel} — žádné pravidlo` })
        // Feedback → Architekt: vytvoř pravidlo
        await writeFeedback({
          trigger: 'no_rule',
          from_agent: 'accountant',
          to_agent: 'architect',
          issue: `Nelze kategorizovat dodavatele "${dodavatel}" (ICO: ${ico ?? 'neznámé'}) — žádné pravidlo`,
          action: 'create_rule',
          priority: 'medium',
          context: { faktura_id: fakturaId, dodavatel, ico },
        })
        continue
      }

      if (pravidlo.confidence < 70) {
        log.push({ type: 'warn', text: `${dodavatel} — confidence ${pravidlo.confidence}% < 70, posílám Auditorovi` })
        await fetch(`${SUPABASE_URL}/rest/v1/faktury?id=eq.${fakturaId}`, {
          method: 'PATCH',
          headers: SBW,
          body: JSON.stringify({ stav_workflow: 'NEEDS_INFO', blocker: `ACCOUNTANT: nízká confidence ${pravidlo.confidence}%` }),
        })
        // Feedback → Auditor: rozhodni nebo eskaluj
        await writeFeedback({
          trigger: 'low_confidence',
          from_agent: 'accountant',
          to_agent: 'auditor',
          issue: `Navrhuji kat ${pravidlo.kategorie_id} pro "${dodavatel}" ale confidence ${pravidlo.confidence}% < 70 — potřebuji validaci`,
          action: 'fix_case',
          priority: pravidlo.confidence < 50 ? 'high' : 'medium',
          context: { faktura_id: fakturaId, dodavatel, ico, navrzena_kategorie: pravidlo.kategorie_id, confidence: pravidlo.confidence },
        })
        continue
      }

      // Aplikuj kategorii
      await fetch(`${SUPABASE_URL}/rest/v1/faktury?id=eq.${fakturaId}`, {
        method: 'PATCH',
        headers: SBW,
        body: JSON.stringify({
          kategorie_id: pravidlo.kategorie_id,
          stav_workflow: 'ACCOUNTING_PROPOSED',
          zauctovano_platba: pravidlo.auto_schvalit && Number(f.castka_s_dph ?? 0) <= pravidlo.limit_auto_kc,
        }),
      })

      // Zapiš rozhodnutí s pravidlo_id — klíč pro zpětnou analýzu kvality pravidel
      await writeRozhodnuti({
        entity_type: 'faktura',
        entity_id: fakturaId,
        faktura_id: fakturaId,
        typ: 'kategorizace',
        agent: 'accountant',
        pravidlo_id: pravidlo.id,
        navrh: { kategorie_id: pravidlo.kategorie_id, md_ucet: pravidlo.md_ucet, dal_ucet: pravidlo.dal_ucet },
        confidence: pravidlo.confidence,
        stav: pravidlo.confidence >= 90 ? 'accepted' : pravidlo.confidence >= 70 ? 'proposed' : 'review_required',
        zdroj: pravidlo.zdroj,
      })

      await logDecision({
        typ: 'rozhodnuti',
        agent_id: 'accountant',
        faktura_id: fakturaId,
        vstup: { dodavatel, ico, castka: f.castka_s_dph },
        vystup: { kategorie_id: pravidlo.kategorie_id, md_ucet: pravidlo.md_ucet, dal_ucet: pravidlo.dal_ucet },
        confidence: pravidlo.confidence,
        pravidlo_zdroj: `${pravidlo.zdroj_tabulky}#${pravidlo.id}`,
        to_agent: pravidlo.confidence < 70 ? 'auditor' : undefined,
        recommended_action: pravidlo.confidence < 70 ? 'validate' : undefined,
      })

      log.push({ type: 'action', text: `${dodavatel} → kategorie ${pravidlo.kategorie_id} (conf ${pravidlo.confidence}%)` })
      processed++
    } catch (e) {
      log.push({ type: 'warn', text: `${dodavatel} — chyba: ${String(e)}` })
      errors++
    }
  }

  const summary = `ACCOUNTANT: ${processed} faktur klasifikováno, ${errors} chyb, ${faktury.length - processed - errors} přeskočeno`
  log.push({ type: 'info', text: summary })

  return NextResponse.json({ log, summary, processed, errors })
}
