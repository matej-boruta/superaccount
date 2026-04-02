/**
 * POST /api/agent/learn
 *
 * Volá se když člověk ručně opraví klasifikaci faktury.
 * Implementuje §12 ústavy v2.1 — 4 typy feedbacku, nikdy je neslévej.
 *
 * Body: {
 *   faktura_id: number
 *   kategorie_id: number           — nová správná kategorie
 *   dodavatel?: string
 *   ico?: string
 *   md_ucet?: string
 *   dal_ucet?: string
 *   sazba_dph?: number
 *   poznamka?: string
 *   feedback_type?:                — explicitní klasifikace (pokud chybí, odvodí se)
 *     'case_correction' |          — oprava tohoto konkrétního případu (confidence=95)
 *     'pattern_update' |           — posílení/oslabení historického vzoru (confidence=85)
 *     'rule_proposal' |            — návrh nového pravidla, čeká na schválení (confidence=75)
 *     'architecture_finding'       — systémový problém, neukládá pravidlo (confidence=70)
 * }
 */
import { NextResponse } from 'next/server'
import { savePravidlo, logDecision } from '@/lib/rules'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY!
const SB = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }

type FeedbackType = 'case_correction' | 'pattern_update' | 'rule_proposal' | 'architecture_finding'

// Confidence per typ feedbacku dle §12 ústavy v2.1
const CONFIDENCE_BY_TYPE: Record<FeedbackType, number> = {
  case_correction: 95,     // explicitní korekce člověka — nejvyšší váha
  pattern_update: 85,      // potvrzený vzor — přiměřená váha
  rule_proposal: 75,       // čeká na schválení — nižší confidence dokud neschváleno
  architecture_finding: 70, // systémový problém — logujeme, ale pravidlo NEukládáme
}

/**
 * Odvodí typ feedbacku pokud není explicitně zadán.
 * §12: NIKDY neslévat typy — každý má jiný dopad.
 */
function inferFeedbackType(opts: {
  prevKategorieId: number | null
  newKategorieId: number
  isDodavatelKnown: boolean
  poznamka?: string
}): FeedbackType {
  const { prevKategorieId, newKategorieId, isDodavatelKnown, poznamka } = opts

  // Architektonický problém — explicitní klíčová slova
  if (poznamka?.toLowerCase().includes('architektur') ||
      poznamka?.toLowerCase().includes('systémový') ||
      poznamka?.toLowerCase().includes('workflow')) {
    return 'architecture_finding'
  }

  // Nový dodavatel bez historického vzoru → návrh pravidla (čeká na schválení)
  if (!isDodavatelKnown) {
    return 'rule_proposal'
  }

  // Změna kategorie u známého dodavatele → update vzoru
  if (prevKategorieId !== null && prevKategorieId !== newKategorieId) {
    return 'pattern_update'
  }

  // Výchozí: oprava konkrétního případu
  return 'case_correction'
}

