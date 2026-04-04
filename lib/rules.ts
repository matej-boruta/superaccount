/**
 * lib/rules.ts
 *
 * Přístup agenta k paměti (ucetni_pravidla, ucetni_vzory) a audit trail (agent_log).
 *
 * Pořadí hledání pravidla:
 *   1. ucetni_pravidla — manuální pravidla (confidence 90–100)
 *   2. ucetni_vzory    — pravidla naučená z historie (confidence 50–84)
 */

const SB_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SB_KEY = process.env.SUPABASE_SERVICE_KEY!

const SB = () => ({
  apikey: SB_KEY,
  Authorization: `Bearer ${SB_KEY}`,
})

// ─── Typy ────────────────────────────────────────────────────────────────────

export type Pravidlo = {
  id: number
  typ: string
  ico: string | null
  dodavatel_pattern: string | null
  kategorie_id: number | null
  md_ucet: string | null
  dal_ucet: string | null
  md_dph: string | null
  dal_dph: string | null
  sazba_dph: number | null
  auto_schvalit: boolean
  auto_parovat: boolean
  limit_auto_kc: number
  parovat_keyword: string | null
  confidence: number
  zdroj: string
  poznamka: string | null
  zdroj_tabulky: 'pravidla' | 'ucetni_pravidla' | 'ucetni_vzory'
}

export type AgentLogEntry = {
  typ: 'plan' | 'rozhodnuti' | 'korekce' | 'eskalace' | 'chyba' | 'validace' | 'handoff' | 'rule_update' | 'incident'
  agent_id?: 'accountant' | 'auditor' | 'architect' | 'orchestrator' | 'pm' | 'human'
  vstup: Record<string, unknown>
  vystup: Record<string, unknown>
  confidence: number
  pravidlo_zdroj: string
  faktura_id?: number
  transakce_id?: number
  // Handoff metadata — kdo má převzít a co udělat
  to_agent?: string
  recommended_action?: string
  create_task?: boolean
}

// ─── Hledání pravidla ─────────────────────────────────────────────────────────

/**
 * Najde nejlepší pravidlo pro dodavatele.
 * Priorita: ICO přesná shoda > dodavatel_pattern ILIKE
 * Tabulky v pořadí:
 *   1. ucetni_pravidla (manual, confidence 90-100)
 *   2. dodavatel_pravidla (legacy/learned per-supplier rules, confidence 80)
 *   3. ucetni_vzory (history patterns, confidence 50-84)
 */
export async function findBestPravidlo(
  dodavatel: string,
  ico: string | null,
  typ?: string
): Promise<Pravidlo | null> {
  return findInPravidla(dodavatel, ico, typ)
}

async function findInPravidla(
  dodavatel: string,
  ico: string | null,
  typ?: string
): Promise<Pravidlo | null> {
  const typFilter = typ ? `&typ=eq.${encodeURIComponent(typ)}` : ''

  // ICO přesná shoda (scope=ico má nejvyšší prioritu)
  if (ico) {
    const res = await fetch(
      `${SB_URL}/rest/v1/pravidla?ico=eq.${encodeURIComponent(ico)}&aktivni=eq.true${typFilter}&order=confidence.desc&limit=1`,
      { headers: SB() }
    )
    const rows = await res.json()
    if (Array.isArray(rows) && rows[0]) {
      incrementPocetPouziti(rows[0].id as number)
      return mapPravidlo(rows[0])
    }
  }

  // Pattern match — načti všechna aktivní s pattern, porovnej v JS
  const res = await fetch(
    `${SB_URL}/rest/v1/pravidla?aktivni=eq.true&dodavatel_pattern=not.is.null${typFilter}&order=confidence.desc&limit=200`,
    { headers: SB() }
  )
  const rows = await res.json()
  if (!Array.isArray(rows)) return null

  const upper = dodavatel.toUpperCase()
  const match = rows.find((r: Record<string, unknown>) => {
    const pat = String(r.dodavatel_pattern || '').replace(/%/g, '').toUpperCase()
    return pat && upper.includes(pat)
  })
  if (match) {
    incrementPocetPouziti(match.id as number)
    return mapPravidlo(match as Record<string, unknown>)
  }
  return null
}

