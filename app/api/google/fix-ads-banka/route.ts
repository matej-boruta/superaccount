/**
 * POST /api/google/fix-ads-banka
 *
 * Dodatečně vytvoří ABRA banka záznamy pro Google Ads faktury,
 * kde faktura je zaplacena ale banka záznamy chybí.
 * Hledá transakce sparovano s danou fakturou a vytvoří záznamy v ABRA.
 */
import { NextResponse } from 'next/server'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY!
const ABRA_URL = process.env.ABRA_URL!
const ABRA_USER = process.env.ABRA_USER!
const ABRA_PASS = process.env.ABRA_PASS!
const ABRA_AUTH = 'Basic ' + Buffer.from(`${ABRA_USER}:${ABRA_PASS}`).toString('base64')

const SB = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }

async function getAbraFaId(fakturaId: number): Promise<string | null> {
  const abraKod = `FP-${fakturaId}-${new Date().getFullYear()}`
  const res = await fetch(`${ABRA_URL}/faktura-prijata/(kod='${abraKod}').json?fields=id`, {
    headers: { Authorization: ABRA_AUTH },
  })
  const data = await res.json()
  return data?.winstrom?.['faktura-prijata']?.[0]?.id ?? null
}

async function createBankaZaznam(
  fakturaId: number,
  abraFaId: string,
  transakce: Record<string, unknown>
): Promise<{ ok: boolean; bankaId?: string; error?: string }> {
  const datPlatby = String(transakce.datum || '').split('T')[0] || new Date().toISOString().split('T')[0]
  const castka = Math.abs(Number(transakce.castka))
  const abraKod = `FP-${fakturaId}-${new Date().getFullYear()}`

  // Check if banka záznam already exists for this transaction
  const checkKod = `BANKA-${transakce.id}`
  const checkRes = await fetch(`${ABRA_URL}/banka/(kod='${checkKod}').json?fields=id`, {
    headers: { Authorization: ABRA_AUTH },
  })
  const checkData = await checkRes.json()
  if (checkData?.winstrom?.banka?.[0]?.id) {
    return { ok: true, bankaId: checkData.winstrom.banka[0].id }
  }

  const res = await fetch(`${ABRA_URL}/banka.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: ABRA_AUTH },
    body: JSON.stringify({
      winstrom: {
        banka: [{
          typDokl: 'code:STANDARD',
          kod: checkKod,
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
  const data = await res.json()
  if (data?.winstrom?.success === 'true') {
    const bankaId = data?.winstrom?.results?.[0]?.id
    return { ok: true, bankaId }
  }
  return { ok: false, error: JSON.stringify(data?.winstrom?.results?.[0]) }
}

export async function POST() {
  // Najdi Google Ads faktury (zaplacena, Google Ireland + google ads)
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/faktury?stav=eq.zaplacena&dodavatel=ilike.*Google Ireland*&popis=ilike.*Google Ads*&select=*`,
    { headers: SB }
  )
  const faktury: Record<string, unknown>[] = await res.json()

  const results = []

  for (const f of faktury) {
    const fakturaId = Number(f.id)
    const abraKod = `FP-${fakturaId}-${new Date().getFullYear()}`

    // Najdi ABRA faktura-prijata
    const abraFaId = await getAbraFaId(fakturaId)
    if (!abraFaId) {
      results.push({ faktura_id: fakturaId, abraKod, error: 'ABRA faktura-prijata nenalezena' })
      continue
    }

    // Najdi sparovane transakce pro tuto fakturu
    const tranRes = await fetch(
      `${SUPABASE_URL}/rest/v1/transakce?faktura_id=eq.${fakturaId}&stav=eq.sparovano&typ=eq.Platba%20kartou&select=*`,
      { headers: SB }
    )
    const transakce: Record<string, unknown>[] = await tranRes.json()

    if (!transakce.length) {
      results.push({ faktura_id: fakturaId, abraKod, abraFaId, warning: 'Žádné sparovane transakce' })
      continue
    }

    // Zkontroluj stav uhrad v ABRA
    const faRes = await fetch(
      `${ABRA_URL}/faktura-prijata/${abraFaId}.json?fields=id,stavUhrK,sumCelkem,sumUhr`,
      { headers: { Authorization: ABRA_AUTH } }
    )
    const faData = await faRes.json()
    const fa = faData?.winstrom?.['faktura-prijata']?.[0]

    const bankaResults = []
    for (const t of transakce) {
      const r = await createBankaZaznam(fakturaId, abraFaId, t)
      bankaResults.push({ transakce_id: t.id, ...r })
    }

    results.push({
      faktura_id: fakturaId,
      dodavatel: f.dodavatel,
      castka_s_dph: f.castka_s_dph,
      mena: f.mena,
      abraFaId,
      abraStavUhr: fa?.stavUhrK,
      abraSumUhr: fa?.sumUhr,
      transakce_count: transakce.length,
      banka: bankaResults,
    })
  }

  const ok = results.filter(r => !r.error).length
  return NextResponse.json({ ok: true, processed: results.length, success: ok, results })
}
