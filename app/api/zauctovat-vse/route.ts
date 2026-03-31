import { NextResponse } from 'next/server'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY!
const ABRA_URL = process.env.ABRA_URL!
const ABRA_USER = process.env.ABRA_USER!
const ABRA_PASS = process.env.ABRA_PASS!
const ABRA_AUTH = 'Basic ' + Buffer.from(`${ABRA_USER}:${ABRA_PASS}`).toString('base64')

const SB_HEADERS = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
  Prefer: 'return=minimal',
}

export async function POST() {
  const year = new Date().getFullYear()

  // Fetch ALL zaplacena faktury (repair mode — includes already zauctovano)
  const fRes = await fetch(
    `${SUPABASE_URL}/rest/v1/faktury?stav=eq.zaplacena&select=*`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
  )
  const faktury = await fRes.json()
  if (!Array.isArray(faktury) || faktury.length === 0) return NextResponse.json({ ok: true, processed: 0 })

  // Fetch ALL existing ABRA banka records once for in-memory idempotency check
  const bkRes = await fetch(`${ABRA_URL}/banka.json?fields=id,popis&limit=2000`, {
    headers: { Authorization: ABRA_AUTH },
  })
  const bkData = await bkRes.json()
  const existingPopis: Set<string> = new Set(
    (bkData?.winstrom?.banka ?? []).map((b: { popis?: string }) => b.popis ?? '')
  )

  function alreadyExists(abraKod: string, transakceId: number, isSingle: boolean): boolean {
    // New format: "Platba FP-118-2026 T33 - ..."
    for (const p of existingPopis) {
      if (p.startsWith(`Platba ${abraKod} T${transakceId}`)) return true
    }
    // Old format (single transakce only): "Platba FP-103-2026 - ..."
    if (isSingle) {
      for (const p of existingPopis) {
        if (p.startsWith(`Platba ${abraKod} -`)) return true
      }
    }
    return false
  }

  const results: { id: number; ok: boolean; created: number; skipped: number; error?: string }[] = []

  for (const f of faktury) {
    try {
      const abraKod = `FP-${f.id}-${year}`

      const findRes = await fetch(`${ABRA_URL}/faktura-prijata/(kod='${abraKod}').json`, {
        headers: { Authorization: ABRA_AUTH },
      })
      const findData = await findRes.json()
      const abraFa = findData?.winstrom?.['faktura-prijata']?.[0]
      if (!abraFa?.id) {
        results.push({ id: f.id, ok: false, created: 0, skipped: 0, error: 'Faktura nenalezena v ABRA' })
        continue
      }

      // Fetch ALL sparovane transakce for this faktura
      const tRes = await fetch(`${SUPABASE_URL}/rest/v1/transakce?faktura_id=eq.${f.id}&stav=eq.sparovano&select=*`, {
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
      })
      let transakce: { id: number; datum: string; castka: number; mena: string }[] = await tRes.json()
      if (!transakce.length) {
        transakce = [{
          id: 0,
          datum: f.datum_platby || new Date().toISOString(),
          castka: -Number(f.castka_s_dph),
          mena: f.mena || 'CZK',
        }]
      }

      const mena = f.mena || 'CZK'
      let created = 0
      let skipped = 0
      let anyError: string | undefined

      for (const t of transakce) {
        if (alreadyExists(abraKod, t.id, transakce.length === 1)) {
          skipped++
          continue
        }

        const popis = `Platba ${abraKod} T${t.id} - ${f.dodavatel}`
        const datPlatby = t.datum ? t.datum.split('T')[0] : new Date().toISOString().split('T')[0]
        const castkaT = Math.abs(Number(t.castka))

        // For foreign currency invoices omit sumOsv — ABRA calculates from its own exchange rate
        const isForeign = mena !== 'CZK'
        const castkaUhrada = isForeign
          ? Math.round(Number(f.castka_bez_dph || f.castka_s_dph) * 100) / 100
          : Math.round(castkaT * 100) / 100

        const bankaRes = await fetch(`${ABRA_URL}/banka.json`, {
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
                popis,
                mena: `code:${mena}`,
                ...(isForeign ? {} : { sumOsv: Math.round(castkaT * 100) / 100 }),
                primUcet: 'code:221001',
                protiUcet: 'code:321001',
                ...(abraFa.firma ? { firma: abraFa.firma } : {}),
                uhrada: [{ dokladFaktPrij: { id: abraFa.id }, castka: castkaUhrada }],
              }],
            },
          }),
        })
        const bankaData = await bankaRes.json()
        const ok = bankaData?.winstrom?.success === 'true'
        const bankaErr = bankaData?.winstrom?.results?.[0]?.errors?.[0]?.message
        if (ok) {
          created++
          // Add to local set so subsequent iterations know this popis exists
          existingPopis.add(popis)
        } else {
          anyError = bankaErr
        }
      }

      if (!anyError) {
        await fetch(`${SUPABASE_URL}/rest/v1/faktury?id=eq.${f.id}`, {
          method: 'PATCH',
          headers: SB_HEADERS,
          body: JSON.stringify({ zauctovano_platba: true }),
        })
      }
      results.push({ id: f.id, ok: !anyError, created, skipped, error: anyError })
    } catch (e) {
      results.push({ id: f.id, ok: false, created: 0, skipped: 0, error: String(e) })
    }
  }

  const totalCreated = results.reduce((s, r) => s + r.created, 0)
  const totalSkipped = results.reduce((s, r) => s + r.skipped, 0)
  return NextResponse.json({ ok: true, processed: faktury.length, created: totalCreated, skipped: totalSkipped, results })
}
