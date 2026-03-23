/**
 * SuperBook Agent – automatické zpracování faktur.
 *
 * Paměť agenta (Supabase):
 *   agent_knowledge    ← API přístupy, účetní pravidla, kontext systému
 *   dodavatel_pravidla ← pravidla per dodavatel (auto_schvalit, keyword, typ_platby)
 *   ucetni_vzory       ← MD/DAL vzory per IČO dodavatele (cross-company)
 *
 * Workflow pro každou novou fakturu:
 *   1. Načte kontext z agent_knowledge
 *   2. Vyhledá pravidlo v dodavatel_pravidla (nebo se naučí z historie)
 *   3. Doplní kategorie_id
 *   4. auto_schvalit → vytvoří faktura-prijata v ABRA
 *   5. auto_parovat  → spáruje s bankovní transakcí + vytvoří banka v ABRA
 */

import { NextResponse } from 'next/server'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY!
const ABRA_URL = process.env.ABRA_URL!
const ABRA_USER = process.env.ABRA_USER!
const ABRA_PASS = process.env.ABRA_PASS!
const ABRA_AUTH = 'Basic ' + Buffer.from(`${ABRA_USER}:${ABRA_PASS}`).toString('base64')

const SB = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
const SB_W = { ...SB, 'Content-Type': 'application/json', Prefer: 'return=minimal' }

// Agent context loaded from agent_knowledge table at runtime
type AgentContext = Record<string, Record<string, unknown>>
let agentContext: AgentContext | null = null

async function loadAgentContext(): Promise<AgentContext> {
  if (agentContext) return agentContext
  const res = await fetch(`${SUPABASE_URL}/rest/v1/agent_knowledge?select=kategorie,klic,hodnota`, { headers: SB })
  const rows: { kategorie: string; klic: string; hodnota: Record<string, unknown> }[] = await res.json()
  const ctx: AgentContext = {}
  for (const row of rows) {
    if (!ctx[row.kategorie]) ctx[row.kategorie] = {}
    ctx[row.kategorie][row.klic] = row.hodnota
  }
  agentContext = ctx
  return ctx
}

type Faktura = Record<string, unknown>
type Transakce = Record<string, unknown>
type Pravidlo = {
  id: number
  dodavatel_pattern: string
  ico: string | null
  kategorie_id: number | null
  typ_platby: string | null
  auto_schvalit: boolean
  auto_parovat: boolean
  poznamka: string | null  // "keyword:GOOGLE*WORKSPACE" → zprava keyword pro párování
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function daysDiff(a: string, b: string): number {
  return Math.abs((new Date(a).getTime() - new Date(b).getTime()) / 86400000)
}

const kurzyCache: Record<string, number> = {}
async function getKurz(mena: string, datum: string): Promise<number> {
  if (mena === 'CZK') return 1
  const key = `${mena}_${datum}`
  if (kurzyCache[key]) return kurzyCache[key]
  try {
    const [y, m, d] = datum.split('-')
    const url = `https://www.cnb.cz/en/financial-markets/foreign-exchange-market/central-bank-exchange-rate-fixing/central-bank-exchange-rate-fixing/daily.txt?date=${d}.${m}.${y}`
    const text = await (await fetch(url)).text()
    const line = text.split('\n').find(l => l.includes(`|${mena}|`))
    if (line) {
      const parts = line.split('|')
      const kurz = parseFloat(parts[4].replace(',', '.')) / parseFloat(parts[2])
      kurzyCache[key] = kurz
      return kurz
    }
  } catch { /* fallback */ }
  const fallback: Record<string, number> = { EUR: 25.2, USD: 23.1, GBP: 29.5 }
  return fallback[mena] ?? 1
}

async function sbGet(path: string) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: SB })
  return res.json()
}

async function sbPatch(path: string, body: Record<string, unknown>) {
  await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'PATCH', headers: SB_W, body: JSON.stringify(body),
  })
}

async function sbPost(path: string, body: Record<string, unknown>) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'POST',
    headers: { ...SB_W, Prefer: 'return=representation' },
    body: JSON.stringify(body),
  })
  return res.json()
}

// ── Pravidla ─────────────────────────────────────────────────────────────────

