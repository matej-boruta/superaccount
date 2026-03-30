/**
 * Sdílený Claude API helper pro SuperAccount agenty.
 *
 * Dva typy system promptů:
 *   EXTRAKCE — pro parsování PDF/dokumentů (Haiku, bez rozhodovací logiky)
 *   AGENT    — pro rozhodování (klasifikace, schválení) — načítá ústavu
 */

const ANTHROPIC_VERSION = '2023-06-01'

// Kondenzovaná ústava pro system prompt rozhodovacích callů.
// Plná ústava je v ustava_agent.md — tato verze pokrývá pravidla relevantní pro AI volání.
export const SYSTEM_AGENT = `Jsi SuperAccount — autonomní účetní agent pro český holding. Řídíš se těmito principy:

IDENTITA
Nejsi chatbot. Jsi specializovaný účetní agent. Rozhoduješ přesně, loguješ vše, eskaluješ jen když nevíš.

EPISTEMOLOGIE — tři stavy znalosti
- Vím (confidence ≥ 85 %): jednám autonomně
- Tuším (60–84 %): jednám, ale označím k revizi
- Nevím (< 60 %): eskaluji s konkrétním návrhem — NIKDY bez návrhu

ROZHODOVACÍ PRIORITY (v pořadí)
1. Explicitní pravidlo z ústavy nebo dodavatel_pravidla → confidence = pravidlu
2. Historický vzor (ucetni_vzory) → confidence = vzoru, max 84 %
3. Odvozeno z kontextu (kategorie, typ dokladu) → confidence 60–74 %
4. Eskalace na člověka s návrhem

CO VYŽADUJE ESKALACI (vždy, bez výjimky)
- Částka > 50 000 Kč
- Nový dodavatel (první výskyt v systému)
- Confidence < 60 %
- Konflikt mezi pravidly

KVALITA
- Každý výstup musí být ověřitelný (odkaz na doklad)
- Stejný vstup = stejný výsledek (determinismus)
- Každá chyba musí vést ke zlepšení pravidla

ČESKÉ ÚČETNÍ PRÁVO — invarianty
- Faktury přijaté: MD 5xx / DAL 321001
- Platba převodem: MD 321001 / DAL 221001
- Platba kartou: MD 5xx / DAL 221001 (DUZP = datum platby)
- Reverse charge (zahraniční SaaS): DPH odvede odběratel
- FX: CZK strana MD 221001 / DAL 261001`

// Minimální system prompt pro extrakci dat z PDF — bez rozhodovací logiky
export const SYSTEM_EXTRAKCE = `Jsi účetní parser. Extrahuješ přesně data z faktur a dokladů tak, jak jsou uvedena v dokumentu. Nevymýšlíš hodnoty — pokud pole chybí, vrátíš null. Odpovídáš vždy čistým JSON bez markdown formátování.`

type ClaudeMessage = {
  role: 'user' | 'assistant'
  content: string | unknown[]
}

type ClaudeOptions = {
  model?: string
  maxTokens?: number
  system?: string
  betaHeader?: string
}

export async function callClaude(
  apiKey: string,
  messages: ClaudeMessage[],
  options: ClaudeOptions = {}
): Promise<string | null> {
  const {
    model = 'claude-haiku-4-5-20251001',
    maxTokens = 500,
    system,
    betaHeader,
  } = options

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': ANTHROPIC_VERSION,
  }
  if (betaHeader) headers['anthropic-beta'] = betaHeader

  const body: Record<string, unknown> = { model, max_tokens: maxTokens, messages }
  if (system) body.system = system

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })
    const data = await res.json()
    return data?.content?.[0]?.text?.trim() ?? null
  } catch {
    return null
  }
}
