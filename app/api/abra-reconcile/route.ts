/**
 * GET /api/abra-reconcile
 *
 * Porovná faktury v Supabase (prijate, stav schvalena/zaplacena) s ABRA faktura-prijata.
 * Matching: ABRA.kod = "FP-{supabaseId}-{rok}" → mapuje přímo na SB.id
 *
 * Vrací:
 *   - onlySB:   faktury v SB, ale chybí v ABRA
 *   - onlyABRA: faktury v ABRA (kód FP-*), ale chybí v SB
 *   - diff:     faktury s rozdílným stavem úhrady; obsahuje transakce_id/datum/castka pokud je párovaná transakce
 */
import { NextResponse } from 'next/server'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY!
const ABRA_URL = process.env.ABRA_URL!
const ABRA_USER = process.env.ABRA_USER!
const ABRA_PASS = process.env.ABRA_PASS!
const ABRA_AUTH = 'Basic ' + Buffer.from(`${ABRA_USER}:${ABRA_PASS}`).toString('base64')

const SB = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }

type SbFaktura = {
  id: number
  dodavatel: string
  cislo_faktury: string
  castka_s_dph: number
  mena: string
  datum_splatnosti: string | null
  stav: string
  zauctovano_platba: boolean | null
}

type SbTransakce = {
  id: number
  faktura_id: number
  datum: string
  castka: number
  mena: string
  zprava: string | null
}

type AbraFaktura = {
  id: string
  kod: string
  stavUhrady: string
  sumCelkem: number
  datVyst: string
  firma: string
  cisDosle: string
}

