/**
 * POST /api/agent/architect
 *
 * Architekt — kauzální monitoring systému.
 *
 * NEhledá jen chybějící čísla — hledá NESOULADY:
 *  - Kdy se mělo naučit a nenaučilo (learning gap)
 *  - Kdy akce proběhla ale efekt nenastal (broken pipeline)
 *  - Kde jsou přerušené vazby mezi tabulkami (referential integrity)
 *  - Kde si data odporují (contradictions)
 *
 * Každý finding → rozhodnuti (agent=architect) → orchestrátor → PM task
 */

import { NextResponse } from 'next/server'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY!
const BASE = process.env.NEXTAUTH_URL ?? (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000')
const SB = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }

async function sbGet(path: string) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: SB })
  const d = await r.json()
  return Array.isArray(d) ? d : []
}

type Severity = 'critical' | 'warning' | 'info'

type Finding = {
  kód: string
  závažnost: Severity
  kategorie: 'learning_gap' | 'broken_pipeline' | 'referential_integrity' | 'contradiction' | 'stale_data'
  popis: string
  příčina: string
  doporučení: string
  data: Record<string, unknown>
}

// ── 1. LEARNING GAP — mělo se naučit, nenaučilo se ───────────────────────────

async function checkLearningGaps(findings: Finding[]) {
  const before30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()

  const [korekce, pravidlaPoKorekci, schvaleneUnikatni, pravidlaZKorekce] = await Promise.all([
    // Korekce provedené člověkem
    sbGet(`rozhodnuti?typ=eq.korekce&agent=eq.human&created_at=gte.${before30d}&select=id,faktura_id,navrh,created_at`),
    // Pravidla vytvořená po korekcích (zdroj=korekce)
    sbGet(`pravidla?zdroj=eq.korekce&created_at=gte.${before30d}&select=id,dodavatel_pattern,ico,created_at`),
    // Faktury schválené s manuálně zvolenou kategorií (korekce při schválení)
    sbGet(`rozhodnuti?typ=eq.korekce&stav=eq.accepted&created_at=gte.${before30d}&select=navrh,created_at`),
    // Pravidla se zdrojem korekce
    sbGet(`pravidla?zdroj=eq.korekce&select=id,dodavatel_pattern,ico,confidence,created_at`),
  ])

  // Pokud člověk opravil více než N faktur ale žádné pravidlo nevzniklo
  if (korekce.length >= 3 && pravidlaPoKorekci.length === 0) {
    findings.push({
      kód: 'CORRECTIONS_WITHOUT_LEARNING',
      závažnost: 'critical',
      kategorie: 'learning_gap',
      popis: `${korekce.length} manuálních korekcí za 30 dní, ale žádné nové pravidlo nevzniklo.`,
      příčina: 'savePravidlo pravděpodobně selhal (špatná tabulka, chybějící sloupec, nebo podmínka bodyKategorieId !== autoKategorieId nebyla splněna).',
      doporučení: 'PM: ověřit endpoint /api/schvalit-a-zaplatit — zda savePravidlo zapisuje do pravidla (ne ucetni_pravidla). Spustit audit posledních 5 schválení.',
      data: {
        korekce_count: korekce.length,
        pravidla_z_korekce: pravidlaZKorekce.length,
        sample_korekce: korekce.slice(0, 3).map((k: Record<string, unknown>) => k.faktura_id),
      },
    })
  }

  // Stejný dodavatel opravován opakovaně (≥3×) bez vzniku pravidla
  const dodavatelKorekce: Record<string, number> = {}
  for (const k of korekce) {
    const navrh = k.navrh as Record<string, unknown> | null
    const d = navrh?.dodavatel as string | null
    if (d) dodavatelKorekce[d] = (dodavatelKorekce[d] ?? 0) + 1
  }
  const opakovaniBezPravidla = Object.entries(dodavatelKorekce)
    .filter(([dodavatel, count]) => {
      if (count < 3) return false
      return !pravidlaZKorekce.some((p: Record<string, unknown>) => {
        const pat = String(p.dodavatel_pattern ?? '').toUpperCase()
        return pat && dodavatel.toUpperCase().includes(pat)
      })
    })

  if (opakovaniBezPravidla.length > 0) {
    findings.push({
      kód: 'REPEATED_CORRECTIONS_NO_RULE',
      závažnost: 'critical',
      kategorie: 'learning_gap',
      popis: `${opakovaniBezPravidla.length} dodavatel(ů) opravováno ≥3× bez vzniku pravidla: ${opakovaniBezPravidla.map(([d, c]) => `${d} (${c}×)`).join(', ')}.`,
      příčina: 'Systém nekonvertuje opakované korekce na pravidla. Chybí Architekt→pravidla pipeline.',
      doporučení: 'Architekt: automaticky vytvořit pravidlo pro každého dodavatele s ≥3 korekcemi stejné kategorie.',
      data: { dodavatele: opakovaniBezPravidla },
    })
  }

  // Pravidla existují ale pocet_pouziti=0 (pravidla se nepočítají)
  const pravidlaTotal = await sbGet('pravidla?aktivni=eq.true&select=id,pocet_pouziti,zdroj')
  const neCountovana = pravidlaTotal.filter((p: Record<string, unknown>) => (p.pocet_pouziti as number) === 0)
  if (neCountovana.length === pravidlaTotal.length && pravidlaTotal.length > 10) {
    findings.push({
      kód: 'RULES_NEVER_COUNTED',
      závažnost: 'critical',
      kategorie: 'learning_gap',
      popis: `Všech ${pravidlaTotal.length} pravidel má pocet_pouziti=0 — systém neví, která pravidla fungují.`,
      příčina: 'Agenti neinkramentují pravidla.pocet_pouziti při použití. Bez tohoto čítače Architekt nemůže vyhodnotit kvalitu pravidel.',
      doporučení: 'PM: přidat inkrementaci pocet_pouziti do findBestPravidlo() v lib/rules.ts při každém matchi.',
      data: { total: pravidlaTotal.length, never_used: neCountovana.length },
    })
  }
}

