import { NextResponse } from 'next/server'
import { callClaude, SYSTEM_AUDIT } from '@/lib/claude'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY!
const ABRA_URL = process.env.ABRA_URL!
const ABRA_USER = process.env.ABRA_USER!
const ABRA_PASS = process.env.ABRA_PASS!
const ABRA_AUTH = 'Basic ' + Buffer.from(`${ABRA_USER}:${ABRA_PASS}`).toString('base64')
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY!

const SB_HEADERS = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
  Prefer: 'return=minimal',
}

async function fetchSbData(): Promise<{
  nova: number
  schvalena: number
  zaplacena: number
  zamitnuta: number
  sparovanoTransakce: number
  // Faktury that should have FP- record in ABRA (zaplacena OR schvalena)
  fakturyVAbra: { id: number; dodavatel: string; castka_s_dph: number; stav: string }[]
}> {
  const [fakturyRes, transakceRes] = await Promise.all([
    fetch(`${SUPABASE_URL}/rest/v1/faktury?select=id,stav,dodavatel,castka_s_dph`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    }),
    fetch(`${SUPABASE_URL}/rest/v1/transakce?stav=eq.sparovano&select=id`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    }),
  ])

  const faktury: { id: number; stav: string; dodavatel: string; castka_s_dph: number }[] = await fakturyRes.json()
  const transakce: { id: number }[] = await transakceRes.json()

  const counts = { nova: 0, schvalena: 0, zaplacena: 0, zamitnuta: 0 }
  const fakturyVAbra: { id: number; dodavatel: string; castka_s_dph: number; stav: string }[] = []

  for (const r of faktury) {
    if (r.stav === 'nova') counts.nova++
    else if (r.stav === 'schvalena') { counts.schvalena++; fakturyVAbra.push(r) }
    else if (r.stav === 'zaplacena') { counts.zaplacena++; fakturyVAbra.push(r) }
    else if (r.stav === 'zamitnuta') counts.zamitnuta++
  }

  return { ...counts, sparovanoTransakce: transakce.length, fakturyVAbra }
}

async function fetchAbraData(): Promise<{
  fakturyFpCount: number
  fakturyFpKody: string[]
  bankaTotalCount: number
  duplicateBankaIds: string[]
}> {
  // Fetch FP-* faktury (our managed records)
  const faRes = await fetch(`${ABRA_URL}/faktura-prijata.json?fields=id,kod&limit=1000`, {
    headers: { Authorization: ABRA_AUTH },
  })
  const faData = await faRes.json()
  const fakturyAll: { id: string; kod: string }[] = faData?.winstrom?.['faktura-prijata'] ?? []
  const fakturyFpKody = fakturyAll.filter(f => f.kod?.startsWith('FP-')).map(f => f.kod)

  // Fetch ALL banka records with popis for duplicate detection
  const bkRes = await fetch(`${ABRA_URL}/banka.json?fields=id,popis&limit=2000`, {
    headers: { Authorization: ABRA_AUTH },
  })
  const bkData = await bkRes.json()
  const bankaAll: { id: string; popis: string }[] = bkData?.winstrom?.banka ?? []
  const bankaTotalCount = bankaAll.length

  // Find duplicate banka records: group by popis prefix "Platba FP-{id}-{year} T{tid}"
  // New format: "Platba FP-123-2026 T456 - Dodavatel" — unique per transakce
  // Old format: "Platba FP-123-2026 - Dodavatel" — unique per faktura
  const popisByKey = new Map<string, string[]>()
  for (const b of bankaAll) {
    if (!b.popis?.startsWith('Platba FP-')) continue
    // Normalize key: extract up to first " - " or end
    const key = b.popis.replace(/ - .*$/, '').trim()
    const existing = popisByKey.get(key) ?? []
    existing.push(b.id)
    popisByKey.set(key, existing)
  }
  // Collect IDs to delete (all but the first occurrence per key)
  const duplicateBankaIds: string[] = []
  for (const ids of popisByKey.values()) {
    if (ids.length > 1) duplicateBankaIds.push(...ids.slice(1))
  }

  return { fakturyFpCount: fakturyFpKody.length, fakturyFpKody, bankaTotalCount, duplicateBankaIds }
}