export async function GET() {
  // 1. Fetch SB faktury + spárované transakce paralelně
  const [sbRes, tRes] = await Promise.all([
    fetch(
      `${SUPABASE_URL}/rest/v1/faktury?stav=in.(schvalena,zaplacena)&select=id,dodavatel,cislo_faktury,castka_s_dph,mena,datum_splatnosti,stav,zauctovano_platba&order=id.asc&limit=1000`,
      { headers: SB }
    ),
    fetch(
      `${SUPABASE_URL}/rest/v1/transakce?stav=eq.sparovano&select=id,faktura_id,datum,castka,mena,zprava&limit=2000`,
      { headers: SB }
    ),
  ])

  const sbData: SbFaktura[] = await sbRes.json()
  const tData: SbTransakce[] = await tRes.json()
  if (!Array.isArray(sbData)) return NextResponse.json({ error: 'Chyba Supabase' }, { status: 500 })

  // Build transakce lookup by faktura_id
  const transByFakturaId = new Map<number, SbTransakce>()
  if (Array.isArray(tData)) {
    for (const t of tData) {
      if (t.faktura_id) transByFakturaId.set(t.faktura_id, t)
    }
  }

  // 2. Fetch ABRA faktura-prijata
  let abraData: AbraFaktura[] = []
  try {
    const abraRes = await fetch(
      `${ABRA_URL}/faktura-prijata.json?limit=1000&detail=custom:id,kod,stavUhrady,sumCelkem,datVyst,firma,cisDosle`,
      { headers: { Authorization: ABRA_AUTH } }
    )
    const abraJson = await abraRes.json()
    const all: AbraFaktura[] = abraJson?.winstrom?.['faktura-prijata'] || []
    abraData = all.filter(f => /^FP-\d+-/.test(f.kod || ''))
  } catch {
    return NextResponse.json({ error: 'Chyba ABRA' }, { status: 502 })
  }

  // 3. Build lookup maps
  const sbById = new Map<number, SbFaktura>()
  for (const f of sbData) sbById.set(f.id, f)

  const abraBySbId = new Map<number, AbraFaktura>()
  for (const f of abraData) {
    const m = f.kod?.match(/^FP-(\d+)-/)
    if (m) abraBySbId.set(parseInt(m[1]), f)
  }

  // 4. Compare
  const onlySB: SbFaktura[] = []
  const diff: Array<{
    sb: SbFaktura
    abra: AbraFaktura
    abraStav: string
    transakce: { id: number; datum: string; castka: number; mena: string } | null
  }> = []

  for (const f of sbData) {
    const abra = abraBySbId.get(f.id)
    if (!abra) {
      onlySB.push(f)
      continue
    }
    const abraUhrazeno = abra.stavUhrady?.toLowerCase().includes('uhrazen') && !abra.stavUhrady?.toLowerCase().includes('ne')
    const sbZaplacena = f.stav === 'zaplacena'
    // zauctovano_platba=true znamená banka doklad byl vytvořen → považujeme za OK
    if (f.zauctovano_platba) continue
    if (sbZaplacena !== abraUhrazeno) {
      const t = transByFakturaId.get(f.id) ?? null
      diff.push({
        sb: f,
        abra,
        abraStav: abra.stavUhrady,
        transakce: t ? { id: t.id, datum: t.datum, castka: t.castka, mena: t.mena } : null,
      })
    }
  }

  const onlyABRA: AbraFaktura[] = []
  for (const [sbId, abra] of abraBySbId) {
    if (!sbById.has(sbId)) onlyABRA.push(abra)
  }

  const diffWithT = diff.filter(d => d.transakce).length
  const diffWithoutT = diff.filter(d => !d.transakce).length

  // 5. Porovnání ABRA banka vs SB sparovane transakce
  // ABRA banka: popis = "Platba FP-{sbId}-{year} - {dodavatel}"
  type AbraBanka = { id: string; popis: string; sumOsv: number; datVyst: string; varSym: string }
  let abraBankaData: AbraBanka[] = []
  try {
    const bankaRes = await fetch(
      `${ABRA_URL}/banka.json?limit=2000&detail=custom:id,popis,sumOsv,datVyst,varSym`,
      { headers: { Authorization: ABRA_AUTH } }
    )
    const bankaJson = await bankaRes.json()
    const all: AbraBanka[] = bankaJson?.winstrom?.banka || []
    // Jen záznamy které vytvořila naše aplikace (popis začíná "Platba FP-")
    abraBankaData = all.filter(b => /^Platba FP-\d+-/.test(b.popis || ''))
  } catch { /* skip banka check on error */ }

  // Spárované SB transakce s faktura_id
  const sbSparovane = Array.isArray(tData) ? tData.filter(t => t.faktura_id) : []

  // Match: ABRA banka popis "Platba FP-{id}-" → sbId
  const abraBankaBySbId = new Map<number, AbraBanka>()
  for (const b of abraBankaData) {
    const m = b.popis?.match(/^Platba FP-(\d+)-/)
    if (m) abraBankaBySbId.set(parseInt(m[1]), b)
  }

  // SB sparovane bez ABRA banka záznamu (a zauctovano_platba=false)
  const sbBezBanky: Array<{ sbId: number; dodavatel: string; castka: number; mena: string; datum: string }> = []
  for (const t of sbSparovane) {
    if (!t.faktura_id) continue
    const f = sbById.get(t.faktura_id)
    if (!f) continue
    if (f.zauctovano_platba) continue // already zauctovano
    if (!abraBankaBySbId.has(t.faktura_id)) {
      sbBezBanky.push({ sbId: t.faktura_id, dodavatel: f.dodavatel, castka: Math.abs(t.castka), mena: t.mena, datum: t.datum })
    }
  }

  // ABRA banka záznamy bez SB transakce
  const abraBankaBezSB: AbraBanka[] = []
  for (const [sbId, b] of abraBankaBySbId) {
    const hasTrans = sbSparovane.some(t => t.faktura_id === sbId)
    if (!hasTrans) abraBankaBezSB.push(b)
  }

  return NextResponse.json({
    ok: true,
    stats: {
      sbTotal: sbData.length,
      abraTotal: abraData.length,
      matched: sbData.length - onlySB.length,
      diffWithTransakce: diffWithT,
      diffWithoutTransakce: diffWithoutT,
      sbSparovaneTotal: sbSparovane.length,
      abraBankaTotal: abraBankaData.length,
    },
    onlySB,
    onlyABRA,
    diff,
    banka: {
      sbBezBanky,
      abraBankaBezSB,
    },
  })
}
