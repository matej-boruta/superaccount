/**
 * POST /api/abra-fix
 *
 * Sladí rozdíly mezi ABRA a Supabase.
 *
 * Body:
 *   { action: 'create-banka', sbId, abraId, transakceId }
 *     → Vytvoří banka doklad v ABRA napojený na faktura-prijata (účetně správné párování)
 *
 *   { action: 'create-banka-bulk' }
 *     → Vytvoří banka doklady pro všechny diff položky kde je párovaná transakce
 *
 *   { action: 'create-in-abra', sbId: number }
 *     → Vytvoří faktura-prijata v ABRA pro danou SB fakturu (pokud ještě neexistuje)
 *
 *   { action: 'create-in-abra-bulk' }
 *     → Vytvoří v ABRA všechny SB faktury (schvalena/zaplacena), které tam chybí
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
}

async function abraPatchStav(abraId: string): Promise<boolean> {
  const res = await fetch(`${ABRA_URL}/faktura-prijata/${abraId}.json`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: ABRA_AUTH },
    body: JSON.stringify({
      winstrom: {
        'faktura-prijata': [{ id: abraId, stavUhrK: 'stavUhr.uhrazenoRucne' }],
      },
    }),
  })
  const data = await res.json()
  return data?.winstrom?.success === 'true'
}

async function createFpInAbra(f: SbFaktura): Promise<{ id: string | null; alreadyExisted: boolean }> {
  const year = new Date().getFullYear()
  const abraKod = `FP-${f.id}-${year}`

  // Check if already exists
  const checkRes = await fetch(
    `${ABRA_URL}/faktura-prijata.json?limit=1&detail=custom:id,kod&filter=kod='${abraKod}'`,
    { headers: { Authorization: ABRA_AUTH } }
  )
  const checkData = await checkRes.json()
  const existing = checkData?.winstrom?.['faktura-prijata']?.[0]
  if (existing?.id) return { id: existing.id, alreadyExisted: true }

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
  const id = data?.winstrom?.results?.[0]?.id ?? null
  return { id, alreadyExisted: false }
}

async function createAbraBanka(
  f: SbFaktura,
  abraFaId: string,
  transakce: { datum: string; castka: number; mena: string }
): Promise<boolean> {
  const abraKod = `FP-${f.id}-${new Date().getFullYear()}`
  const datPlatby = transakce.datum.split('T')[0]
  const fakturaCastka = Number(f.castka_s_dph)       // v měně faktury (EUR/USD/CZK)
  const bankaCastka = Math.abs(Number(transakce.castka)) // skutečná CZK částka z FIO
  // Banka účet je vždy CZK — sumOsv musí být v CZK
  // uhrada.castka je v měně faktury (aby ABRA spároval s FP)

  // Fetch firma from ABRA faktura (for proper booking)
  let firma: string | undefined
  try {
    const faRes = await fetch(`${ABRA_URL}/faktura-prijata/${abraFaId}.json?fields=id,firma`, {
      headers: { Authorization: ABRA_AUTH },
    })
    const faData = await faRes.json()
    firma = faData?.winstrom?.['faktura-prijata']?.[0]?.firma
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
  // Mark as zauctovano in SB
  if (ok) {
    await fetch(`${SUPABASE_URL}/rest/v1/faktury?id=eq.${f.id}`, {
      method: 'PATCH',
      headers: { ...SB, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ zauctovano_platba: true }),
    })
  }
  return ok
}

export async function POST(req: Request) {
  const body = await req.json()
  const { action, abraId, sbId, transakceId } = body as {
    action: string; abraId?: string; sbId?: number; transakceId?: number
  }

  if (action === 'create-banka' && sbId && abraId && transakceId) {
    const [fRes, tRes] = await Promise.all([
      fetch(`${SUPABASE_URL}/rest/v1/faktury?id=eq.${sbId}&select=*&limit=1`, { headers: SB }),
      fetch(`${SUPABASE_URL}/rest/v1/transakce?id=eq.${transakceId}&select=id,datum,castka,mena&limit=1`, { headers: SB }),
    ])
    const [f]: SbFaktura[] = await fRes.json()
    const [t]: { id: number; datum: string; castka: number; mena: string }[] = await tRes.json()
    if (!f || !t) return NextResponse.json({ error: 'Faktura nebo transakce nenalezena' }, { status: 404 })
    const ok = await createAbraBanka(f, abraId, t)
    return NextResponse.json({ ok })
  }

  if (action === 'create-banka-bulk') {
    // Fetch all zaplacena faktury with paired transactions + ABRA ids
    const [sbRes, tRes, abraRes] = await Promise.all([
      fetch(`${SUPABASE_URL}/rest/v1/faktury?stav=eq.zaplacena&select=*&limit=1000`, { headers: SB }),
      fetch(`${SUPABASE_URL}/rest/v1/transakce?stav=eq.sparovano&select=id,faktura_id,datum,castka,mena&limit=2000`, { headers: SB }),
      fetch(`${ABRA_URL}/faktura-prijata.json?limit=1000&detail=custom:id,kod,stavUhrady`, { headers: { Authorization: ABRA_AUTH } }),
    ])
    const sbData: SbFaktura[] = await sbRes.json()
    const tData: { id: number; faktura_id: number; datum: string; castka: number; mena: string }[] = await tRes.json()
    const abraJson = await abraRes.json()
    const abraAll: { id: string; kod: string; stavUhrady: string }[] = abraJson?.winstrom?.['faktura-prijata'] || []

    const transByFakturaId = new Map(tData.map(t => [t.faktura_id, t]))
    const abraBySbId = new Map<number, { id: string; stavUhrady: string }>()
    for (const a of abraAll) {
      const m = a.kod?.match(/^FP-(\d+)-/)
      if (m) abraBySbId.set(parseInt(m[1]), a)
    }

    let created = 0
    let skipped = 0
    const errors: string[] = []

    for (const f of sbData) {
      const abra = abraBySbId.get(f.id)
      if (!abra) { skipped++; continue } // chybí v ABRA — nejdřív vytvořit FP
      const abraUhrazeno = abra.stavUhrady?.toLowerCase().includes('uhrazen') && !abra.stavUhrady?.toLowerCase().includes('ne')
      if (abraUhrazeno) { skipped++; continue } // už uhrazeno
      const t = transByFakturaId.get(f.id)
      if (!t) { skipped++; continue } // nemá párovanou transakci
      const ok = await createAbraBanka(f, abra.id, t)
      if (ok) created++
      else errors.push(`FP-${f.id}: ${f.dodavatel}`)
    }
    return NextResponse.json({ ok: true, created, skipped, errors })
  }

  if (action === 'fix-stav' && abraId) {
    const ok = await abraPatchStav(abraId)
    return NextResponse.json({ ok })
  }

  if (action === 'create-in-abra' && sbId) {
    const sbRes = await fetch(
      `${SUPABASE_URL}/rest/v1/faktury?id=eq.${sbId}&select=*&limit=1`,
      { headers: SB }
    )
    const [f]: SbFaktura[] = await sbRes.json()
    if (!f) return NextResponse.json({ error: 'Faktura nenalezena' }, { status: 404 })
    const result = await createFpInAbra(f)
    return NextResponse.json({ ok: true, ...result })
  }

  if (action === 'fix-stav-bulk') {
    // Re-run reconcile to find diff items
    const sbRes = await fetch(
      `${SUPABASE_URL}/rest/v1/faktury?stav=eq.zaplacena&select=id&limit=1000`,
      { headers: SB }
    )
    const sbZaplacene: { id: number }[] = await sbRes.json()
    const sbIds = new Set(sbZaplacene.map(f => f.id))

    const abraRes = await fetch(
      `${ABRA_URL}/faktura-prijata.json?limit=1000&detail=custom:id,kod,stavUhrady`,
      { headers: { Authorization: ABRA_AUTH } }
    )
    const abraJson = await abraRes.json()
    const abraAll: { id: string; kod: string; stavUhrady: string }[] = abraJson?.winstrom?.['faktura-prijata'] || []

    let fixed = 0
    const errors: string[] = []
    for (const abra of abraAll) {
      const m = abra.kod?.match(/^FP-(\d+)-/)
      if (!m) continue
      const sid = parseInt(m[1])
      if (!sbIds.has(sid)) continue
      const abraUhrazeno = abra.stavUhrady?.toLowerCase().includes('uhrazen') && !abra.stavUhrady?.toLowerCase().includes('ne')
      if (abraUhrazeno) continue
      const ok = await abraPatchStav(abra.id)
      if (ok) fixed++
      else errors.push(abra.kod)
    }
    return NextResponse.json({ ok: true, fixed, errors })
  }

  if (action === 'create-in-abra-bulk') {
    const sbRes = await fetch(
      `${SUPABASE_URL}/rest/v1/faktury?stav=in.(schvalena,zaplacena)&select=*&order=id.asc&limit=1000`,
      { headers: SB }
    )
    const sbData: SbFaktura[] = await sbRes.json()

    const abraRes = await fetch(
      `${ABRA_URL}/faktura-prijata.json?limit=1000&detail=custom:id,kod`,
      { headers: { Authorization: ABRA_AUTH } }
    )
    const abraJson = await abraRes.json()
    const abraCodes = new Set<number>(
      (abraJson?.winstrom?.['faktura-prijata'] || [])
        .map((f: { kod: string }) => f.kod?.match(/^FP-(\d+)-/)?.[1])
        .filter(Boolean)
        .map(Number)
    )

    const missing = sbData.filter(f => !abraCodes.has(f.id))
    let created = 0
    const errors: string[] = []
    for (const f of missing) {
      const result = await createFpInAbra(f)
      if (result.id || result.alreadyExisted) created++
      else errors.push(`${f.id}: ${f.dodavatel}`)
    }
    return NextResponse.json({ ok: true, created, total: missing.length, errors })
  }

  if (action === 'delete-abra' && abraId) {
    const res = await fetch(`${ABRA_URL}/faktura-prijata/${abraId}.json`, {
      method: 'DELETE',
      headers: { Authorization: ABRA_AUTH },
    })
    const ok = res.ok || res.status === 204
    return NextResponse.json({ ok })
  }

  return NextResponse.json({ error: 'Neznámá akce' }, { status: 400 })
}
