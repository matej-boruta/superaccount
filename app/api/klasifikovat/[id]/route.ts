import { NextResponse } from 'next/server'
import { callClaude, SYSTEM_AGENT } from '@/lib/claude'
import { findBestPravidlo, logDecision } from '@/lib/rules'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY!
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY!

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

  const kategorieId = await classifyWithAI(f, kategorieList)

  await logDecision({
    typ: kategorieId ? 'rozhodnuti' : 'eskalace',
    vstup: { faktura_id: Number(id), dodavatel: f.dodavatel, ico: f.ico, castka: f.castka_s_dph },
    vystup: { kategorie_id: kategorieId, zdroj: 'claude_ai', poznamka: 'První výskyt bez pravidla — označit k revizi' },
    confidence: kategorieId ? 55 : 0,
    pravidlo_zdroj: 'claude_ai',
    faktura_id: Number(id),
  })

  if (!kategorieId) return NextResponse.json({ kategorie_id: null, source: 'claude_no_result' })

  await sbPatch(kategorieId)
  return NextResponse.json({ kategorie_id: kategorieId, source: 'claude_ai', confidence: 55 })
}

async function classifyWithAI(
  f: { dodavatel?: string; popis?: string; castka_s_dph?: number; mena?: string },
  kategorieList: { id: number; l1: string; l2: string; popis_pro_ai: string }[]
): Promise<number | null> {
  if (!ANTHROPIC_API_KEY) return null

  const kategorieText = kategorieList
    .map(k => `ID ${k.id}: ${k.l1} / ${k.l2} – ${k.popis_pro_ai}`)
    .join('\n')

  const text = await callClaude(
    ANTHROPIC_API_KEY,
    [{
      role: 'user',
      content: `Klasifikuj fakturu do správné kategorie. Odpověz POUZE číslem ID kategorie, nic jiného.

Faktura:
- Dodavatel: ${f.dodavatel || ''}
- Popis: ${f.popis || ''}
- Částka: ${f.castka_s_dph} ${f.mena || 'CZK'}

Dostupné kategorie:
${kategorieText}`,
    }],
    { model: 'claude-haiku-4-5-20251001', maxTokens: 10, system: SYSTEM_AGENT }
  )

  const id = parseInt(text ?? '')
  if (isNaN(id) || id < 1 || id > kategorieList.length) return null
  return id
}
