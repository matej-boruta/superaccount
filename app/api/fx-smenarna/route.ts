/**
 * FX Směna — zpracování dokladů ze směnáren (SAB Finance apod.)
 *
 * Tok:
 *   1. Najde nova faktury kde dodavatel = SAB Finance (nebo popis obsahuje směnárenské klíčové slovo)
 *   2. 0 Kč doklady (výpisy, cross-reference) → stav = zamitnuta (informativní, bez účetního dopadu)
 *   3. Reálné FX doklady (castka > 0):
 *      - Označí kategorii "FX / Směna" (id 13)
 *      - Najde odpovídající CZK bankovní transakci (VS = cislo_faktury nebo částka + datum ±3 dny)
 *      - Vytvoří ABRA banka doklad: MD 221 CZK / DAL 261 (Peníze na cestě)
 *      - Označí fakturu stav = zaplacena, transakci stav = sparovano
 *
 * EUR strana směny (výdej EUR) se zaúčtuje automaticky při importu EUR transakcí z Fio,
 * kde ABRA páruje 261 ↔ 221 EUR a počítá kurzový rozdíl (563/663).
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

const FX_KATEGORIE_ID = 13
const FX_DODAVATELE = ['sab finance']
const FX_POPIS_KEYWORDS = ['prodej eur', 'nákup eur', 'nákup deviz', 'prodej deviz', 'směnárenská']

function isFxDodavatel(dodavatel: string): boolean {
  const d = dodavatel.toLowerCase()
  return FX_DODAVATELE.some(k => d.includes(k))
}

function isFxPopis(popis: string): boolean {
  const p = popis.toLowerCase()
  return FX_POPIS_KEYWORDS.some(k => p.includes(k))
}

function daysDiff(a: string, b: string): number {
  return Math.abs((new Date(a).getTime() - new Date(b).getTime()) / 86400000)
}

async function sbPatch(path: string, body: Record<string, unknown>) {
  await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'PATCH', headers: SB_W, body: JSON.stringify(body),
  })
}

async function createAbraFxBanka(
  f: Record<string, unknown>,
  t: Record<string, unknown>
): Promise<boolean> {
  const fakturaId = f.id as number
  const abraKod = `FX-${fakturaId}-${new Date().getFullYear()}`
  const datPlatby = String(t.datum || f.datum_vystaveni || '').split('T')[0]
  const castka = Math.abs(Number(t.castka))

  // Zkontroluj jestli ABRA doklad už existuje
  const check = await fetch(`${ABRA_URL}/banka/(kod='${abraKod}').json?fields=id`, {
    headers: { Authorization: ABRA_AUTH },
  })
  const checkData = await check.json()
  if (checkData?.winstrom?.banka?.[0]?.id) return true // already exists

  const res = await fetch(`${ABRA_URL}/banka.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: ABRA_AUTH },
    body: JSON.stringify({
      winstrom: {
        banka: [{
          typDokl: 'code:STANDARD',
          kod: abraKod,
          banka: 'code:BANKOVNÍ ÚČET',
          typPohybuK: 'typPohybu.prijem',        // CZK příjem
          varSym: f.variabilni_symbol || f.cislo_faktury || '',
          datVyst: datPlatby,
          datUcto: datPlatby,
          popis: `FX Směna CZK ${abraKod} — ${f.popis || f.dodavatel}`,
          mena: 'code:CZK',
          sumOsv: castka,
          primUcet: 'code:221001',               // MD 221 CZK
          protiUcet: 'code:261001',              // DAL 261 Peníze na cestě
        }],
      },
    }),
  })
  const data = await res.json()
  return data?.winstrom?.success === 'true'
}

export async function POST() {
  const [fRes, tRes] = await Promise.all([
    fetch(`${SUPABASE_URL}/rest/v1/faktury?stav=eq.nova&select=*`, { headers: SB }),
    fetch(`${SUPABASE_URL}/rest/v1/transakce?stav=eq.nesparovano&select=*`, { headers: SB }),
  ])
  const faktury: Record<string, unknown>[] = await fRes.json()
  const transakce: Record<string, unknown>[] = await tRes.json()

  const log: { id: number; akce: string; detail?: string }[] = []

  for (const f of faktury) {
    const dodavatel = String(f.dodavatel || '')
    const popis = String(f.popis || '')
    const cislo = String(f.cislo_faktury || '')
    const fakturaId = f.id as number

    if (!isFxDodavatel(dodavatel) && !isFxPopis(popis)) continue

    // 0 Kč doklady (výpisy, cross-reference) → zamítnout
    if (Number(f.castka_s_dph) === 0) {
      await sbPatch(`faktury?id=eq.${fakturaId}`, { stav: 'zamitnuta' })
      log.push({ id: fakturaId, akce: 'zamitnuta_0kc', detail: cislo })
      continue
    }

    // Označ jako FX Směna
    await sbPatch(`faktury?id=eq.${fakturaId}`, { kategorie_id: FX_KATEGORIE_ID })

    // Najdi CZK bankovní transakci: VS = cislo_faktury nebo částka + datum ±3 dny
    const fCastka = Number(f.castka_s_dph)
    const fDatum = String(f.datum_vystaveni || f.datum_splatnosti || '').split('T')[0]

    const match = transakce.find(t => {
      if (Number(t.castka) <= 0) return false // chceme příjem CZK
      // VS shoda
      const vs = String(t.zprava || t.variabilni_symbol || '')
      if (vs && (vs === cislo || vs.includes(cislo))) return true
      // Částka + datum
      const tDatum = String(t.datum || '').split('T')[0]
      return (
        Math.abs(Math.abs(Number(t.castka)) - fCastka) < 1 &&
        fDatum && tDatum && daysDiff(fDatum, tDatum) <= 3
      )
    })

    if (!match) {
      // Zkontroluj jestli jde o duplikátní potvrzení — hledej zaplacený FX doklad stejné částky + dodavatele
      const dupRes = await fetch(
        `${SUPABASE_URL}/rest/v1/faktury?dodavatel=eq.${encodeURIComponent(String(f.dodavatel))}&castka_s_dph=eq.${fCastka}&stav=eq.zaplacena&kategorie_id=eq.${FX_KATEGORIE_ID}&select=id&limit=1`,
        { headers: SB }
      )
      const dupData: { id: number }[] = await dupRes.json()
      const isDuplicate = Array.isArray(dupData) && dupData.length > 0
      if (isDuplicate) {
        await sbPatch(`faktury?id=eq.${fakturaId}`, { stav: 'zamitnuta' })
        log.push({ id: fakturaId, akce: 'zamitnuta_duplikat', detail: cislo })
      } else {
        log.push({ id: fakturaId, akce: 'ceka_na_transakci', detail: `${fCastka} CZK` })
      }
      continue
    }

    // Odeber z poolu
    transakce.splice(transakce.indexOf(match), 1)

    // ABRA banka doklad (CZK strana): MD 221 / DAL 261
    const abraOk = await createAbraFxBanka(f, match)

    // Supabase: faktura zaplacena, transakce sparovana
    await Promise.all([
      sbPatch(`faktury?id=eq.${fakturaId}`, {
        stav: 'zaplacena',
        zauctovano_at: new Date().toISOString(),
        zauctovano_platba: true,
      }),
      sbPatch(`transakce?id=eq.${match.id}`, {
        stav: 'sparovano',
        faktura_id: fakturaId,
      }),
    ])

    log.push({ id: fakturaId, akce: 'fx_zauctovano', detail: `transakce ${match.id}, abra: ${abraOk}` })
  }

  return NextResponse.json({ ok: true, processed: log.length, log })
}