let pravidlaCache: Pravidlo[] | null = null
async function getPravidlo(dodavatel: string, ico?: string): Promise<Pravidlo | null> {
  if (!pravidlaCache) {
    const rows = await sbGet('dodavatel_pravidla?select=*')
    pravidlaCache = Array.isArray(rows) ? rows : []
  }
  const upper = dodavatel.toUpperCase()
  // Sort by pattern specificity (longer = more specific) — most specific first
  const sorted = [...pravidlaCache].sort((a, b) =>
    String(b.dodavatel_pattern || '').length - String(a.dodavatel_pattern || '').length
  )
  const byPattern = sorted.find(r => {
    const p = String(r.dodavatel_pattern || '').replace(/%/g, '').toUpperCase()
    return p && upper.includes(p)
  })
  if (byPattern) return byPattern
  // Match by ICO
  if (ico) return pravidlaCache.find(r => r.ico && r.ico === ico) ?? null
  return null
}

async function learnFromHistory(faktura: Faktura): Promise<Pravidlo | null> {
  const dodavatel = String(faktura.dodavatel || '')
  if (!dodavatel) return null

  // Look at past faktury from same supplier
  const history: Faktura[] = await sbGet(
    `faktury?dodavatel=eq.${encodeURIComponent(dodavatel)}&stav=in.(zaplacena,schvalena)&order=id.desc&limit=10`
  )

  if (history.length < 2) return null // Not enough data to learn

  // Derive rules from history
  const kategorieIds = history.map(f => f.kategorie_id).filter(Boolean)
  const mostCommonKat = kategorieIds.sort(
    (a, b) => kategorieIds.filter(v => v === b).length - kategorieIds.filter(v => v === a).length
  )[0] as number | null

  // Detect card payment pattern from paired transakce
  let detectedKeyword: string | null = null
  let detectedTyp: string | null = null
  for (const f of history.filter(h => h.stav === 'zaplacena').slice(0, 3)) {
    const paired: Transakce[] = await sbGet(`transakce?faktura_id=eq.${f.id}&limit=1`)
    if (paired.length > 0 && paired[0].typ === 'Platba kartou') {
      detectedTyp = 'karta'
      // Extract keyword from zprava
      const zprava = String(paired[0].zprava || '').toUpperCase()
      const words = zprava.replace(/[^A-Z0-9 ]/g, ' ').split(' ').filter(w => w.length > 4)
      // Find word that also appears in dodavatel
      const dodavatelUp = dodavatel.toUpperCase()
      detectedKeyword = words.find(w => dodavatelUp.includes(w) || w.includes(dodavatelUp.split(' ')[0].substring(0, 5))) ?? words[0] ?? null
      break
    } else if (paired.length > 0) {
      detectedTyp = 'prevod'
    }
  }

  const autoSchvalit = detectedTyp === 'karta' && !!detectedKeyword
  const autoParovat = autoSchvalit

  // Save learned rule
  const newRule = {
    dodavatel_pattern: dodavatel,
    ico: String(faktura.ico || '') || null,
    kategorie_id: mostCommonKat ?? faktura.kategorie_id ?? null,
    typ_platby: detectedTyp,
    auto_schvalit: autoSchvalit,
    auto_parovat: autoParovat,
    poznamka: detectedKeyword ? `keyword:${detectedKeyword}` : `Naučeno z ${history.length} faktur`,
  }

  try {
    const created = await sbPost('dodavatel_pravidla', newRule)
    return Array.isArray(created) ? created[0] : null
  } catch {
    return null
  }
}

async function updatePravidloStats(pravidloId: number, newKategorieId?: number) {
  if (!pravidloId) return
  const patch: Record<string, unknown> = {}
  if (newKategorieId) patch.kategorie_id = newKategorieId
  if (Object.keys(patch).length > 0) {
    await sbPatch(`dodavatel_pravidla?id=eq.${pravidloId}`, patch)
  }
}

// ── ABRA: create faktura-prijata ──────────────────────────────────────────────

