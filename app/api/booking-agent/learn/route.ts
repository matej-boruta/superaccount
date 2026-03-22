/**
 * POST /api/booking-agent/learn
 *
 * Přečte celou historii faktur + transakcí a sestaví ucetni_vzory.
 * Sdílené napříč firmami — klíč je IČO dodavatele.
 * Respektuje české účetní principy (podvojnost, DUZP, DPH).
 */
import { NextResponse } from 'next/server'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY!
const SB = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
const SB_W = { ...SB, 'Content-Type': 'application/json', Prefer: 'return=minimal' }

// Czech accounting: kategorie_id → (md_ucet, stredisko)
const KATEGORIE_UCTY: Record<number, { md: string; stredisko: string }> = {
  1:  { md: '521100', stredisko: 'CS'      }, // Personální CS
  2:  { md: '521200', stredisko: 'MKT'     }, // Personální MKT
  3:  { md: '521300', stredisko: 'CEO'     }, // Personální CEO
  4:  { md: '521400', stredisko: 'PROVOZ'  }, // Personální Provoz
  5:  { md: '518100', stredisko: 'MKT'     }, // Marketing výkon
  6:  { md: '518200', stredisko: 'MKT'     }, // Marketing produkce
  7:  { md: '518300', stredisko: 'IT-CS'   }, // IT CS
  8:  { md: '518400', stredisko: 'IT-MKT'  }, // IT MKT
  9:  { md: '518500', stredisko: 'IT-PRD'  }, // IT Produkt
  10: { md: '548100', stredisko: 'REZIJE'  }, // Provozní režie
  11: { md: '549100', stredisko: 'MIMORAD' }, // Mimořádné
}

async function sbGet(path: string) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: SB })
  return res.json()
}

async function upsertVzor(vzor: Record<string, unknown>) {
  await fetch(`${SUPABASE_URL}/rest/v1/ucetni_vzory`, {
    method: 'POST',
    headers: {
      ...SB_W,
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(vzor),
  })
}

// Detect payment type from paired transakce
function detectTypPlatby(transakce: Record<string, unknown>[]): {
  typ: 'karta' | 'prevod' | null
  keyword: string | null
} {
  const card = transakce.find(t => t.typ === 'Platba kartou')
  if (card) {
    const zprava = String(card.zprava || '').toUpperCase()
    // Extract meaningful keyword (first 6+ char word)
    const words = zprava.replace(/[^A-Z0-9]/g, ' ').split(' ').filter(w => w.length >= 5)
    return { typ: 'karta', keyword: words[0] ?? null }
  }
  if (transakce.length > 0) return { typ: 'prevod', keyword: null }
  return { typ: null, keyword: null }
}

// Is this a reverse charge supplier? (non-CZ VAT, foreign company)
function isReverseCharge(f: Record<string, unknown>): boolean {
  const dic = String(f.dic || f.dodavatel_dic || '').toUpperCase()
  // Non-CZ VAT number = reverse charge §108/3 ZDPH
  return !!dic && !dic.startsWith('CZ') && dic.length > 4
}

export async function POST() {
  // Load all paid+approved faktury with their transakce
  const faktury: Record<string, unknown>[] = await sbGet(
    'faktury?stav=in.(zaplacena,schvalena)&select=*&order=id.asc'
  )
  const allTrans: Record<string, unknown>[] = await sbGet(
    'transakce?stav=eq.sparovano&select=*'
  )

  // Group transakce by faktura_id
  const transByFaktura = new Map<number, Record<string, unknown>[]>()
  for (const t of allTrans) {
    const fid = t.faktura_id as number
    if (!transByFaktura.has(fid)) transByFaktura.set(fid, [])
    transByFaktura.get(fid)!.push(t)
  }

  // Group faktury by dodavatel IČO (or name as fallback)
  type DodavatelGroup = {
    ico: string | null
    dodavatel: string
    faktury: Record<string, unknown>[]
    transakce: Record<string, unknown>[]
  }
  const groups = new Map<string, DodavatelGroup>()

  for (const f of faktury) {
    const ico = String(f.ico || '').trim() || null
    const dodavatel = String(f.dodavatel || '').trim()
    const key = ico || dodavatel
    if (!key) continue

    if (!groups.has(key)) {
      groups.set(key, { ico, dodavatel, faktury: [], transakce: [] })
    }
    const g = groups.get(key)!
    g.faktury.push(f)
    const t = transByFaktura.get(f.id as number) ?? []
    g.transakce.push(...t)
  }

  const learned: string[] = []

  for (const [key, g] of groups) {
    const { ico, dodavatel, faktury: fList, transakce: tList } = g
    if (fList.length === 0) continue

    // Most common kategorie_id
    const kIds = fList.map(f => f.kategorie_id as number).filter(Boolean)
    const mostCommonKat = kIds.sort(
      (a, b) => kIds.filter(v => v === b).length - kIds.filter(v => v === a).length
    )[0] ?? null
    const ucty = mostCommonKat ? KATEGORIE_UCTY[mostCommonKat] : { md: '518500', stredisko: 'IT-PRD' }

    // Payment type from history
    const { typ: typPlatby, keyword } = detectTypPlatby(tList)

    // DPH
    const sampleF = fList[0]
    const hasDph = fList.some(f => Number(f.dph) > 0)
    const reverseCharge = isReverseCharge(sampleF)
    const sazba = hasDph ? 21 : 0

    // Confidence: more faktury = more confidence
    const confidence = Math.min(95, 50 + fList.length * 5)

    // Faktura accounting entry
    const vzorFaktura: Record<string, unknown> = {
      ico: ico || null,
      dodavatel,
      typ_dokladu: 'faktura',
      md_ucet: ucty.md,
      dal_ucet: '321001',
      md_dph: hasDph && !reverseCharge ? '343' : null,
      dal_dph: hasDph && !reverseCharge ? '321001' : null,
      sazba_dph: sazba,
      stredisko: ucty.stredisko,
      kategorie_id: mostCommonKat,
      typ_platby: typPlatby,
      parovat_keyword: keyword,
      auto_schvalit: typPlatby === 'karta' && !!keyword,
      auto_parovat: typPlatby === 'karta' && !!keyword,
      confidence,
      pocet_pouziti: fList.length,
      zdroj: 'history',
      poznamka: reverseCharge
        ? 'Reverse charge §108 odst.3 ZDPH — DPH odvede odběratel'
        : (typPlatby === 'karta' ? 'DUZP = datum platby kartou (§21/5 ZDPH)' : null),
      aktualizovano: new Date().toISOString(),
    }

    // Payment accounting entry
    const vzorPlatba: Record<string, unknown> = {
      ico: ico || null,
      dodavatel,
      typ_dokladu: typPlatby === 'karta' ? 'platba_karta' : 'platba_prevod',
      md_ucet: '321001',
      dal_ucet: '221001',
      stredisko: ucty.stredisko,
      typ_platby: typPlatby,
      parovat_keyword: keyword,
      auto_schvalit: vzorFaktura.auto_schvalit as boolean,
      auto_parovat: vzorFaktura.auto_parovat as boolean,
      confidence,
      pocet_pouziti: tList.length,
      zdroj: 'history',
      aktualizovano: new Date().toISOString(),
    }

    await Promise.all([upsertVzor(vzorFaktura), upsertVzor(vzorPlatba)])
    learned.push(`${dodavatel} (${fList.length}x) → MD:${ucty.md}/DAL:321001 | ${typPlatby ?? 'neznámo'} | conf:${confidence}%`)
  }

  return NextResponse.json({
    ok: true,
    learned: learned.length,
    vzory: learned,
  })
}