function incrementPocetPouziti(pravidloId: number): void {
  // Fire-and-forget read+write (PostgREST nepodporuje server-side aritmetiku)
  ;(async () => {
    try {
      const r = await fetch(`${SB_URL}/rest/v1/pravidla?id=eq.${pravidloId}&select=pocet_pouziti`, { headers: SB() })
      const rows = await r.json()
      const current = Number(rows[0]?.pocet_pouziti ?? 0)
      await fetch(`${SB_URL}/rest/v1/pravidla?id=eq.${pravidloId}`, {
        method: 'PATCH',
        headers: { ...SB(), 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({ pocet_pouziti: current + 1 }),
      })
    } catch { /* non-blocking */ }
  })()
}

function mapPravidlo(r: Record<string, unknown>): Pravidlo {
  return {
    id: r.id as number,
    typ: String(r.typ ?? 'predkontace'),
    ico: r.ico as string | null,
    dodavatel_pattern: r.dodavatel_pattern as string | null,
    kategorie_id: r.kategorie_id as number | null,
    md_ucet: r.md_ucet as string | null,
    dal_ucet: r.dal_ucet as string | null,
    md_dph: null,
    dal_dph: null,
    sazba_dph: r.sazba_dph as number | null,
    auto_schvalit: (r.confidence as number ?? 0) >= 90,
    auto_parovat: String(r.typ) === 'parovani',
    limit_auto_kc: Number(r.limit_kc ?? 50000),
    parovat_keyword: r.keyword as string | null,
    confidence: Number(r.confidence ?? 70),
    zdroj: String(r.zdroj ?? 'manual'),
    poznamka: r.poznamka as string | null,
    zdroj_tabulky: 'pravidla',
  }
}

async function findInUcetniPravidla(
  dodavatel: string,
  ico: string | null,
  typ?: string
): Promise<Pravidlo | null> {
  // Allow rules with matching typ OR rules with null typ (generic rules)
  const typFilter = typ
    ? `&or=(typ.eq.${encodeURIComponent(typ)},typ.is.null)`
    : '&typ=in.(predkontace,schvaleni)'

  // Přesná shoda ICO
  if (ico) {
    const res = await fetch(
      `${SB_URL}/rest/v1/ucetni_pravidla?ico=eq.${encodeURIComponent(ico)}&aktivni=eq.true${typFilter}&order=confidence.desc&limit=1`,
      { headers: SB() }
    )
    const rows: Pravidlo[] = await res.json()
    if (rows[0]) return { ...rows[0], zdroj_tabulky: 'ucetni_pravidla' }
  }

  // Pattern match na název dodavatele
  const encoded = encodeURIComponent(dodavatel)
  const res = await fetch(
    `${SB_URL}/rest/v1/ucetni_pravidla?dodavatel_pattern=not.is.null&aktivni=eq.true${typFilter}&order=confidence.desc&limit=20`,
    { headers: SB() }
  )
  const rows: Pravidlo[] = await res.json()

  const match = rows.find(r =>
    r.dodavatel_pattern && dodavatel.toLowerCase().includes(r.dodavatel_pattern.replace(/%/g, '').toLowerCase())
  )
  return match ? { ...match, zdroj_tabulky: 'ucetni_pravidla' } : null
}

/**
 * Hledá v dodavatel_pravidla — tabulce naučených pravidel per dodavatel.
 * Tato tabulka je hlavním zdrojem pro "co jsme se naučili" o dodavatelích.
 */
async function findInDodavatelPravidla(
  dodavatel: string,
  ico: string | null
): Promise<Pravidlo | null> {
  // Přesná shoda ICO
  if (ico) {
    const res = await fetch(
      `${SB_URL}/rest/v1/dodavatel_pravidla?ico=eq.${encodeURIComponent(ico)}&kategorie_id=not.is.null&limit=1`,
      { headers: SB() }
    )
    const rows = await res.json()
    if (Array.isArray(rows) && rows[0]) return mapDodavatelPravidlo(rows[0])
  }

  // Pattern match — load all with pattern, match in JS (seřazeno podle délky = specifičnosti)
  const res = await fetch(
    `${SB_URL}/rest/v1/dodavatel_pravidla?kategorie_id=not.is.null&limit=200`,
    { headers: SB() }
  )
  const rows = await res.json()
  if (!Array.isArray(rows)) return null

  const upper = dodavatel.toUpperCase()
  const sorted = [...rows].sort((a: Record<string, unknown>, b: Record<string, unknown>) =>
    String(b.dodavatel_pattern || b.dodavatel || '').length -
    String(a.dodavatel_pattern || a.dodavatel || '').length
  )
  const match = sorted.find((r: Record<string, unknown>) => {
    const p = String(r.dodavatel_pattern || r.dodavatel || '').replace(/%/g, '').toUpperCase()
    return p && upper.includes(p)
  })
  return match ? mapDodavatelPravidlo(match as Record<string, unknown>) : null
}

function mapDodavatelPravidlo(r: Record<string, unknown>): Pravidlo {
  return {
    id: r.id as number,
    typ: 'predkontace',
    ico: r.ico as string | null,
    dodavatel_pattern: (r.dodavatel_pattern ?? r.dodavatel) as string | null,
    kategorie_id: r.kategorie_id as number | null,
    md_ucet: (r.md_ucet ?? null) as string | null,
    dal_ucet: (r.dal_ucet ?? null) as string | null,
    md_dph: null,
    dal_dph: null,
    sazba_dph: null,
    auto_schvalit: Boolean(r.auto_schvalit),
    auto_parovat: Boolean(r.auto_parovat),
    limit_auto_kc: Number(r.limit_auto_kc ?? 50000),
    parovat_keyword: (r.parovat_keyword ?? null) as string | null,
    confidence: 80,
    zdroj: 'dodavatel_pravidla',
    poznamka: null,
    zdroj_tabulky: 'ucetni_pravidla',
  }
}

async function findInUcetniVzory(
  dodavatel: string,
  ico: string | null,
  typ?: string
): Promise<Pravidlo | null> {
  const typFilter = typ ? `&typ_dokladu=eq.${encodeURIComponent(typ)}` : ''

  // Přesná shoda ICO
  if (ico) {
    const res = await fetch(
      `${SB_URL}/rest/v1/ucetni_vzory?ico=eq.${encodeURIComponent(ico)}${typFilter}&order=confidence.desc&limit=1`,
      { headers: SB() }
    )
    const rows = await res.json()
    if (Array.isArray(rows) && rows[0]) return mapVzor(rows[0])
  }

  // Přesná shoda jména
  const res = await fetch(
    `${SB_URL}/rest/v1/ucetni_vzory?dodavatel=ilike.${encodeURIComponent(dodavatel)}${typFilter}&order=confidence.desc&limit=1`,
    { headers: SB() }
  )
  const rows = await res.json()
  if (Array.isArray(rows) && rows[0]) return mapVzor(rows[0])

  return null
}

function mapVzor(v: Record<string, unknown>): Pravidlo {
  return {
    id: v.id as number,
    typ: String(v.typ_dokladu ?? 'predkontace'),
    ico: v.ico as string | null,
    dodavatel_pattern: v.dodavatel as string | null,
    kategorie_id: v.kategorie_id as number | null,
    md_ucet: v.md_ucet as string | null,
    dal_ucet: v.dal_ucet as string | null,
    md_dph: v.md_dph as string | null,
    dal_dph: v.dal_dph as string | null,
    sazba_dph: v.sazba_dph as number | null,
    auto_schvalit: Boolean(v.auto_schvalit),
    auto_parovat: Boolean(v.auto_parovat),
    limit_auto_kc: Number(v.limit_auto_kc ?? 50000),
    parovat_keyword: v.parovat_keyword as string | null,
    confidence: Number(v.confidence ?? 70),
    zdroj: String(v.zdroj ?? 'history'),
    poznamka: v.poznamka as string | null,
    zdroj_tabulky: 'ucetni_vzory',
  }
}

// ─── Feedback mezi agenty ────────────────────────────────────────────────────
// Každý feedback odpovídá na: co se pokazilo / proč / kdo řeší / co udělá

export type FeedbackAction =
  | 'fix_case' | 'create_rule' | 'update_rule' | 'weaken_rule' | 'archive_rule'
  | 'update_prompt' | 'change_flow' | 'reroute_case' | 'create_task' | 'incident_stop' | 'retry_fallback'

export type FeedbackEntry = {
  trigger: string                    // co se stalo
  from_agent: string                 // kdo posílá
  to_agent: string                   // kdo zpracuje
  issue: string                      // popis problému
  action: FeedbackAction             // co se má stát
  priority: 'low' | 'medium' | 'high' | 'critical'
  context: Record<string, unknown>   // data k problému
}

export async function writeFeedback(entry: FeedbackEntry): Promise<void> {
  try {
    await fetch(`${SB_URL}/rest/v1/agent_log`, {
      method: 'POST',
      headers: { ...SB(), 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({
        typ: 'feedback',
        agent_id: entry.from_agent,
        vstup: { ...entry, processed: false },
        vystup: null,
        confidence: entry.priority === 'critical' ? 95 : entry.priority === 'high' ? 80 : entry.priority === 'medium' ? 65 : 50,
      }),
    })
  } catch {
    // feedback zápis nesmí blokovat hlavní operaci
  }
}

// ─── Zápis do rozodnuti ──────────────────────────────────────────────────────

export type RozhodnutiEntry = {
  entity_type: 'faktura' | 'transakce' | 'pravidlo' | 'system'
  entity_id?: number | null
  faktura_id?: number | null
  transakce_id?: number | null
  typ: 'kategorizace' | 'parovani' | 'predkontace' | 'validace' | 'eskalace' | 'korekce'
  agent: 'accountant' | 'auditor' | 'architect' | 'orchestrator' | 'human'
  pravidlo_id?: number | null
  navrh: Record<string, unknown>
  confidence: number
  stav: 'proposed' | 'review_required' | 'accepted' | 'rejected' | 'escalated'
  zdroj: string
}

export async function writeRozhodnuti(entry: RozhodnutiEntry): Promise<void> {
  try {
    await fetch(`${SB_URL}/rest/v1/rozhodnuti`, {
      method: 'POST',
      headers: { ...SB(), 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify(entry),
    })
  } catch {
    // rozodnuti zápis nesmí blokovat hlavní operaci
  }
}

// ─── Zápis do agent_log ───────────────────────────────────────────────────────

export async function logDecision(entry: AgentLogEntry): Promise<void> {
  try {
    await fetch(`${SB_URL}/rest/v1/agent_log`, {
      method: 'POST',
      headers: { ...SB(), 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify(entry),
    })
  } catch {
    // agent_log je audit trail — chyba zápisu nesmí blokovat hlavní operaci
  }
}

// ─── Uložení nového pravidla (korekce nebo learning) ─────────────────────────

export type NovePravidlo = {
  typ: string
  dodavatel: string
  ico?: string | null
  kategorie_id?: number | null
  md_ucet?: string | null
  dal_ucet?: string | null
  sazba_dph?: number | null
  auto_schvalit?: boolean
  auto_parovat?: boolean
  limit_auto_kc?: number
  parovat_keyword?: string | null
  confidence: number
  zdroj: 'manual' | 'agent' | 'history' | 'cross_company' | 'rule_proposal_pending'
  poznamka?: string | null
}

export async function savePravidlo(p: NovePravidlo): Promise<void> {
  const payload = {
    typ: p.typ,
    dodavatel_pattern: p.dodavatel,
    ico: p.ico ?? null,
    kategorie_id: p.kategorie_id ?? null,
    md_ucet: p.md_ucet ?? null,
    dal_ucet: p.dal_ucet ?? null,
    sazba_dph: p.sazba_dph ?? null,
    keyword: p.parovat_keyword ?? null,
    limit_kc: p.limit_auto_kc ?? 50000,
    confidence: p.confidence,
    zdroj: p.zdroj === 'history' ? 'agent' : (p.zdroj === 'rule_proposal_pending' ? 'manual' : p.zdroj),
    poznamka: p.poznamka ?? null,
    aktivni: true,
  }

  await fetch(`${SB_URL}/rest/v1/pravidla`, {
    method: 'POST',
    headers: { ...SB(), 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(payload),
  })
}