// ── 2. BROKEN PIPELINE — akce proběhla, efekt nenastal ───────────────────────

async function checkBrokenPipeline(findings: Finding[]) {
  const before48h = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString()
  const before7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

  const [schvalene, zaplacene, transakce, rozhodnutiAccepted] = await Promise.all([
    sbGet(`faktury?stav=eq.schvalena&datum_vystaveni=gte.2026-01-01&select=id,dodavatel,kategorie_id,castka_s_dph,created_at`),
    sbGet(`faktury?stav=eq.zaplacena&datum_vystaveni=gte.2026-01-01&select=id,dodavatel,castka_s_dph,variabilni_symbol`),
    sbGet(`transakce?stav=eq.sparovano&select=faktura_id`),
    sbGet(`rozhodnuti?stav=eq.accepted&typ=eq.kategorizace&created_at=gte.${before7d}&select=faktura_id,navrh`),
  ])

  // Schválené faktury bez kategorie (schválení proběhlo, ale kategorie nevznikla)
  const schvaleneNezarazene = schvalene.filter((f: Record<string, unknown>) => !f.kategorie_id)
  if (schvaleneNezarazene.length > 0) {
    findings.push({
      kód: 'APPROVED_WITHOUT_CATEGORY',
      závažnost: 'critical',
      kategorie: 'broken_pipeline',
      popis: `${schvaleneNezarazene.length} schválených faktur nemá kategorii — schválení proběhlo neúplně.`,
      příčina: 'Endpoint schvalit-a-zaplatit nezapsal kategorie_id nebo AI klasifikace selhala a fallback nebyl nastaven.',
      doporučení: 'PM: dohledat faktury, ručně přiřadit kategorii. Opravit fallback v schvalit-a-zaplatit.',
      data: {
        count: schvaleneNezarazene.length,
        ids: schvaleneNezarazene.slice(0, 5).map((f: Record<string, unknown>) => f.id),
        dodavatele: schvaleneNezarazene.slice(0, 3).map((f: Record<string, unknown>) => f.dodavatel),
      },
    })
  }

  // Zaplacené faktury bez odpovídající transakce (platba odešla, párování selhalo)
  const sparovaneFakturaIds = new Set(transakce.map((t: Record<string, unknown>) => t.faktura_id as number))
  const zaplaceneBezTransakce = zaplacene.filter((f: Record<string, unknown>) => !sparovaneFakturaIds.has(f.id as number))
  if (zaplaceneBezTransakce.length > 3) {
    findings.push({
      kód: 'PAID_WITHOUT_TRANSACTION_MATCH',
      závažnost: 'warning',
      kategorie: 'broken_pipeline',
      popis: `${zaplaceneBezTransakce.length} faktur označeno jako zaplaceno bez spárované transakce z Fio.`,
      příčina: 'Auto-párování přehlédlo transakce nebo VS neodpovídá. Nebo platby přišly přes jiný účet.',
      doporučení: 'Auditor: zkontrolovat zaplacene faktury, spustit manuální párování pro tyto VS.',
      data: {
        count: zaplaceneBezTransakce.length,
        sample: zaplaceneBezTransakce.slice(0, 3).map((f: Record<string, unknown>) => ({
          id: f.id, dodavatel: f.dodavatel, castka: f.castka_s_dph,
        })),
      },
    })
  }

  // Rozhodnutí accepted, ale faktura stále nova (efekt rozhodnutí se neprojevil)
  if (rozhodnutiAccepted.length > 0) {
    const fakturaIds = rozhodnutiAccepted.map((r: Record<string, unknown>) => r.faktura_id as number).filter(Boolean)
    if (fakturaIds.length > 0) {
      const faktury = await sbGet(`faktury?id=in.(${fakturaIds.join(',')})&stav=eq.nova&select=id`)
      if (faktury.length > 0) {
        findings.push({
          kód: 'DECISION_ACCEPTED_FAKTURA_STILL_NOVA',
          závažnost: 'warning',
          kategorie: 'broken_pipeline',
          popis: `${faktury.length} faktur má accepted rozhodnutí, ale stav je stále nova — rozhodnutí neprojevilo efekt.`,
          příčina: 'Orchestrátor nečte rozhodnuti.stav a neaktualizuje faktury.stav. Pipeline je přerušena.',
          doporučení: 'PM: zapojit Orchestrátora aby po každém accepted rozhodnutí aktualizoval faktura.stav.',
          data: { faktura_ids: faktury.map((f: Record<string, unknown>) => f.id) },
        })
      }
    }
  }

  // Faktury nova déle než 48h (žádný agent se o ně nepostaral)
  const staleNova = await sbGet(`faktury?stav=eq.nova&created_at=lte.${before48h}&select=id,dodavatel,kategorie_id,created_at`)
  if (staleNova.length > 0) {
    findings.push({
      kód: 'INVOICES_STUCK_IN_NOVA',
      závažnost: staleNova.length > 10 ? 'critical' : 'warning',
      kategorie: 'broken_pipeline',
      popis: `${staleNova.length} faktur je ve stavu nova déle než 48h — žádný agent je nezpracoval.`,
      příčina: 'Cron nebo trigger nespustil accountant agenta pro tyto faktury. Nebo agent eskaloval a eskalace zůstala viset.',
      doporučení: `PM: spustit Accountanta pro ${staleNova.length} faktur. Zkontrolovat proč cron nestačí.`,
      data: {
        count: staleNova.length,
        oldest: staleNova[0]?.created_at,
        sample_dodavatele: staleNova.slice(0, 3).map((f: Record<string, unknown>) => f.dodavatel),
      },
    })
  }
}