export async function POST(req: Request) {
  const body = await req.json()
  const {
    faktura_id,
    kategorie_id,
    dodavatel,
    ico,
    md_ucet,
    dal_ucet,
    sazba_dph,
    poznamka,
    feedback_type: explicitFeedbackType,
  } = body

  if (!faktura_id || !kategorie_id) {
    return NextResponse.json({ error: 'faktura_id a kategorie_id jsou povinné' }, { status: 400 })
  }

  // Načti fakturu — potřebujeme dodavatel, ico, stávající kategorie_id
  let finalDodavatel = dodavatel
  let finalIco = ico
  let prevKategorieId: number | null = null

  const fRes = await fetch(
    `${SUPABASE_URL}/rest/v1/faktury?id=eq.${faktura_id}&select=dodavatel,ico,kategorie_id`,
    { headers: SB }
  )
  const [f] = await fRes.json()
  if (!finalDodavatel) finalDodavatel = f?.dodavatel
  if (!finalIco) finalIco = f?.ico
  prevKategorieId = f?.kategorie_id ?? null

  if (!finalDodavatel) {
    return NextResponse.json({ error: 'Faktura nenalezena nebo chybí dodavatel' }, { status: 404 })
  }

  // Zjisti zda dodavatel má existující pravidlo (= "je znám")
  const pravidlaRes = await fetch(
    `${SUPABASE_URL}/rest/v1/ucetni_pravidla?dodavatel=eq.${encodeURIComponent(finalDodavatel)}&select=id&limit=1`,
    { headers: SB }
  )
  const existujiciPravidla = await pravidlaRes.json()
  const isDodavatelKnown = Array.isArray(existujiciPravidla) && existujiciPravidla.length > 0

  // Urči typ feedbacku — §12: explicitní má přednost, jinak odvoď
  const feedbackType: FeedbackType = explicitFeedbackType ?? inferFeedbackType({
    prevKategorieId,
    newKategorieId: kategorie_id,
    isDodavatelKnown,
    poznamka,
  })

  const confidence = CONFIDENCE_BY_TYPE[feedbackType]

  // §12: architecture_finding → loguj, ale NE-ukládej pravidlo
  // §12: rule_proposal → ulož s nižší confidence, označit jako čekající na schválení
  // §12: case_correction, pattern_update → ulož pravidlo
  let pravidloUlozeno = false

  if (feedbackType !== 'architecture_finding') {
    await savePravidlo({
      typ: 'predkontace',
      dodavatel: finalDodavatel,
      ico: finalIco ?? null,
      kategorie_id,
      md_ucet: md_ucet ?? null,
      dal_ucet: dal_ucet ?? null,
      sazba_dph: sazba_dph ?? null,
      confidence,
      zdroj: feedbackType === 'rule_proposal' ? 'rule_proposal_pending' : 'manual',
      poznamka: poznamka ?? `${feedbackType} — faktura ${faktura_id}`,
    })
    pravidloUlozeno = true
  }

  // Aktualizuj fakturu — vždy při case_correction a pattern_update
  // rule_proposal a architecture_finding — opravíme fakturu ale pravidlo čeká
  await fetch(`${SUPABASE_URL}/rest/v1/faktury?id=eq.${faktura_id}`, {
    method: 'PATCH',
    headers: { ...SB, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({ kategorie_id }),
  })

  // Loguj do agent_log s novými sloupci rezim + feedback_type (§12)
  await logDecision({
    typ: 'korekce',
    vstup: {
      faktura_id,
      dodavatel: finalDodavatel,
      ico: finalIco,
      prev_kategorie_id: prevKategorieId,
      feedback_type: feedbackType,
    },
    vystup: { kategorie_id, md_ucet, dal_ucet, confidence, pravidlo_ulozeno: pravidloUlozeno },
    confidence,
    pravidlo_zdroj: feedbackType,
    faktura_id,
  })

  // Auto-commit pouze pro pattern_update a rule_proposal (§12)
  // case_correction = lokální oprava, nespouští commit
  // architecture_finding = systémový problém, nespouští commit
  if (feedbackType === 'pattern_update' || feedbackType === 'rule_proposal') {
    const commitMsg = feedbackType === 'pattern_update'
      ? `Pattern: ${finalDodavatel} → kat=${kategorie_id}, conf=${confidence} (pattern_update faktura ${faktura_id})`
      : `Rule proposal: ${finalDodavatel} → kat=${kategorie_id}, conf=${confidence} (čeká na schválení)`

    fetch(`${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/api/agent/commit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: commitMsg, push: true, scope: ['pravidla'] }),
    }).catch(() => { /* commit je best-effort, nesmí blokovat */ })
  }

  const poznamkyByType: Record<FeedbackType, string> = {
    case_correction: `Opraveno pro tento případ. Pravidlo uloženo s confidence=${confidence}.`,
    pattern_update: `Vzor aktualizován s confidence=${confidence}. Příště aplikováno automaticky.`,
    rule_proposal: `Návrh pravidla uložen s confidence=${confidence}. Čeká na schválení člověkem.`,
    architecture_finding: `Systémový nález zalogován. Pravidlo nebylo uloženo — problém je v architektuře.`,
  }

  return NextResponse.json({
    ok: true,
    feedback_type: feedbackType,
    pravidlo_ulozeno: pravidloUlozeno,
    dodavatel: finalDodavatel,
    kategorie_id,
    confidence,
    poznamka: poznamkyByType[feedbackType],
  })
}