export async function GET() {
  try {
    const [sb, abra] = await Promise.all([fetchSbData(), fetchAbraData()])

    // Auto-delete duplicate banka records in ABRA
    const deletedDuplicates: string[] = []
    const failedDeletions: { id: string; status: number; body: string }[] = []
    for (const dupId of abra.duplicateBankaIds) {
      const delRes = await fetch(`${ABRA_URL}/banka/${dupId}.json`, {
        method: 'DELETE',
        headers: { Authorization: ABRA_AUTH },
      })
      if (delRes.ok || delRes.status === 204 || delRes.status === 200) {
        deletedDuplicates.push(dupId)
      } else {
        const body = await delRes.text().catch(() => '')
        failedDeletions.push({ id: dupId, status: delRes.status, body: body.slice(0, 300) })
      }
    }

    const year = new Date().getFullYear()

    // Faktury that should be in ABRA (zaplacena + schvalena) but are missing
    const abraFakturySet = new Set(abra.fakturyFpKody)
    const missingInAbra = sb.fakturyVAbra.filter(f => {
      const expectedKod = `FP-${f.id}-${year}`
      return !abraFakturySet.has(expectedKod)
    })

    // ABRA FP records that have no matching SB faktura (zaplacena or schvalena)
    const sbVAbraIds = new Set(sb.fakturyVAbra.map(f => f.id))
    const orphanedInAbra = abra.fakturyFpKody.filter(kod => {
      const match = kod.match(/^FP-(\d+)-(\d+)$/)
      if (!match) return false
      const id = parseInt(match[1])
      const kodYear = parseInt(match[2])
      return kodYear === year && !sbVAbraIds.has(id)
    })

    const sbFakturyVAbra = sb.schvalena + sb.zaplacena
    const fakturyDiff = abra.fakturyFpCount - sbFakturyVAbra  // positive = extra in ABRA
    const bankaDiff = abra.bankaTotalCount - sb.sparovanoTransakce

    const reconciliationData = {
      sb: {
        nova: sb.nova,
        schvalena: sb.schvalena,
        zaplacena: sb.zaplacena,
        zamitnuta: sb.zamitnuta,
        faktury_v_abra: sbFakturyVAbra,  // schvalena + zaplacena
        sparovane_transakce: sb.sparovanoTransakce,
      },
      abra: {
        faktury_fp: abra.fakturyFpCount,
        banka_celkem: abra.bankaTotalCount - deletedDuplicates.length,  // after cleanup
        duplicity_smazany: deletedDuplicates.length,
      },
      shoda: {
        faktury_ok: fakturyDiff === 0,
        faktury_diff: fakturyDiff,
        banka_ok: Math.abs(bankaDiff - deletedDuplicates.length) <= 5,
        banka_diff: bankaDiff - deletedDuplicates.length,
      },
      rozdily: {
        chybejici_v_abra: missingInAbra.map(f => ({
          id: f.id,
          dodavatel: f.dodavatel,
          stav: f.stav,
          castka: f.castka_s_dph,
          ocekavany_kod: `FP-${f.id}-${year}`,
        })),
        osirelé_v_abra: orphanedInAbra,
      },
    }

    const auditPrompt = `Proveď reconciliation účetnictví. Data:

${JSON.stringify(reconciliationData, null, 2)}

Pravidla pro hodnocení:
- ABRA FP záznamy musí sedět s (zaplacena + schvalena) faktury v SB — tolerance 0
- ABRA banka záznamy musí přibližně sedět s počtem spárovaných transakcí v SB — tolerance ±5 (duplicity z minulosti)
- Faktury chybějící v ABRA = KRITICKÁ chyba
- Osiřelé FP záznamy v ABRA = KRITICKÁ chyba (možné duplicity)
- Velký rozdíl banka (> 50) = VAROVÁNÍ (staré duplicity před opravou idempotency)

Vrať JSON ve formátu pro reconciliation report.`

    const auditJson = await callClaude(
      ANTHROPIC_API_KEY,
      [{ role: 'user', content: auditPrompt }],
      { model: 'claude-sonnet-4-6', maxTokens: 1000, system: SYSTEM_AUDIT }
    )

    let auditResult: Record<string, unknown> | null = null
    if (auditJson) {
      try {
        auditResult = JSON.parse(auditJson)
      } catch {
        auditResult = { raw: auditJson }
      }
    }

    await fetch(`${SUPABASE_URL}/rest/v1/agent_log`, {
      method: 'POST',
      headers: { ...SB_HEADERS, Prefer: 'return=minimal' },
      body: JSON.stringify({
        typ: auditResult && (auditResult as { ok?: boolean }).ok === false ? 'reconciliation_chyba' : 'reconciliation_ok',
        zprava: JSON.stringify({ data: reconciliationData, audit: auditResult }),
        created_at: new Date().toISOString(),
      }),
    })

    return NextResponse.json({
      data: reconciliationData,
      audit: auditResult,
      deleted_duplicates: deletedDuplicates,
      diagnostic: {
        banka_fp_zaznamy: abra.duplicateBankaIds.length + deletedDuplicates.length,
        duplicates_found: abra.duplicateBankaIds.length,
        deleted: deletedDuplicates.length,
        failed: failedDeletions,
      },
    })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
