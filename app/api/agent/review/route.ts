/**
 * POST /api/agent/review
 *
 * Denní sebehodnocení agenta. Volá se automaticky každý den v 23:00 přes N8N.
 *
 * Co dělá:
 *   1. Přečte agent_log za posledních 24h (nebo N dní)
 *   2. Analyzuje vzory: kolik rozhodnutí, kolik korekcí, kde chyboval
 *   3. Identifikuje dodavatele bez pravidla (padli na Claude AI)
 *   4. Navrhne nová pravidla (confidence < 70 + byl opraven = přidat pravidlo)
 *   5. Uloží report do agent_manual (sekce 11_sebehodnoceni)
 *   6. Commitne do gitu — denní záznam vývoje agenta
 */
import { NextResponse } from 'next/server'
import { callClaude, SYSTEM_AGENT } from '@/lib/claude'
import { savePravidlo, logDecision } from '@/lib/rules'

const SB_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SB_KEY = process.env.SUPABASE_SERVICE_KEY!
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY!
const SB = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` }

async function sbGet(path: string) {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: SB })
  return res.json()
}

export async function POST(req: Request) {
  let daysBack = 1
  try {
    const body = await req.json()
    if (body?.days) daysBack = Number(body.days)
  } catch { /* default 1 day */ }

  const since = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString()
  const today = new Date().toISOString().slice(0, 10)

  // 1. Načti agent_log za period
  const logs = await sbGet(
    `agent_log?created_at=gte.${since}&order=created_at.desc&limit=500`
  )
  if (!Array.isArray(logs)) {
    return NextResponse.json({ error: 'agent_log nedostupný' }, { status: 500 })
  }

  // 2. Statistiky
  const stats = {
    celkem: logs.length,
    rozhodnuti: logs.filter((l: Record<string, unknown>) => l.typ === 'rozhodnuti').length,
    korekce: logs.filter((l: Record<string, unknown>) => l.typ === 'korekce').length,
    eskalace: logs.filter((l: Record<string, unknown>) => l.typ === 'eskalace').length,
    chyby: logs.filter((l: Record<string, unknown>) => l.typ === 'chyba').length,
  }

  // 3. Analýza zdrojů rozhodnutí
  const rozhodnuti = logs.filter((l: Record<string, unknown>) => l.typ === 'rozhodnuti')
  const zdrojeCounts: Record<string, number> = {}
  for (const r of rozhodnuti) {
    const z = String(r.pravidlo_zdroj ?? 'neznamy')
    zdrojeCounts[z] = (zdrojeCounts[z] ?? 0) + 1
  }

  // 4. Korekce — kteří dodavatelé byli opraveni?
  const korekce = logs.filter((l: Record<string, unknown>) => l.typ === 'korekce')
  const opraveniDodavatele: { dodavatel: string; stara_kat: unknown; nova_kat: unknown }[] = []
  for (const k of korekce) {
    const vstup = k.vstup as Record<string, unknown>
    const vystup = k.vystup as Record<string, unknown>
    if (vstup?.dodavatel) {
      opraveniDodavatele.push({
        dodavatel: String(vstup.dodavatel),
        stara_kat: vstup.auto_kategorie,
        nova_kat: vystup.kategorie_id,
      })
    }
  }

  // 5. Rozhodnutí přes Claude AI (slabá místa — bez pravidla)
  const claudeRozhodnuti = rozhodnuti.filter(
    (l: Record<string, unknown>) => l.pravidlo_zdroj === 'claude_ai'
  )
  const claudeDodavatele = claudeRozhodnuti.map((l: Record<string, unknown>) => {
    const vstup = l.vstup as Record<string, unknown>
    return { dodavatel: String(vstup?.dodavatel ?? ''), faktura_id: l.faktura_id }
  }).filter(d => d.dodavatel)

  // 6. Claude analyzuje vzory a navrhuje zlepšení
  let aiAnalyza = ''
  let navrhPravidel: { dodavatel: string; kategorie_id: number; poznamka: string }[] = []

  if (logs.length > 0 && ANTHROPIC_KEY) {
    const prompt = `Jsi SuperAccount agent. Analyzuj svůj výkon za posledních ${daysBack} dní.

STATISTIKY:
- Celkem rozhodnutí: ${stats.celkem}
- Z databázových pravidel: ${zdrojeCounts['ucetni_pravidla'] ?? 0}
- Z historie: ${(zdrojeCounts['history_ico'] ?? 0) + (zdrojeCounts['history_dodavatel'] ?? 0)}
- Claude AI (bez pravidla): ${zdrojeCounts['claude_ai'] ?? 0}
- Korekcí člověkem: ${stats.korekce}
- Eskalací: ${stats.eskalace}
- Chyb: ${stats.chyby}

