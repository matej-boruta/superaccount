/**
 * POST /api/abra-sync
 *
 * Safety-net synchronizace ABRA ↔ Supabase. Spouští se automaticky na pozadí
 * při načtení aplikace a po každém párování.
 *
 * Co dělá:
 *   1. Najde schvalena/zaplacena faktury bez FP v ABRA → vytvoří faktura-prijata
 *   2. Najde zaplacena faktury s párovanou transakcí kde zauctovano_platba=false → vytvoří banka doklad
 *
 * Idempotentní — opakované spuštění je bezpečné.
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

type SbFaktura = {
  id: number
  dodavatel: string
  ico: string | null
  cislo_faktury: string | null
  castka_bez_dph: number
  castka_s_dph: number
  dph: number
  mena: string
  datum_vystaveni: string | null
  datum_splatnosti: string | null
  variabilni_symbol: string | null
  popis: string | null
  stav: string
  zauctovano_platba: boolean | null
}

type SbTransakce = {
  id: number
  faktura_id: number
  datum: string
  castka: number
  mena: string
}

async function createFpInAbra(f: SbFaktura): Promise<string | null> {
  const year = new Date().getFullYear()
  const abraKod = `FP-${f.id}-${year}`

  const datVystRaw = f.datum_vystaveni || ''
  const datVystYear = parseInt(datVystRaw.split('-')[0])
  const datVyst = datVystYear >= 2020 && datVystYear <= 2100 ? datVystRaw : new Date().toISOString().split('T')[0]

  const datSplatRaw = f.datum_splatnosti || ''
  const datSplatYear = parseInt(datSplatRaw.split('-')[0])
  let datSplat: string
  if (datSplatYear >= 2020 && datSplatYear <= 2100) {
    datSplat = datSplatRaw
  } else {
    const fb = new Date(datVyst)
    fb.setDate(fb.getDate() + 14)
    datSplat = fb.toISOString().split('T')[0]
  }

  const mena = f.mena || 'CZK'
  const alreadyPaid = f.stav === 'zaplacena'

  const body: Record<string, unknown> = {
    typDokl: 'code:FAKTURA',
    kod: abraKod,
    cisDosle: f.cislo_faktury || abraKod,
    varSym: f.variabilni_symbol || f.cislo_faktury || abraKod,
    datVyst,
    datSplat,
    datUcto: new Date().toISOString().split('T')[0],
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
  if (alreadyPaid) body.stavUhrK = 'stavUhr.uhrazenoRucne'

  const res = await fetch(`${ABRA_URL}/faktura-prijata.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: ABRA_AUTH },
    body: JSON.stringify({ winstrom: { 'faktura-prijata': [body] } }),
  })
  const data = await res.json()
  return data?.winstrom?.results?.[0]?.id ?? null
}

async function createBankaInAbra(f: SbFaktura, abraFaId: string, t: SbTransakce): Promise<boolean> {
  const abraKod = `FP-${f.id}-${new Date().getFullYear()}`
  const datPlatby = t.datum.split('T')[0]
  const fakturaCastka = Number(f.castka_s_dph)  // v měně faktury (EUR/USD/CZK)
  const bankaCastka = Math.abs(Number(t.castka))  // CZK z FIO

  let firma: string | undefined
  try {
    const faRes = await fetch(`${ABRA_URL}/faktura-prijata/${abraFaId}.json?fields=id,firma`, {
      headers: { Authorization: ABRA_AUTH },
    })
    firma = (await faRes.json())?.winstrom?.['faktura-prijata']?.[0]?.firma
  } catch { /* skip */ }

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
          mena: 'code:CZK',
          sumOsv: bankaCastka,
          primUcet: 'code:221001',
          protiUcet: 'code:321001',
          ...(firma ? { firma } : {}),
          uhrada: [{ dokladFaktPrij: { id: abraFaId }, castka: fakturaCastka }],
        }],
      },
    }),
  })
  const data = await res.json()
  const ok = data?.winstrom?.success === 'true'
  if (ok) {
    await fetch(`${SUPABASE_URL}/rest/v1/faktury?id=eq.${f.id}`, {
      method: 'PATCH',
      headers: SB_W,
      body: JSON.stringify({ zauctovano_platba: true }),
    })
  }
  return ok
}