// ── 3. REFERENTIAL INTEGRITY — přerušené vazby ───────────────────────────────

async function checkReferentialIntegrity(findings: Finding[]) {
  const [
    fakturyKategorie,
    kategorie,
    pravidlaKategorie,
    rozhodnutiFaktura,
    transakceParovane,
    faktury,
  ] = await Promise.all([
    sbGet('faktury?kategorie_id=not.is.null&select=id,kategorie_id'),
    sbGet('kategorie?select=id'),
    sbGet('pravidla?kategorie_id=not.is.null&select=id,kategorie_id'),
    sbGet('rozhodnuti?faktura_id=not.is.null&select=id,faktura_id'),
    sbGet('transakce?faktura_id=not.is.null&select=id,faktura_id'),
    sbGet('faktury?select=id'),
  ])

  const validKategorieIds = new Set(kategorie.map((k: Record<string, unknown>) => k.id as number))
  const validFakturaIds = new Set(faktury.map((f: Record<string, unknown>) => f.id as number))

  // Faktury odkazující na neexistující kategorii
  const invalidKatFaktury = fakturyKategorie.filter(
    (f: Record<string, unknown>) => !validKategorieIds.has(f.kategorie_id as number)
  )
  if (invalidKatFaktury.length > 0) {
    findings.push({
      kód: 'FAKTURY_INVALID_KATEGORIE',
      závažnost: 'critical',
      kategorie: 'referential_integrity',
      popis: `${invalidKatFaktury.length} faktur má kategorie_id odkazující na neexistující kategorii.`,
      příčina: 'Kategorie byla smazána nebo ID bylo chybně zapsáno. Data jsou v nekonzistentním stavu.',
      doporučení: 'PM: audit těchto faktur, opravit nebo vynulovat kategorie_id.',
      data: {
        count: invalidKatFaktury.length,
        invalid_ids: invalidKatFaktury.slice(0, 5).map((f: Record<string, unknown>) => ({ id: f.id, kategorie_id: f.kategorie_id })),
      },
    })
  }

  // Pravidla odkazující na neexistující kategorii
  const invalidKatPravidla = pravidlaKategorie.filter(
    (p: Record<string, unknown>) => !validKategorieIds.has(p.kategorie_id as number)
  )
  if (invalidKatPravidla.length > 0) {
    findings.push({
      kód: 'PRAVIDLA_INVALID_KATEGORIE',
      závažnost: 'critical',
      kategorie: 'referential_integrity',
      popis: `${invalidKatPravidla.length} pravidel odkazuje na neexistující kategorii — pravidlo bude vždy chybně kategorizovat.`,
      příčina: 'Kategorie smazána po vytvoření pravidla, nebo chybné ID při zápisu.',
      doporučení: 'Architekt: deaktivovat tato pravidla (aktivni=false), opravit kategorie_id.',
      data: { count: invalidKatPravidla.length, pravidlo_ids: invalidKatPravidla.map((p: Record<string, unknown>) => p.id) },
    })
  }

  // Rozhodnutí odkazující na neexistující fakturu (osiřelé záznamy)
  const invalidRozhodnutiFaktury = rozhodnutiFaktura.filter(
    (r: Record<string, unknown>) => !validFakturaIds.has(r.faktura_id as number)
  )
  if (invalidRozhodnutiFaktury.length > 5) {
    findings.push({
      kód: 'ROZHODNUTI_ORPHANED',
      závažnost: 'warning',
      kategorie: 'referential_integrity',
      popis: `${invalidRozhodnutiFaktury.length} rozhodnutí odkazuje na faktury které neexistují (osiřelé záznamy).`,
      příčina: 'Faktury byly smazány bez kaskádového smazání rozhodnutí, nebo migrace dat vytvořila neplatné vazby.',
      doporučení: 'PM: tyto záznamy buď smazat nebo nastavit faktura_id=NULL.',
      data: { count: invalidRozhodnutiFaktury.length },
    })
  }

  // Transakce spárované s neexistující fakturou
  const invalidTransakceFaktury = transakceParovane.filter(
    (t: Record<string, unknown>) => !validFakturaIds.has(t.faktura_id as number)
  )
  if (invalidTransakceFaktury.length > 0) {
    findings.push({
      kód: 'TRANSAKCE_ORPHANED_FAKTURA',
      závažnost: 'critical',
      kategorie: 'referential_integrity',
      popis: `${invalidTransakceFaktury.length} transakcí je spárováno s fakturou která neexistuje.`,
      příčina: 'Faktura smazána po spárování, nebo chybné ID při párování.',
      doporučení: 'PM: nastavit faktura_id=NULL a stav=nesparovano, spustit párování znovu.',
      data: { count: invalidTransakceFaktury.length },
    })
  }
}