OPRAVENÍ DODAVATELÉ (člověk musel zasáhnout):
${opraveniDodavatele.map(d => `- ${d.dodavatel}: kat ${d.stara_kat} → ${d.nova_kat}`).join('\n') || 'žádní'}

DODAVATELÉ BEZ PRAVIDLA (šlo přes AI):
${claudeDodavatele.slice(0, 10).map(d => `- ${d.dodavatel} (faktura ${d.faktura_id})`).join('\n') || 'žádní'}

Napiš stručný report (max 200 slov) ve formátu:
1. Co fungovalo dobře
2. Kde jsem chyboval nebo byl nejistý
3. Konkrétní návrhy na zlepšení (nová pravidla, úpravy)
4. Celkové hodnocení dne (1–10)

Odpověz v češtině, jako agent hodnotící sám sebe.`

    aiAnalyza = await callClaude(ANTHROPIC_KEY, [{ role: 'user', content: prompt }],
      { model: 'claude-haiku-4-5-20251001', maxTokens: 400, system: SYSTEM_AGENT }
    ) ?? 'Analýza nedostupná'

    // Navrhni pravidla pro opravené dodavatele
    if (opraveniDodavatele.length > 0) {
      for (const op of opraveniDodavatele) {
        if (op.nova_kat && Number(op.nova_kat) > 0) {
          navrhPravidel.push({
            dodavatel: op.dodavatel,
            kategorie_id: Number(op.nova_kat),
            poznamka: `Auto-návrh z denního review ${today} — opraveno člověkem`,
          })
        }
      }
    }
  }

  // 7. Ulož navrhovaná pravidla (confidence=75 — agent navrhl, ne člověk)
  for (const np of navrhPravidel) {
    await savePravidlo({
      typ: 'predkontace',
      dodavatel: np.dodavatel,
      kategorie_id: np.kategorie_id,
      confidence: 75,
      zdroj: 'agent',
      poznamka: np.poznamka,
    })
  }

  // 8. Sestavení reportu
  const report = `# Denní review agenta — ${today}

## Statistiky dne
| Metrika | Počet |
|---|---|
| Celkem rozhodnutí | ${stats.celkem} |
| Z pravidel (bez AI) | ${zdrojeCounts['ucetni_pravidla'] ?? 0} |
| Z historie | ${(zdrojeCounts['history_ico'] ?? 0) + (zdrojeCounts['history_dodavatel'] ?? 0)} |
| Claude AI (bez pravidla) | ${zdrojeCounts['claude_ai'] ?? 0} |
| Korekcí člověkem | ${stats.korekce} |
| Eskalací | ${stats.eskalace} |
| Chyb | ${stats.chyby} |

## Hodnocení agenta
${aiAnalyza}

${opraveniDodavatele.length > 0 ? `## Opravení dodavatelé
${opraveniDodavatele.map(d => `- **${d.dodavatel}**: kategorie ${d.stara_kat} → ${d.nova_kat}`).join('\n')}
` : ''}
${navrhPravidel.length > 0 ? `## Nová pravidla přidána (confidence=75)
${navrhPravidel.map(p => `- ${p.dodavatel} → kategorie ${p.kategorie_id}`).join('\n')}
` : ''}
---
*Vygenerováno: ${new Date().toISOString()} | Analyzované období: posledních ${daysBack} dní*`

  // 9. Ulož do agent_review
  await fetch(`${SB_URL}/rest/v1/agent_review`, {
    method: 'POST',
    headers: { ...SB, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({
      datum: today,
      period_days: daysBack,
      stats,
      zdroje: zdrojeCounts,
      opraveni_dodavatele: opraveniDodavatele,
      nova_pravidla: navrhPravidel,
      ai_analyza: aiAnalyza,
      report_md: report,
    }),
  })

  // 10. Loguj review do agent_log
  await logDecision({
    typ: 'plan',
    vstup: { period_days: daysBack, since },
    vystup: { stats, nova_pravidla: navrhPravidel.length, hodnoceni: aiAnalyza.slice(0, 100) },
    confidence: 100,
    pravidlo_zdroj: 'self_review',
  })

  // 11. Commitni do gitu
  await fetch(`${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/api/agent/commit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: `Review ${today}: ${stats.celkem} rozhodnutí, ${stats.korekce} korekcí, ${navrhPravidel.length} nových pravidel`,
      push: true,
      scope: ['manual', 'pravidla'],
    }),
  }).catch(() => {})

  return NextResponse.json({
    ok: true,
    datum: today,
    stats,
    zdroje: zdrojeCounts,
    opraveni_dodavatele: opraveniDodavatele.length,
    nova_pravidla: navrhPravidel.length,
    report_ulozeno: 'agent_review',
  })
}