async function createAbraFP(f: Faktura, alreadyPaid: boolean): Promise<string | null> {
  const abraKod = `FP-${f.id}-${new Date().getFullYear()}`

  const checkData = await (await fetch(`${ABRA_URL}/faktura-prijata/(kod='${abraKod}').json?fields=id`, {
    headers: { Authorization: ABRA_AUTH },
  })).json()
  const existing = checkData?.winstrom?.['faktura-prijata']?.[0]
  if (existing?.id) return existing.id

  const datVystRaw = String(f.datum_vystaveni || '')
  const datVystYear = parseInt(datVystRaw.split('-')[0])
  const datVyst = (datVystYear >= 2020 && datVystYear <= 2100) ? datVystRaw : new Date().toISOString().split('T')[0]
  const datUcto = new Date().toISOString().split('T')[0]
  const mena = String(f.mena || 'CZK')

  const body: Record<string, unknown> = {
    typDokl: 'code:FAKTURA',
    kod: abraKod,
    cisDosle: f.cislo_faktury || abraKod,
    varSym: f.variabilni_symbol || f.cislo_faktury || abraKod,
    datVyst,
    datUcto,
    popis: f.popis || f.dodavatel,
    mena: `code:${mena}`,
    polozkyFaktury: [{
      nazev: f.popis || f.dodavatel,
      cenaMj: Number(f.castka_bez_dph),
      mnozstvi: 1,
      sazbyDph: Number(f.dph) > 0 ? 'typSazbyDph.zakladni' : 'typSazbyDph.dphOsvobozeno',
      ucetni: 'code:518500',
    }],
  }
  const datSplatRaw = String(f.datum_splatnosti || '')
  const datSplatYear = parseInt(datSplatRaw.split('-')[0])
  if (datSplatYear >= 2020 && datSplatYear <= 2100) body.datSplat = datSplatRaw
  if (alreadyPaid) body.stavUhrK = 'stavUhr.uhrazenoRucne'

  const res = await fetch(`${ABRA_URL}/faktura-prijata.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: ABRA_AUTH },
    body: JSON.stringify({ winstrom: { 'faktura-prijata': [body] } }),
  })
  const data = await res.json()
  return data?.winstrom?.results?.[0]?.id ?? null
}

async function createAbraBanka(f: Faktura, t: Transakce, abraFaId: string) {
  const abraKod = `FP-${f.id}-${new Date().getFullYear()}`
  const datPlatby = String(t.datum || '').split('T')[0] || new Date().toISOString().split('T')[0]
  const castka = Number(f.castka_s_dph)

  const abraFa = (await (await fetch(`${ABRA_URL}/faktura-prijata/${abraFaId}.json?fields=id,firma`, {
    headers: { Authorization: ABRA_AUTH },
  })).json())?.winstrom?.['faktura-prijata']?.[0]

  const res = await fetch(`${ABRA_URL}/banka.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: ABRA_AUTH },
    body: JSON.stringify({
      winstrom: {
        banka: [{
          typDokl: 'code:STANDARD',
          banka: 'code:BANKOVNÍ ÚČET',
          typPohybuK: 'typPohybu.vydej',
          varSym: f.variabilni_symbol || '',
          datVyst: datPlatby,
          datUcto: datPlatby,
          popis: `Platba ${abraKod} - ${f.dodavatel}`,
          mena: `code:${f.mena || 'CZK'}`,
          sumOsv: castka,
          primUcet: 'code:221001',
          protiUcet: 'code:321001',
          ...(abraFa?.firma ? { firma: abraFa.firma } : {}),
          uhrada: [{ dokladFaktPrij: { id: abraFaId }, castka }],
        }],
      },
    }),
  })
  const data = await res.json()
  if (data?.winstrom?.success === 'true') {
    await sbPatch(`faktury?id=eq.${f.id}`, { zauctovano_platba: true })
  }
}

