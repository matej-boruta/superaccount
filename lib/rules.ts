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
  zdroj_tabulky: 'ucetni_pravidla' | 'ucetni_vzory'
}

export type AgentLogEntry = {
  typ: 'plan' | 'rozhodnuti' | 'korekce' | 'eskalace' | 'chyba'
  vstup: Record<string, unknown>
  vystup: Record<string, unknown>
  confidence: number
  pravidlo_zdroj: string
  faktura_id?: number
  transakce_id?: number
}

// ─── Hledání pravidla ─────────────────────────────────────────────────────────

/**
 * Najde nejlepší pravidlo pro dodavatele.
 * Priorita: ICO přesná shoda > dodavatel_pattern ILIKE
 * Tabulky v pořadí: ucetni_pravidla (manual) → ucetni_vzory (history)
 */
export async function findBestPravidlo(
  dodavatel: string,
  ico: string | null,
  typ?: string
): Promise<Pravidlo | null> {
  // 1. ucetni_pravidla — manuální pravidla
  const pravidlo = await findInUcetniPravidla(dodavatel, ico, typ)
  if (pravidlo) return pravidlo

  // 2. ucetni_vzory — naučená z historie
  const vzor = await findInUcetniVzory(dodavatel, ico, typ)
  if (vzor) return vzor

  return null
}

async function findInUcetniPravidla(
  dodavatel: string,
  ico: string | null,
  typ?: string
): Promise<Pravidlo | null> {
  const typFilter = typ ? `&typ=eq.${encodeURIComponent(typ)}` : '&typ=in.(predkontace,schvaleni)'

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
    auto_schvalit: p.auto_schvalit ?? false,
    auto_parovat: p.auto_parovat ?? false,
    limit_auto_kc: p.limit_auto_kc ?? 50000,
    parovat_keyword: p.parovat_keyword ?? null,
    confidence: p.confidence,
    zdroj: p.zdroj,
    poznamka: p.poznamka ?? null,
    aktivni: true,
  }

  await fetch(`${SB_URL}/rest/v1/ucetni_pravidla`, {
    method: 'POST',
    headers: { ...SB(), 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(payload),
  })
}
