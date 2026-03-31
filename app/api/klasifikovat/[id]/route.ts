import { NextResponse } from 'next/server'
import { callClaude, SYSTEM_AGENT, SYSTEM_AUDIT } from '@/lib/claude'
import { findBestPravidlo, logDecision } from '@/lib/rules'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY!
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY!
const OPENAI_API_KEY = process.env.OPENAI_API_KEY!

const SB = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }

export async function POST(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  const fRes = await fetch(`${SUPABASE_URL}/rest/v1/faktury?id=eq.${id}&select=*`, { headers: SB })
  const [f] = await fRes.json()
  if (!f) return NextResponse.json({ error: 'Nenalezena' }, { status: 404 })

  if (f.kategorie_id) return NextResponse.json({ kategorie_id: f.kategorie_id, source: 'already_set' })

  const sbPatch = (kategorie_id: number) =>
    fetch(`${SUPABASE_URL}/rest/v1/faktury?id=eq.${id}`, {
      method: 'PATCH',
      headers: { ...SB, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ kategorie_id }),
    })

  // 1. Pravidla z ucetni_pravidla / ucetni_vzory
  const pravidlo = await findBestPravidlo(f.dodavatel ?? '', f.ico ?? null, 'predkontace')
  if (pravidlo?.kategorie_id && pravidlo.confidence >= 70) {
    await sbPatch(pravidlo.kategorie_id)
    await logDecision({
      typ: 'rozhodnuti',
      vstup: { faktura_id: Number(id), dodavatel: f.dodavatel, ico: f.ico },
      vystup: { kategorie_id: pravidlo.kategorie_id, zdroj: pravidlo.zdroj_tabulky },
      confidence: pravidlo.confidence,
      pravidlo_zdroj: pravidlo.zdroj_tabulky,
      faktura_id: Number(id),
    })
    return NextResponse.json({
      kategorie_id: pravidlo.kategorie_id,
      source: pravidlo.zdroj_tabulky,
      confidence: pravidlo.confidence,
    })
  }

  // 2. Historie faktur — stejné IČO
  if (f.ico) {
    const histRes = await fetch(
      `${SUPABASE_URL}/rest/v1/faktury?ico=eq.${encodeURIComponent(f.ico)}&kategorie_id=not.is.null&id=neq.${id}&select=kategorie_id&order=id.desc&limit=1`,
      { headers: SB }
    )
    const [prev] = await histRes.json()
    if (prev?.kategorie_id) {
      await sbPatch(prev.kategorie_id)
      await logDecision({
        typ: 'rozhodnuti',
        vstup: { faktura_id: Number(id), dodavatel: f.dodavatel, ico: f.ico },
        vystup: { kategorie_id: prev.kategorie_id, zdroj: 'history_ico' },
        confidence: 75,
        pravidlo_zdroj: 'history_ico',
        faktura_id: Number(id),
      })
      return NextResponse.json({ kategorie_id: prev.kategorie_id, source: 'history_ico', confidence: 75 })
    }
  }

  // 3. Historie faktur — stejný dodavatel
  if (f.dodavatel) {
    const histRes = await fetch(
      `${SUPABASE_URL}/rest/v1/faktury?dodavatel=eq.${encodeURIComponent(f.dodavatel)}&kategorie_id=not.is.null&id=neq.${id}&select=kategorie_id&order=id.desc&limit=1`,
      { headers: SB }
    )
    const [prev] = await histRes.json()
    if (prev?.kategorie_id) {
      await sbPatch(prev.kategorie_id)
      await logDecision({
        typ: 'rozhodnuti',
        vstup: { faktura_id: Number(id), dodavatel: f.dodavatel },
        vystup: { kategorie_id: prev.kategorie_id, zdroj: 'history_dodavatel' },
        confidence: 65,
        pravidlo_zdroj: 'history_dodavatel',
        faktura_id: Number(id),
      })
      return NextResponse.json({ kategorie_id: prev.kategorie_id, source: 'history_dodavatel', confidence: 65 })
    }
  }

  // 4. Claude AI — fallback, confidence < 60 (první výskyt bez vzoru)
  const kRes = await fetch(`${SUPABASE_URL}/rest/v1/kategorie?select=*&order=id.asc`, { headers: SB })
  const kategorieList = await kRes.json()
  if (!Array.isArray(kategorieList) || kategorieList.length === 0) {
    return NextResponse.json({ kategorie_id: null })
  }

  const aiResult = await classifyWithDualModel(f, kategorieList)

  await logDecision({
    typ: aiResult.kategorie_id ? 'rozhodnuti' : 'eskalace',
    vstup: { faktura_id: Number(id), dodavatel: f.dodavatel, ico: f.ico, castka: f.castka_s_dph },
    vystup: {
      kategorie_id: aiResult.kategorie_id,
      zdroj: 'claude_ai',
      model_a: aiResult.model_a,
      audit: aiResult.audit,
      poznamka: aiResult.audit?.poznamka ?? 'První výskyt bez pravidla — označit k revizi',
    },
    confidence: aiResult.confidence,
    pravidlo_zdroj: 'claude_ai',
    faktura_id: Number(id),
  })

  if (!aiResult.kategorie_id) return NextResponse.json({ kategorie_id: null, source: 'claude_no_result' })

  await sbPatch(aiResult.kategorie_id)
  return NextResponse.json({
    kategorie_id: aiResult.kategorie_id,
    source: 'claude_ai',
    confidence: aiResult.confidence,
    audit_souhlas: aiResult.audit?.souhlas ?? null,
  })
}