// Google Ads M:1 — jeden banka záznam pro jednu transakci, uhrada na fakturu
async function createAbraGoogleAdsBanka(f: Faktura, t: Transakce, abraFaId: string | null) {
  if (!abraFaId) return
  const abraKod = `FP-${f.id}-${new Date().getFullYear()}`
  const datPlatby = String(t.datum || '').split('T')[0] || new Date().toISOString().split('T')[0]
  const castka = Math.abs(Number(t.castka))

  await fetch(`${ABRA_URL}/banka.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: ABRA_AUTH },
    body: JSON.stringify({
      winstrom: {
        banka: [{
          typDokl: 'code:STANDARD',
          banka: 'code:BANKOVNÍ ÚČET',
          typPohybuK: 'typPohybu.vydej',
          varSym: '',
          datVyst: datPlatby,
          datUcto: datPlatby,
          popis: `Google Ads ${abraKod} - ${datPlatby}`,
          mena: 'code:CZK',
          sumOsv: castka,
          primUcet: 'code:221001',
          protiUcet: 'code:321001',
          uhrada: [{ dokladFaktPrij: { id: abraFaId }, castka }],
        }],
      },
    }),
  })
}

// ── Card matching ─────────────────────────────────────────────────────────────

async function findCardMatch(
  faktura: Faktura,
  pravidlo: Pravidlo,
  transakce: Transakce[]
): Promise<Transakce | null> {
  // Keyword je buď z poznamka ("keyword:SLOVO") nebo z dodavatel_pattern
  const keywordRaw = pravidlo.poznamka?.match(/^keyword:(.+)/)?.[1]?.trim()
    ?? String(pravidlo.dodavatel_pattern || '').replace(/%/g, '').split(' ')[0]
  if (!keywordRaw) return null

  const keyword = keywordRaw.toUpperCase()
  const fDate = String(faktura.datum_splatnosti || faktura.datum_vystaveni || '').split('T')[0]
  const fCastka = Number(faktura.castka_s_dph)
  const fMena = String(faktura.mena || 'CZK')

  for (const t of transakce) {
    if (t.typ !== 'Platba kartou') continue
    const zprava = String(t.zprava || '').toUpperCase()
    if (!zprava.includes(keyword)) continue

    // Amount match with currency conversion (EUR/USD faktura vs CZK transaction)
    const tCastka = Math.abs(Number(t.castka))
    let amountOk = false
    if (fMena === 'CZK') {
      amountOk = Math.abs(tCastka - fCastka) < 1
    } else {
      const tDate = String(t.datum || '').split('T')[0]
      const kurz = await getKurz(fMena, tDate)
      const fCzkEquiv = fCastka * kurz
      amountOk = fCzkEquiv > 0 && Math.abs(tCastka - fCzkEquiv) / fCzkEquiv < 0.02
    }
    if (!amountOk) continue

    const tDate = String(t.datum || '').split('T')[0]
    if (fDate && tDate && daysDiff(fDate, tDate) > 5) continue
    return t
  }
  return null
}

// ── Main ──────────────────────────────────────────────────────────────────────

export async function POST() {
  // Load agent's knowledge base (APIs, rules, context)
  const ctx = await loadAgentContext()
  const specialniDodavatele = (ctx['kontext']?.['dodavatele_specialni'] ?? {}) as Record<string, Record<string, unknown>>

  const [novaFaktury, nesparovaneT] = await Promise.all([
    sbGet('faktury?stav=eq.nova&select=*'),
    sbGet('transakce?stav=eq.nesparovano&select=*'),
  ]) as [Faktura[], Transakce[]]

  if (!novaFaktury.length) return NextResponse.json({ ok: true, processed: 0 })

  const log: { faktura_id: number; dodavatel: string; action: string; detail?: string }[] = []

  for (const f of novaFaktury) {
    const dodavatel = String(f.dodavatel || '')
    const fakturaId = f.id as number

    // 1. Get or learn rule
    let pravidlo = await getPravidlo(dodavatel, String(f.ico || '') || undefined)
    if (!pravidlo) {
      pravidlo = await learnFromHistory(f)
    }

    // 1b. Fallback: check agent_knowledge for special suppliers
    if (!pravidlo) {
      const specialMatch = Object.entries(specialniDodavatele).find(([name]) =>
        dodavatel.toUpperCase().includes(name.toUpperCase().split(' ')[0])
      )
      if (specialMatch) {
        const spec = specialMatch[1]
        pravidlo = {
          id: 0,
          dodavatel_pattern: specialMatch[0],
          ico: String(spec.dic || spec.ico || '') || null,
          kategorie_id: null,
          typ_platby: String(spec.platba || 'prevod'),
          auto_schvalit: false,
          auto_parovat: spec.platba === 'karta',
          poznamka: `keyword:${specialMatch[0].split(' ')[0].toUpperCase()}`,
        } as Pravidlo
      }
    }

    // 2. Apply kategorie from rule if missing
    if (pravidlo?.kategorie_id && !f.kategorie_id) {
      await sbPatch(`faktury?id=eq.${fakturaId}`, { kategorie_id: pravidlo.kategorie_id })
      f.kategorie_id = pravidlo.kategorie_id
    }

    // 3a. Google Ads — M:1 párování (průběžné strhávání kartou → jedna souhrnná faktura)
    const isGoogleAds = dodavatel.toLowerCase().includes('google ireland') &&
      String(f.popis || '').toLowerCase().includes('google ads')
    if (isGoogleAds) {
      try {
        // Najdi všechny GOOGLE*ADS transakce v billing periodu (měsíc faktury ±5 dní přetok)
        const billingStart = String(f.datum_vystaveni || '').slice(0, 7) + '-01'
        const billingEnd = String(f.datum_vystaveni || '').slice(0, 10)
        const billingEndExt = new Date(new Date(billingEnd).getTime() + 5 * 86400000).toISOString().split('T')[0]

        const tranRes = await fetch(
          `${SUPABASE_URL}/rest/v1/transakce?typ=eq.Platba%20kartou&datum=gte.${billingStart}&datum=lte.${billingEndExt}&zprava=ilike.*GOOGLE*ADS*&stav=eq.nesparovano&select=*`,
          { headers: SB }
        )
        const adsTranRes: Transakce[] = await tranRes.json()
        const adsTran = Array.isArray(adsTranRes) ? adsTranRes : []

        // Vytvoř ABRA faktura-prijata (alreadyPaid = true)
        const abraFaId = await createAbraFP(f, true)

        // Vytvoř ABRA banka záznam pro každou transakci, každý napárovaný na fakturu
        let bankaOk = 0
        for (const t of adsTran) {
          await createAbraGoogleAdsBanka(f, t, abraFaId)
          bankaOk++
        }

        // Supabase: faktura zaplacena + všechny transakce sparovano
        await sbPatch(`faktury?id=eq.${fakturaId}`, {
          stav: 'zaplacena',
          zauctovano_at: new Date().toISOString(),
          zauctovano_platba: true,
        })
        for (const t of adsTran) {
          await sbPatch(`transakce?id=eq.${t.id}`, { stav: 'sparovano', faktura_id: fakturaId })
        }

        log.push({ faktura_id: fakturaId, dodavatel, action: 'auto_zaplacena_google_ads', detail: `abra: ${abraFaId}, transakce: ${bankaOk}` })
      } catch (e) {
        log.push({ faktura_id: fakturaId, dodavatel, action: 'chyba', detail: String(e) })
      }
      continue
    }

    // 3. Auto-schválit + auto-párovat (card payments)
    if (pravidlo?.auto_schvalit && pravidlo?.auto_parovat) {
      const match = await findCardMatch(f, pravidlo, nesparovaneT)

      if (match) {
        try {
          const abraFaId = await createAbraFP(f, true)

          // Mark zaplacena in Supabase
          await Promise.all([
            sbPatch(`faktury?id=eq.${fakturaId}`, {
              stav: 'zaplacena',
              zauctovano_at: new Date().toISOString(),
            }),
            sbPatch(`transakce?id=eq.${match.id}`, {
              stav: 'sparovano',
              faktura_id: fakturaId,
            }),
          ])

          if (abraFaId) await createAbraBanka(f, match, abraFaId)

          // Remove from pool
          nesparovaneT.splice(nesparovaneT.indexOf(match), 1)

          if (pravidlo.id) await updatePravidloStats(pravidlo.id, f.kategorie_id as number)
          log.push({ faktura_id: fakturaId, dodavatel, action: 'auto_zaplacena', detail: `transakce ${match.id}` })
          continue
        } catch (e) {
          log.push({ faktura_id: fakturaId, dodavatel, action: 'chyba', detail: String(e) })
        }
      } else {
        // Rule says auto, but no matching transaction found yet — leave as nova
        log.push({ faktura_id: fakturaId, dodavatel, action: 'ceka_na_transakci' })
      }
      continue
    }

    // 4. Auto-schválit bez párování (bankovní převod — schválit, ale počkat na platbu)
    if (pravidlo?.auto_schvalit) {
      try {
        const abraFaId = await createAbraFP(f, false)
        await sbPatch(`faktury?id=eq.${fakturaId}`, {
          stav: 'schvalena',
          zauctovano_at: new Date().toISOString(),
        })
        if (pravidlo.id) await updatePravidloStats(pravidlo.id, f.kategorie_id as number)
        log.push({ faktura_id: fakturaId, dodavatel, action: 'auto_schvalena', detail: `abra: ${abraFaId}` })
      } catch (e) {
        log.push({ faktura_id: fakturaId, dodavatel, action: 'chyba', detail: String(e) })
      }
      continue
    }

    // 5. No rule or manual — just apply kategorie and leave as nova
    log.push({ faktura_id: fakturaId, dodavatel, action: pravidlo ? 'manualni_schvaleni' : 'neznamy_dodavatel' })
  }

  return NextResponse.json({ ok: true, processed: novaFaktury.length, log })
}