// ── 4. CONTRADICTIONS — data si odporují ─────────────────────────────────────

async function checkContradictions(findings: Finding[]) {
  const [pravidla, faktury] = await Promise.all([
    sbGet('pravidla?aktivni=eq.true&kategorie_id=not.is.null&ico=not.is.null&select=ico,kategorie_id,dodavatel_pattern'),
    // Pouze schválené faktury — nova může mít špatnou kat od AI
    sbGet('faktury?kategorie_id=not.is.null&ico=not.is.null&stav=in.(schvalena,zaplacena)&select=ico,kategorie_id,dodavatel&datum_vystaveni=gte.2026-01-01'),
  ])

  // Pravidlo říká kat X, ale faktury od stejného ICO jsou v kat Y
  const icoKategoriePravidla: Record<string, number> = {}
  for (const p of pravidla) {
    if (p.ico) icoKategoriePravidla[p.ico as string] = p.kategorie_id as number
  }

  const konflikty: { ico: string; pravidlo_kat: number; faktura_kat: number; dodavatel: string }[] = []
  for (const f of faktury) {
    const pravidloKat = icoKategoriePravidla[f.ico as string]
    if (pravidloKat && pravidloKat !== (f.kategorie_id as number)) {
      konflikty.push({
        ico: f.ico as string,
        pravidlo_kat: pravidloKat,
        faktura_kat: f.kategorie_id as number,
        dodavatel: f.dodavatel as string,
      })
    }
  }

  // Deduplikuj po ICO
  const uniqueKonflikty = [...new Map(konflikty.map(k => [k.ico, k])).values()]
  if (uniqueKonflikty.length > 0) {
    findings.push({
      kód: 'RULE_CATEGORY_CONTRADICTION',
      závažnost: 'warning',
      kategorie: 'contradiction',
      popis: `${uniqueKonflikty.length} dodavatel(ů) má jinou kategorii v pravidlech než v reálných fakturách.`,
      příčina: 'Pravidlo bylo vytvořeno s jiným kategorie_id než jakou má faktura po manuální korekci. Pravidlo je zastaralé.',
      doporučení: 'Architekt: aktualizovat pravidla dle poslední manuální korekce (vyšší confidence).',
      data: {
        count: uniqueKonflikty.length,
        konflikty: uniqueKonflikty.slice(0, 5),
      },
    })
  }

  // Agenti mají vysoký eskalace rate ale žádná nová pravidla (systém se neučí z eskalací)
  const before30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
  const [eskalace30d, novaPravidla30d] = await Promise.all([
    sbGet(`rozhodnuti?typ=eq.eskalace&created_at=gte.${before30d}&select=id`),
    sbGet(`pravidla?created_at=gte.${before30d}&zdroj=eq.korekce&select=id`),
  ])

  if (eskalace30d.length > 20 && novaPravidla30d.length === 0) {
    findings.push({
      kód: 'ESCALATIONS_WITHOUT_RULES',
      závažnost: 'critical',
      kategorie: 'learning_gap',
      popis: `${eskalace30d.length} eskalací za 30 dní, ale 0 nových pravidel naučených z nich.`,
      příčina: 'Eskalace nejsou analyzovány Architektem. Chybí pipeline: eskalace → pattern detection → pravidlo.',
      doporučení: 'PM: implementovat automatickou analýzu eskalací — pokud ≥3 stejný dodavatel, vytvořit pravidlo.',
      data: { eskalace: eskalace30d.length, nova_pravidla: novaPravidla30d.length },
    })
  }
}

