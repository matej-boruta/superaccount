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
import { findBestPravidlo, logDecision } from '@/lib/rules'

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
    { headers: SB }
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
        log.push({ type: 'warn', text: `${dodavatel} — žádné pravidlo, přeskakuji` })
        continue
      }

      if (pravidlo.confidence < 60) {
        log.push({ type: 'warn', text: `${dodavatel} — confidence ${pravidlo.confidence}% příliš nízká, eskaluji` })
        // Nastav NEEDS_INFO
        await fetch(`${SUPABASE_URL}/rest/v1/faktury?id=eq.${fakturaId}`, {
          method: 'PATCH',
          headers: SBW,
          body: JSON.stringify({ stav_workflow: 'NEEDS_INFO', blocker: `ACCOUNTANT: nízká confidence ${pravidlo.confidence}% pro ${dodavatel}` }),
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

      await logDecision({
        typ: 'rozhodnuti',
        faktura_id: fakturaId,
        vstup: { dodavatel, ico, castka: f.castka_s_dph },
        vystup: { kategorie_id: pravidlo.kategorie_id, md_ucet: pravidlo.md_ucet, dal_ucet: pravidlo.dal_ucet },
        confidence: pravidlo.confidence,
        pravidlo_zdroj: `${pravidlo.zdroj_tabulky}#${pravidlo.id}`,
        // @ts-expect-error rezim not in type but logged
        rezim: 'ACCOUNTANT',
        zmena_stavu: 'ACCOUNTING_PROPOSED',
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