type AuditResult = {
  souhlas: boolean
  confidence_korekce: number
  kategorie_id_navrh: number | null
  poznamka: string
}

async function classifyWithDualModel(
  f: { dodavatel?: string; popis?: string; castka_s_dph?: number; mena?: string },
  kategorieList: { id: number; l1: string; l2: string; popis_pro_ai: string }[]
): Promise<{ kategorie_id: number | null; confidence: number; model_a: Record<string, unknown>; audit: AuditResult | null }> {
  if (!ANTHROPIC_API_KEY) return { kategorie_id: null, confidence: 0, model_a: {}, audit: null }

  const kategorieText = kategorieList
    .map(k => `ID ${k.id}: ${k.l1} / ${k.l2} – ${k.popis_pro_ai}`)
    .join('\n')

  const fakturaText = `Dodavatel: ${f.dodavatel || '—'}\nPopis: ${f.popis || '—'}\nČástka: ${f.castka_s_dph} ${f.mena || 'CZK'}`

  // Model A: reasoning — klasifikuje a zdůvodňuje
  const modelAText = await callClaude(
    ANTHROPIC_API_KEY,
    [{
      role: 'user',
      content: `Klasifikuj fakturu. Odpověz čistým JSON:
{"kategorie_id": <číslo>, "confidence": <0-100>, "duvod": "<1 věta proč>"}

Faktura:
${fakturaText}

Kategorie:
${kategorieText}`,
    }],
    { model: 'claude-haiku-4-5-20251001', maxTokens: 80, system: SYSTEM_AGENT }
  )

  let modelA: { kategorie_id: number; confidence: number; duvod: string } | null = null
  try {
    modelA = JSON.parse(modelAText?.match(/\{[\s\S]*\}/)?.[0] ?? '')
  } catch { /* modelA zůstane null */ }

  if (!modelA?.kategorie_id) return { kategorie_id: null, confidence: 0, model_a: {}, audit: null }

  // Model B: GPT-4o-mini jako nezávislý auditor — jiná firma, jiné tréninková data
  const auditText = await callOpenAIAudit(
    `Zkontroluj toto účetní rozhodnutí:

Faktura:
${fakturaText}

Rozhodnutí modelu A (Claude):
- Kategorie ID: ${modelA.kategorie_id}
- Zdůvodnění: ${modelA.duvod}
- Confidence: ${modelA.confidence}%

Zvolená kategorie: ${kategorieList.find(k => k.id === modelA!.kategorie_id)?.l1 ?? '?'} / ${kategorieList.find(k => k.id === modelA!.kategorie_id)?.l2 ?? '?'}

Všechny kategorie:
${kategorieText}`
  )

  let audit: AuditResult | null = null
  try {
    audit = JSON.parse(auditText?.match(/\{[\s\S]*\}/)?.[0] ?? '')
  } catch { /* audit zůstane null */ }

  // Finální confidence: Model A ± korekce auditora, floor 0, cap 84 (Claude AI nikdy ≥ 85)
  const baseConf = modelA.confidence ?? 55
  const korekce = audit?.confidence_korekce ?? 0
  const finalConf = Math.max(0, Math.min(84, baseConf + korekce))

  // Pokud audit nesouhlasí a navrhuje jinou kategorii → použij auditorův návrh
  const finalKatId = (audit?.souhlas === false && audit?.kategorie_id_navrh)
    ? audit.kategorie_id_navrh
    : modelA.kategorie_id

  return {
    kategorie_id: finalKatId,
    confidence: finalConf,
    model_a: modelA,
    audit,
  }
}

async function callOpenAIAudit(userMessage: string): Promise<string | null> {
  // Pokus o GPT-4o-mini — pokud selže (quota, nedostupnost), fallback na Claude Haiku
  if (OPENAI_API_KEY) {
    try {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          max_tokens: 200,
          messages: [
            { role: 'system', content: SYSTEM_AUDIT },
            { role: 'user', content: userMessage },
          ],
        }),
      })
      const data = await res.json()
      const text = data?.choices?.[0]?.message?.content?.trim()
      if (text) return text
    } catch { /* fallback níže */ }
  }

  // Fallback: Claude Haiku jako Model B
  return callClaude(
    ANTHROPIC_API_KEY,
    [{ role: 'user', content: userMessage }],
    { model: 'claude-haiku-4-5-20251001', maxTokens: 200, system: SYSTEM_AUDIT }
  )
}