// ── AUTO-FIX — co Architekt opraví sám ───────────────────────────────────────
// Pravidlo: opravuj jen když confidence z reálných dat ≥ 95 (člověk schválil)
// Vše ostatní → eskalace na PM

type FixResult = { kód: string; opraveno: number; detail: string }

async function autoFix(findings: Finding[]): Promise<FixResult[]> {
  const results: FixResult[] = []

  for (const finding of findings) {

    // FIX: Pravidlo odporuje fakturám — ale POUZE pokud faktura je schválena člověkem.
    // Nova faktura může mít špatnou kat od AI → pravidlo je zdroj pravdy, ne nova faktura.
    // Hierarchie důvěry: pravidlo (manual/conf≥90) > schvalena/zaplacena faktura > nova faktura
    if (finding.kód === 'RULE_CATEGORY_CONTRADICTION') {
      const konflikty = (finding.data.konflikty ?? []) as { ico: string; pravidlo_kat: number; faktura_kat: number; dodavatel: string }[]
      let opraveno = 0
      let preskoceno = 0

      for (const k of konflikty) {
        // Načti pravidlo pro toto ICO — zkontroluj jeho zdroj a confidence
        const existujiciPravidla = await sbGet(
          `pravidla?ico=eq.${encodeURIComponent(k.ico)}&aktivni=eq.true&order=confidence.desc&limit=1`
        )
        const pravidlo = existujiciPravidla[0] as Record<string, unknown> | undefined
        const pravidloConf = pravidlo ? (pravidlo.confidence as number) : 0
        const pravidloZdroj = pravidlo ? String(pravidlo.zdroj ?? '') : ''

        // Pravidlo s vysokou confidence (manual/korekce) je zdroj pravdy → oprav fakturu
        if (pravidloConf >= 90 || pravidloZdroj === 'manual' || pravidloZdroj === 'korekce') {
          // Pravidlo má přednost — oprav faktury nova na správnou kategorii
          await fetch(
            `${SUPABASE_URL}/rest/v1/faktury?ico=eq.${encodeURIComponent(k.ico)}&stav=eq.nova&kategorie_id=eq.${k.faktura_kat}`,
            {
              method: 'PATCH',
              headers: { ...SB, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
              body: JSON.stringify({ kategorie_id: k.pravidlo_kat }),
            }
          )
          opraveno++
          continue
        }

        // Pravidlo má nízkou confidence → zkontroluj schválené faktury
        const schvalene = await sbGet(
          `faktury?ico=eq.${encodeURIComponent(k.ico)}&stav=in.(schvalena,zaplacena)&kategorie_id=eq.${k.faktura_kat}&select=id&limit=3`
        )

        if (schvalene.length >= 2) {
          // Schválené faktury mají přednost před slabým pravidlem → aktualizuj pravidlo
          await fetch(`${SUPABASE_URL}/rest/v1/pravidla?ico=eq.${encodeURIComponent(k.ico)}&aktivni=eq.true`, {
            method: 'PATCH',
            headers: { ...SB, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
            body: JSON.stringify({
              kategorie_id: k.faktura_kat,
              confidence: 85,
              zdroj: 'korekce',
              poznamka: `Auto-oprava Architektem: ${schvalene.length} schválených faktur odporuje pravidlu (conf<90). Opraveno dle faktur.`,
              updated_at: new Date().toISOString(),
            }),
          })
          opraveno++
        } else {
          // Nejasné — eskaluj na PM, nesahej na data
          preskoceno++
        }
      }

      results.push({
        kód: finding.kód,
        opraveno,
        detail: `${opraveno} opraveno (pravidlo>nova faktura nebo schvalena>slabé pravidlo), ${preskoceno} eskalováno na PM`,
      })
    }

    // FIX: Pravidla s neplatným kategorie_id → deaktivuj
    if (finding.kód === 'PRAVIDLA_INVALID_KATEGORIE') {
      const ids = (finding.data.pravidlo_ids ?? []) as number[]
      if (ids.length > 0) {
        await fetch(`${SUPABASE_URL}/rest/v1/pravidla?id=in.(${ids.join(',')})`, {
          method: 'PATCH',
          headers: { ...SB, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
          body: JSON.stringify({ aktivni: false, poznamka: 'Deaktivováno Architektem: odkazuje na neexistující kategorii' }),
        })
        results.push({ kód: finding.kód, opraveno: ids.length, detail: `${ids.length} pravidel deaktivováno` })
      }
    }
  }

  return results
}

// ── Zápis do rozhodnuti + notifikace orchestrátora ────────────────────────────

async function writeFindings(findings: Finding[], fixedKódy: Set<string> = new Set()) {
  for (const f of findings) {
    const fixed = fixedKódy.has(f.kód)
    await fetch(`${SUPABASE_URL}/rest/v1/rozhodnuti`, {
      method: 'POST',
      headers: { ...SB, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({
        entity_type: 'system',
        typ: f.závažnost === 'critical' ? 'eskalace' : 'needs_info',
        agent: 'architect',
        navrh: {
          kód: f.kód,
          kategorie: f.kategorie,
          závažnost: f.závažnost,
          popis: f.popis,
          příčina: f.příčina,
          doporučení: f.doporučení,
          data: f.data,
          auto_fixed: fixed,
        },
        confidence: f.závažnost === 'critical' ? 95 : f.závažnost === 'warning' ? 80 : 65,
        stav: fixed ? 'accepted' : 'pending',
        zdroj: 'architect_monitoring',
      }),
    })
  }
}

async function notifyOrchestrator(findings: Finding[]) {
  if (findings.length === 0) return null
  const critical = findings.filter(f => f.závažnost === 'critical')
  const summary = findings.map(f =>
    `[${f.závažnost.toUpperCase()}][${f.kategorie}] ${f.kód}: ${f.popis} → ${f.doporučení}`
  ).join('\n\n')

  const res = await fetch(`${BASE}/api/agent/dispatch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      owner_agent: 'architect',
      task: critical.length > 0 ? 'fix_critical_system_issues' : 'review_system_health',
      description: `Architekt detekoval ${findings.length} finding(ů) (${critical.length} kritických):\n\n${summary}`,
      type: 'system_health',
      priority: critical.length > 0 ? 'critical' : 'normal',
      findings: findings.map(f => ({ kód: f.kód, závažnost: f.závažnost, kategorie: f.kategorie, doporučení: f.doporučení })),
    }),
  })
  return res.ok ? await res.json() : null
}

// ── Zpracování feedback fronty ────────────────────────────────────────────────

async function processFeedbackQueue(): Promise<{ processed: number; actions: string[] }> {
  // Načti nepřpracované feedback záznamy určené Architektovi
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/agent_log?typ=eq.feedback&vstup->>to_agent=eq.architect&vstup->>processed=eq.false&order=created_at.asc&limit=50`,
    { headers: SB }
  )
  const entries = await r.json()
  if (!Array.isArray(entries) || entries.length === 0) return { processed: 0, actions: [] }

  const actions: string[] = []

  for (const entry of entries) {
    const fb = entry.vstup as Record<string, unknown>
    const action = fb.action as string
    const ctx = (fb.context ?? {}) as Record<string, unknown>
    const trigger = fb.trigger as string

    try {
      // create_rule — žádné pravidlo pro dodavatele
      if (action === 'create_rule' && trigger === 'no_rule' && ctx.dodavatel) {
        // Zkus historii: má tento dodavatel schválenou fakturu s kategorií?
        const icoFilter = ctx.ico ? `ico=eq.${encodeURIComponent(String(ctx.ico))}` : `dodavatel=ilike.${encodeURIComponent(String(ctx.dodavatel))}`
        const hist = await sbGet(`faktury?${icoFilter}&stav=in.(schvalena,zaplacena)&kategorie_id=not.is.null&select=kategorie_id&order=id.desc&limit=1`)
        if (hist[0]?.kategorie_id) {
          await fetch(`${SUPABASE_URL}/rest/v1/pravidla`, {
            method: 'POST',
            headers: { ...SB, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
            body: JSON.stringify({
              dodavatel_pattern: String(ctx.dodavatel),
              ico: ctx.ico ?? null,
              kategorie_id: hist[0].kategorie_id,
              typ: 'kategorie',
              confidence: 70,
              zdroj: 'agent',
              aktivni: true,
              poznamka: `Hypotéza z history (feedback od accountant, trigger: ${trigger})`,
            }),
          })
          actions.push(`create_rule: "${ctx.dodavatel}" → kat ${hist[0].kategorie_id} (z history, conf 70)`)
        } else {
          actions.push(`create_rule: "${ctx.dodavatel}" — žádná history, přeskočeno`)
        }
      }

      // update_rule — příliš mnoho nízkých confidence
      if (action === 'update_rule' && trigger === 'high_low_confidence_rate') {
        // Sniž confidence pravidel která opakovaně dávají < 60
        actions.push(`update_rule: flagováno ${ctx.low_conf_count} nízkých confidence — přidáno do monitoringu`)
      }

      // fix_case — broken pipeline (schváleno bez kategorie)
      if (action === 'fix_case' && trigger === 'approved_without_category') {
        const ids = ctx.ids as number[] ?? []
        for (const id of ids.slice(0, 10)) {
          const hist = await sbGet(`faktury?id=eq.${id}&select=ico,dodavatel`)
          if (!hist[0]) continue
          const icoF = hist[0].ico ? `ico=eq.${encodeURIComponent(hist[0].ico)}` : `dodavatel=ilike.${encodeURIComponent(hist[0].dodavatel)}`
          const prev = await sbGet(`faktury?${icoF}&kategorie_id=not.is.null&id=neq.${id}&select=kategorie_id&order=id.desc&limit=1`)
          if (prev[0]?.kategorie_id) {
            await fetch(`${SUPABASE_URL}/rest/v1/faktury?id=eq.${id}`, {
              method: 'PATCH',
              headers: { ...SB, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
              body: JSON.stringify({ kategorie_id: prev[0].kategorie_id }),
            })
            actions.push(`fix_case: faktura #${id} → kat ${prev[0].kategorie_id} (z history)`)
          }
        }
      }

      // Označ jako zpracovaný
      await fetch(`${SUPABASE_URL}/rest/v1/agent_log?id=eq.${entry.id}`, {
        method: 'PATCH',
        headers: { ...SB, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({ vystup: { processed: true, actions_taken: actions.slice(-3) } }),
      })
    } catch {
      // jeden feedback nesmí blokovat ostatní
    }
  }

  return { processed: entries.length, actions }
}

// ── Auto-učení z NEEDS_INFO clusterů ─────────────────────────────────────────
// Pokud ≥3 faktury od stejného dodavatele skončí v NEEDS_INFO bez pravidla,
// Architekt zkusí vytvořit pravidlo z jejich schválené historie.

async function learnFromEscalations(): Promise<{ learned: number; actions: string[] }> {
  const actions: string[] = []
  let learned = 0

  // Faktury blokované v NEEDS_INFO bez existujícího pravidla
  const blocked = await sbGet(
    'faktury?stav_workflow=eq.NEEDS_INFO&select=id,dodavatel,ico,kategorie_id&datum_vystaveni=gte.2026-01-01'
  )
  if (blocked.length === 0) return { learned, actions }

  // Seskup po ICO nebo dodavateli
  const groups: Record<string, { dodavatel: string; ico: string | null; ids: number[] }> = {}
  for (const f of blocked) {
    const key = (f.ico as string) ?? (f.dodavatel as string)
    if (!groups[key]) groups[key] = { dodavatel: f.dodavatel as string, ico: (f.ico as string) ?? null, ids: [] }
    groups[key].ids.push(f.id as number)
  }

  for (const [key, group] of Object.entries(groups)) {
    if (group.ids.length < 3) continue  // Minimálně 3 výskyty

    // Zkontroluj, zda již existuje pravidlo
    const icoFilter = group.ico ? `ico=eq.${encodeURIComponent(group.ico)}` : `dodavatel_pattern=ilike.${encodeURIComponent(group.dodavatel)}`
    const existing = await sbGet(`pravidla?${icoFilter}&aktivni=eq.true&limit=1`)
    if (existing.length > 0) continue  // Pravidlo existuje, přeskoč

    // Hledej kategorii v historii schválených faktur
    const histFilter = group.ico
      ? `ico=eq.${encodeURIComponent(group.ico)}`
      : `dodavatel=ilike.${encodeURIComponent(group.dodavatel)}`
    const hist = await sbGet(
      `faktury?${histFilter}&stav=in.(schvalena,zaplacena)&kategorie_id=not.is.null&select=kategorie_id&order=id.desc&limit=3`
    )
    if (hist.length === 0) continue  // Žádná historia

    // Zjisti nejčastější kategorii
    const katCounts: Record<number, number> = {}
    for (const h of hist) katCounts[h.kategorie_id as number] = (katCounts[h.kategorie_id as number] ?? 0) + 1
    const bestKat = Number(Object.entries(katCounts).sort((a, b) => b[1] - a[1])[0][0])

    // Vytvoř pravidlo s nízkou confidence (bude zpevněno při dalším schválení)
    await fetch(`${SUPABASE_URL}/rest/v1/pravidla`, {
      method: 'POST',
      headers: { ...SB, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({
        typ: 'kategorie',
        scope: group.ico ? 'ico' : 'supplier_pattern',
        ico: group.ico,
        dodavatel_pattern: group.ico ? null : group.dodavatel,
        kategorie_id: bestKat,
        confidence: 65,
        zdroj: 'agent',
        aktivni: true,
        poznamka: `Hypotéza: ${group.ids.length} eskalací bez pravidla. Naučeno z ${hist.length} schválených faktur.`,
      }),
    })

    actions.push(`Vytvořeno pravidlo pro "${group.dodavatel}" → kat ${bestKat} (conf 65, ${group.ids.length} eskalací)`)
    learned++
    void key
  }

  return { learned, actions }
}

// ── Handler ───────────────────────────────────────────────────────────────────

export async function POST() {
  // 1. Zpracuj feedback frontu (primární)
  const feedbackResult = await processFeedbackQueue()

  // 2. Auto-učení z eskalací (před monitoringem, aby monitoring viděl nová pravidla)
  const learnResult = await learnFromEscalations()

  const findings: Finding[] = []

  // 3. Aktivní monitoring (sekundární — pro věci které agenti nevidí)
  await Promise.all([
    checkLearningGaps(findings),
    checkBrokenPipeline(findings),
    checkReferentialIntegrity(findings),
    checkContradictions(findings),
  ])

  // Seřadit: critical první
  findings.sort((a, b) => {
    const order = { critical: 0, warning: 1, info: 2 }
    return order[a.závažnost] - order[b.závažnost]
  })

  // 1. Auto-oprav co Architekt může sám (contradiction, invalid refs)
  const fixes = await autoFix(findings)
  const fixedKódy = new Set(fixes.map(f => f.kód))

  // 2. Zapiš findings — opravené jako accepted, ostatní jako pending
  await writeFindings(findings, fixedKódy)

  // 3. Eskaluj neopravené na orchestrátora → PM
  const neopravene = findings.filter(f => !fixedKódy.has(f.kód))
  const orchestratorResponse = await notifyOrchestrator(neopravene)

  return NextResponse.json({
    ok: true,
    findings_count: findings.length,
    auto_fixed: fixes.length,
    escalated: neopravene.length,
    critical: findings.filter(f => f.závažnost === 'critical').length,
    warnings: findings.filter(f => f.závažnost === 'warning').length,
    by_category: {
      learning_gap: findings.filter(f => f.kategorie === 'learning_gap').length,
      broken_pipeline: findings.filter(f => f.kategorie === 'broken_pipeline').length,
      referential_integrity: findings.filter(f => f.kategorie === 'referential_integrity').length,
      contradiction: findings.filter(f => f.kategorie === 'contradiction').length,
    },
    feedback: feedbackResult,
    learning: learnResult,
    fixes,
    findings,
    orchestrator: orchestratorResponse,
  })
}
