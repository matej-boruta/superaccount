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
  rule_scope: string
  ico: string | null
  dodavatel_pattern: string | null
  name_suplier: string | null
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
  typ_platby: string | null
  confidence: number
  zdroj: string
  poznamka: string | null
  zdroj_tabulky: 'pravidla' | 'ucetni_pravidla' | 'ucetni_vzory'
}

export type AgentLogEntry = {
  typ: 'plan' | 'rozhodnuti' | 'korekce' | 'eskalace' | 'chyba' | 'validace' | 'handoff' | 'rule_update' | 'incident'
  agent_id?: 'accountant' | 'auditor' | 'orchestrator' | 'pm' | 'human'
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
  const scopeFilter = typ ? `&rule_scope=eq.${encodeURIComponent(typ)}` : `&rule_scope=eq.predkontace`

  // ICO přesná shoda
  if (ico) {
    const res = await fetch(
      `${SB_URL}/rest/v1/pravidla?ico=eq.${encodeURIComponent(ico)}&aktivni=eq.true${scopeFilter}&order=confidence.desc&limit=1`,
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
    `${SB_URL}/rest/v1/pravidla?aktivni=eq.true&rule_scope=eq.predkontace&dodavatel_pattern=not.is.null&order=confidence.desc&limit=200`,
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
    rule_scope: String(r.rule_scope ?? 'predkontace'),
    ico: r.ico as string | null,
    dodavatel_pattern: r.dodavatel_pattern as string | null,
    name_suplier: r.name_suplier as string | null,
    kategorie_id: r.kategorie_id as number | null,
    md_ucet: r.md_ucet as string | null,
    dal_ucet: r.dal_ucet as string | null,
    md_dph: null,
    dal_dph: null,
    sazba_dph: r.sazba_dph as number | null,
    auto_schvalit: (r.confidence as number ?? 0) >= 90,
    auto_parovat: String(r.rule_scope) === 'parovani',
    limit_auto_kc: Number(r.limit_kc ?? 50000),
    parovat_keyword: r.keyword as string | null,
    typ_platby: r.typ_platby as string | null,
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
    rule_scope: 'predkontace',
    ico: r.ico as string | null,
    dodavatel_pattern: (r.dodavatel_pattern ?? r.dodavatel) as string | null,
    name_suplier: (r.name_suplier ?? null) as string | null,
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
    typ_platby: (r.typ_platby ?? null) as string | null,
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
    rule_scope: String(v.typ_dokladu ?? 'predkontace'),
    ico: v.ico as string | null,
    dodavatel_pattern: v.dodavatel as string | null,
    name_suplier: null,
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
    typ_platby: null,
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

// ─── Zápis do decisions ──────────────────────────────────────────────────────

export type DecisionEntry = {
  case_id?: number | null
  agent_id: 'accountant' | 'auditor' | 'orchestrator' | 'human'
  decision_type: 'predkontace' | 'parovani' | 'klasifikace' | 'dph' | 'audit'
  recommendation_json: Record<string, unknown>
  input_data_json?: Record<string, unknown>
  rules_applied_json?: Record<string, unknown> | null
  decision_confidence: number   // 0–1
  autonomy_confidence?: number  // 0–1
  status: 'created' | 'pending_audit' | 'pending_human_approval' | 'approved' | 'approved_with_edit' | 'rejected' | 'needs_rework' | 'executed'
}

/** Zapíše rozhodnutí do tabulky decisions. Vrací id pro případné navázání feedbacku. */
export async function writeDecision(entry: DecisionEntry): Promise<number | null> {
  try {
    const res = await fetch(`${SB_URL}/rest/v1/decisions`, {
      method: 'POST',
      headers: { ...SB(), 'Content-Type': 'application/json', Prefer: 'return=representation' },
      body: JSON.stringify({
        case_id: entry.case_id ?? null,
        agent_id: entry.agent_id,
        version: 1,
        decision_type: entry.decision_type,
        recommendation_json: entry.recommendation_json,
        input_data_json: entry.input_data_json ?? {},
        rules_applied_json: entry.rules_applied_json ?? null,
        decision_confidence: entry.decision_confidence,
        autonomy_confidence: entry.autonomy_confidence ?? entry.decision_confidence,
        status: entry.status,
      }),
    })
    if (!res.ok) return null
    const [row] = await res.json()
    return row?.id ?? null
  } catch {
    return null
  }
}

// ─── Zápis do agent_log ───────────────────────────────────────────────────────

export async function logDecision(entry: AgentLogEntry): Promise<void> {
  // Posílej jen sloupce, které v tabulce existují (extra pole způsobují PGRST204)
  const payload: Record<string, unknown> = {
    typ: entry.typ,
    agent_id: entry.agent_id,
    vstup: entry.vstup,
    vystup: entry.vystup,
    confidence: entry.confidence,
    pravidlo_zdroj: entry.pravidlo_zdroj,
  }
  if (entry.faktura_id != null) payload.faktura_id = entry.faktura_id
  if (entry.transakce_id != null) payload.transakce_id = entry.transakce_id
  try {
    await fetch(`${SB_URL}/rest/v1/agent_log`, {
      method: 'POST',
      headers: { ...SB(), 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify(payload),
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

/**
 * Upraví confidence pravidla o delta (kladné = posílení, záporné = oslabení).
 * Clamp: 10–95. Pokud confidence přesáhne 90 → nastaví pocet_pouziti+1 a poznamku.
 * Vrací novou confidence nebo null pokud pravidlo nenalezeno.
 */
export async function adjustPravidloConfidence(pravidloId: number, delta: number, poznamka?: string): Promise<number | null> {
  try {
    const res = await fetch(`${SB_URL}/rest/v1/pravidla?id=eq.${pravidloId}&select=id,confidence,pocet_pouziti,aktivni`, {
      headers: SB(),
    })
    const [p] = await res.json().catch(() => [])
    if (!p) return null

    const newConf = Math.max(10, Math.min(95, Number(p.confidence) + delta))
    if (newConf === Number(p.confidence)) return newConf  // žádná změna

    const patch: Record<string, unknown> = { confidence: newConf }
    if (delta > 0) patch.pocet_pouziti = (Number(p.pocet_pouziti ?? 0) + 1)
    if (poznamka) patch.poznamka = poznamka

    await fetch(`${SB_URL}/rest/v1/pravidla?id=eq.${pravidloId}`, {
      method: 'PATCH',
      headers: { ...SB(), 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify(patch),
    })
    return newConf
  } catch {
    return null
  }
}

export async function savePravidlo(p: NovePravidlo): Promise<void> {
  // Nejdřív zkontroluj zda pravidlo pro tohoto dodavatele+typ již existuje
  const existing = await findBestPravidlo(p.dodavatel, p.ico ?? null, p.typ)
  if (existing?.id) {
    // Pravidlo existuje — jen zvýš confidence pokud nové je vyšší
    if ((p.confidence ?? 0) > existing.confidence) {
      await adjustPravidloConfidence(existing.id, p.confidence - existing.confidence, p.poznamka ?? undefined)
    }
    return
  }

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
