/**
 * Agent pro automatické zpracování faktur.
 *
 * Při každém volání (POST /api/agent) projde všechny nova faktury a:
 * 1. Vyhledá pravidlo pro dodavatele v `dodavatel_pravidla`
 * 2. Doplní chybějící kategorie_id
 * 3. Pokud auto_schvalit=true → schválí (vytvoří faktura-prijata v ABRA)
 * 4. Pokud auto_parovat=true → spáruje s odpovídající bankovní transakcí
 * 5. Po zpracování aktualizuje pravidlo (učení z dat)
 *
 * Nový dodavatel bez pravidla → agent vytvoří pravidlo z historických dat.
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

type Faktura = Record<string, unknown>
type Transakce = Record<string, unknown>
type Pravidlo = {
  id: number
  dodavatel: string
  ico: string | null
  kategorie_id: number | null
  typ_platby: string | null
  parovat_keyword: string | null
  auto_schvalit: boolean
  auto_parovat: boolean
  poznamka: string | null
  pocet_faktur: number
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function daysDiff(a: string, b: string): number {
  return Math.abs((new Date(a).getTime() - new Date(b).getTime()) / 86400000)
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

async function getPravidlo(dodavatel: string, ico?: string): Promise<Pravidlo | null> {
  // Match by exact dodavatel name
  const rows = await sbGet(`dodavatel_pravidla?dodavatel=eq.${encodeURIComponent(dodavatel)}&limit=1`)
  if (Array.isArray(rows) && rows.length > 0) return rows[0]

  // Match by ICO if provided
  if (ico) {
    const byIco = await sbGet(`dodavatel_pravidla?ico=eq.${encodeURIComponent(ico)}&limit=1`)
    if (Array.isArray(byIco) && byIco.length > 0) return byIco[0]
  }

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
    dodavatel,
    ico: String(faktura.ico || '') || null,
    kategorie_id: mostCommonKat ?? faktura.kategorie_id ?? null,
    typ_platby: detectedTyp,
    parovat_keyword: detectedKeyword,
    auto_schvalit: autoSchvalit,
    auto_parovat: autoParovat,
    poznamka: `Naučeno automaticky z ${history.length} faktur`,
    pocet_faktur: history.length,
    aktualizovano_at: new Date().toISOString(),
  }

  try {
    const created = await sbPost('dodavatel_pravidla', newRule)
    return Array.isArray(created) ? created[0] : null
  } catch {
    return null
  }
}

async function updatePravidloStats(pravidloId: number, newKategorieId?: number) {
  const patch: Record<string, unknown> = {
    pocet_faktur: 999, // will increment via SQL — use raw increment
    aktualizovano_at: new Date().toISOString(),
  }
  if (newKategorieId) patch.kategorie_id = newKategorieId

  // Simple increment via select+patch
  const rows = await sbGet(`dodavatel_pravidla?id=eq.${pravidloId}&select=pocet_faktur`)
  if (Array.isArray(rows) && rows.length > 0) {
    patch.pocet_faktur = (Number(rows[0].pocet_faktur) || 0) + 1
  }

  await sbPatch(`dodavatel_pravidla?id=eq.${pravidloId}`, patch)
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
    varSym: f.variabilni_symbol || '',
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

// ── Card matching ─────────────────────────────────────────────────────────────

function findCardMatch(
  faktura: Faktura,
  pravidlo: Pravidlo,
  transakce: Transakce[]
): Transakce | null {
  if (!pravidlo.parovat_keyword) return null

  const keyword = pravidlo.parovat_keyword.toUpperCase()
  const fDate = String(faktura.datum_splatnosti || faktura.datum_vystaveni || '').split('T')[0]
  const fCastka = Number(faktura.castka_s_dph)

  return transakce.find(t => {
    if (t.typ !== 'Platba kartou') return false
    const zprava = String(t.zprava || '').toUpperCase()
    if (!zprava.includes(keyword)) return false
    if (Math.abs(Math.abs(Number(t.castka)) - fCastka) >= 1) return false
    const tDate = String(t.datum || '').split('T')[0]
    if (fDate && tDate && daysDiff(fDate, tDate) > 2) return false
    return true
  }) ?? null
}

// ── Main ──────────────────────────────────────────────────────────────────────

export async function POST() {
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

    // 2. Apply kategorie from rule if missing
    if (pravidlo?.kategorie_id && !f.kategorie_id) {
      await sbPatch(`faktury?id=eq.${fakturaId}`, { kategorie_id: pravidlo.kategorie_id })
      f.kategorie_id = pravidlo.kategorie_id
    }

    // 3. Auto-schválit + auto-párovat (card payments)
    if (pravidlo?.auto_schvalit && pravidlo?.auto_parovat) {
      const match = findCardMatch(f, pravidlo, nesparovaneT)

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