export async function POST() {
  const stats = { fpCreated: 0, bankaCreated: 0, errors: [] as string[] }

  // 1. Fetch všechny schvalena/zaplacena faktury
  const [sbRes, tRes, abraRes] = await Promise.all([
    fetch(`${SUPABASE_URL}/rest/v1/faktury?stav=in.(schvalena,zaplacena)&select=*&order=id.asc&limit=1000`, { headers: SB }),
    fetch(`${SUPABASE_URL}/rest/v1/transakce?stav=eq.sparovano&select=id,faktura_id,datum,castka,mena&limit=2000`, { headers: SB }),
    fetch(`${ABRA_URL}/faktura-prijata.json?limit=1000&detail=custom:id,kod,stavUhrady`, { headers: { Authorization: ABRA_AUTH } }),
  ])

  const sbData: SbFaktura[] = await sbRes.json()
  const tData: SbTransakce[] = await tRes.json()
  const abraJson = await abraRes.json()
  const abraAll: { id: string; kod: string; stavUhrady: string }[] = abraJson?.winstrom?.['faktura-prijata'] || []

  if (!Array.isArray(sbData)) return NextResponse.json({ error: 'Chyba Supabase' }, { status: 500 })

  // Build lookups
  const abraBySbId = new Map<number, { id: string; stavUhrady: string }>()
  for (const a of abraAll) {
    const m = a.kod?.match(/^FP-(\d+)-/)
    if (m) abraBySbId.set(parseInt(m[1]), a)
  }
  const transByFakturaId = new Map<number, SbTransakce>()
  if (Array.isArray(tData)) {
    for (const t of tData) if (t.faktura_id) transByFakturaId.set(t.faktura_id, t)
  }

  // Process each faktura
  for (const f of sbData) {
    let abra = abraBySbId.get(f.id)

    // Step 1: create FP if missing
    if (!abra) {
      try {
        const newId = await createFpInAbra(f)
        if (newId) {
          abra = { id: newId, stavUhrady: f.stav === 'zaplacena' ? 'uhrazeno' : 'neuhrazeno' }
          abraBySbId.set(f.id, abra)
          stats.fpCreated++
        } else {
          stats.errors.push(`FP-${f.id} (${f.dodavatel}): nepodařilo se vytvořit v ABRA`)
          continue
        }
      } catch (e) {
        stats.errors.push(`FP-${f.id}: ${String(e)}`)
        continue
      }
    }

    // Step 2: create banka if zaplacena + has transakce + not yet zauctovano
    if (f.stav === 'zaplacena' && !f.zauctovano_platba) {
      const t = transByFakturaId.get(f.id)
      if (!t) continue // no paired transaction — skip (handled by ABRA check manually)

      const abraUhrazeno = abra.stavUhrady?.toLowerCase().includes('uhrazen') && !abra.stavUhrady?.toLowerCase().includes('ne')
      if (abraUhrazeno) {
        // Already marked as paid (possibly via uhrazenoRucne) — just mark SB as zauctovano
        await fetch(`${SUPABASE_URL}/rest/v1/faktury?id=eq.${f.id}`, {
          method: 'PATCH', headers: SB_W, body: JSON.stringify({ zauctovano_platba: true }),
        })
        continue
      }

      try {
        const ok = await createBankaInAbra(f, abra.id, t)
        if (ok) stats.bankaCreated++
        else stats.errors.push(`banka FP-${f.id} (${f.dodavatel}): ABRA vrátilo chybu`)
      } catch (e) {
        stats.errors.push(`banka FP-${f.id}: ${String(e)}`)
      }
    }
  }

  return NextResponse.json({ ok: true, ...stats })
}
