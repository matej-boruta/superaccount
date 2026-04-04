import { NextResponse } from 'next/server'
import { callClaude, SYSTEM_AGENT } from '@/lib/claude'
import { findBestPravidlo, savePravidlo, logDecision } from '@/lib/rules'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY!
const ABRA_URL = process.env.ABRA_URL!
const ABRA_USER = process.env.ABRA_USER!
const ABRA_PASS = process.env.ABRA_PASS!
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY!

const ABRA_AUTH = 'Basic ' + Buffer.from(`${ABRA_USER}:${ABRA_PASS}`).toString('base64')
const FIO_TOKEN = process.env.FIO_TOKEN
const FIO_ACCOUNT = process.env.FIO_ACCOUNT

// Fallback keyword-based account mapping
function getAccountFallback(dodavatel: string, popis: string): { ucetni_kod: string; stredisko: string } {
  const text = `${dodavatel} ${popis}`.toLowerCase()
  if (text.includes('nájem') || text.includes('leasing')) return { ucetni_kod: '548100', stredisko: 'REZIJE' }
  if (text.includes('oprav') || text.includes('údržb')) return { ucetni_kod: '548100', stredisko: 'REZIJE' }
  if (text.includes('cestov') || text.includes('hotel') || text.includes('letenk')) return { ucetni_kod: '518500', stredisko: 'IT-PRD' }
  return { ucetni_kod: '518500', stredisko: 'IT-PRD' }
}

function addWorkingDays(date: Date, days: number): Date {
  const result = new Date(date)
  let subtracted = 0
  while (subtracted < days) {
    result.setDate(result.getDate() - 1)
    const dow = result.getDay()
    if (dow !== 0 && dow !== 6) subtracted++
  }
  return result
}

async function classifyWithAI(f: { dodavatel?: string; popis?: string; castka_s_dph?: number; mena?: string }, kategorieList: { id: number; l1: string; l2: string; popis_pro_ai: string }[]): Promise<number | null> {
  if (!ANTHROPIC_API_KEY || !kategorieList?.length) return null

  const kategorieText = kategorieList.map(k =>
    `ID ${k.id}: ${k.l1} / ${k.l2} – ${k.popis_pro_ai}`
  ).join('\n')

  const text = await callClaude(
    ANTHROPIC_API_KEY,
    [{
      role: 'user',
      content: `Klasifikuj fakturu do správné kategorie. Odpověz POUZE číslem ID kategorie, nic jiného.

Faktura:
- Dodavatel: ${f.dodavatel || ''}
- Popis: ${f.popis || ''}
- Částka: ${f.castka_s_dph} ${f.mena || 'CZK'}

Dostupné kategorie:
${kategorieText}`,
    }],
    { model: 'claude-haiku-4-5-20251001', maxTokens: 10, system: SYSTEM_AGENT }
  )

  const id = parseInt(text ?? '')
  if (isNaN(id) || id < 1 || id > kategorieList.length) return null
  return id
}

async function getOrCreateAbraFirma(ico: string, nazev: string): Promise<string | null> {
  if (!ico) return null
  try {
    // Fetch all contacts and find by IC client-side (ABRA filter doesn't work reliably)
    const res = await fetch(`${ABRA_URL}/adresar.json?limit=2000&detail=custom:id,ic,nazev`, {
      headers: { Authorization: ABRA_AUTH }
    })
    const data = await res.json()
    const contacts: { id: string; ic: string; nazev: string }[] = data?.winstrom?.adresar || []
    const found = contacts.find(c => c.ic === ico)
    if (found) return found.id

    // Create new contact
    const createRes = await fetch(`${ABRA_URL}/adresar.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: ABRA_AUTH },
      body: JSON.stringify({ winstrom: { adresar: [{ nazev, ic: ico }] } }),
    })
    const createData = await createRes.json()
    return createData?.winstrom?.results?.[0]?.id ?? null
  } catch {
    return null
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  // Support override kategorie_id from request body
  let bodyKategorieId: number | undefined
  try {
    const body = await req.json()
    if (body?.kategorie_id) bodyKategorieId = Number(body.kategorie_id)
  } catch { /* no body */ }

  // 1. Fetch faktura from Supabase
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/faktury?id=eq.${id}&select=*`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
  )
  const [f] = await res.json()
  if (!f) return NextResponse.json({ error: 'Faktura nenalezena' }, { status: 404 })

  // 2. Fetch kategorie list
  const kRes = await fetch(`${SUPABASE_URL}/rest/v1/kategorie?select=*&order=id.asc`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
  })
  const kategorieList = await kRes.json()

  // 3. Determine kategorie: body override > ucetni_pravidla > already on faktura > AI classification
  let kategorieId: number | null = bodyKategorieId ?? null

  // Načti pravidlo pro předkontaci
  const pravidlo = await findBestPravidlo(f.dodavatel ?? '', f.ico ?? null, 'predkontace')

  if (!kategorieId) kategorieId = pravidlo?.kategorie_id ?? f.kategorie_id ?? null

  if (!kategorieId && Array.isArray(kategorieList) && kategorieList.length > 0) {
    kategorieId = await classifyWithAI(f, kategorieList)
  }

  // Učení ze schválení
  const autoKategorieId = pravidlo?.kategorie_id ?? f.kategorie_id ?? null

  if (bodyKategorieId && bodyKategorieId !== autoKategorieId && f.dodavatel) {
    // KOREKCE — uživatel změnil kategorii → nové pravidlo s conf 95
    await savePravidlo({
      typ: 'predkontace',
      dodavatel: f.dodavatel,
      ico: f.ico ?? null,
      kategorie_id: bodyKategorieId,
      confidence: 95,
      zdroj: 'manual',
      poznamka: `Manuální korekce při schválení faktury ${id}`,
    })
    await logDecision({
      typ: 'korekce',
      vstup: { faktura_id: Number(id), dodavatel: f.dodavatel, auto_kategorie: autoKategorieId },
      vystup: { kategorie_id: bodyKategorieId, zdroj: 'manual_schvaleni' },
      confidence: 95,
      pravidlo_zdroj: 'manual',
      faktura_id: Number(id),
    })
  } else if (pravidlo?.id && (!bodyKategorieId || bodyKategorieId === autoKategorieId)) {
    // TICHÉ POTVRZENÍ — schváleno bez změny kategorie → posil confidence pravidla o 2 (max 95)
    ;(async () => {
      try {
        const newConf = Math.min(95, pravidlo.confidence + 2)
        if (newConf > pravidlo.confidence) {
          await fetch(`${SUPABASE_URL}/rest/v1/pravidla?id=eq.${pravidlo.id}`, {
            method: 'PATCH',
            headers: {
              apikey: SUPABASE_KEY,
              Authorization: `Bearer ${SUPABASE_KEY}`,
              'Content-Type': 'application/json',
              Prefer: 'return=minimal',
            },
            body: JSON.stringify({ confidence: newConf }),
          })
        }
      } catch { /* non-blocking */ }
    })()
  }

  const kategorie = Array.isArray(kategorieList)
    ? kategorieList.find((k: { id: number }) => k.id === kategorieId)
    : null

  // Předkontace: pravidlo z DB > kategorie.ucetni_kod > fallback
  const ucetni_kod = pravidlo?.md_ucet ?? kategorie?.ucetni_kod ?? getAccountFallback(f.dodavatel || '', f.popis || '').ucetni_kod
  const stredisko = kategorie?.stredisko ?? getAccountFallback(f.dodavatel || '', f.popis || '').stredisko

  // 4. Compute payment date (1 working day before due) — only if splatnost is valid
  const splatnostRaw = f.datum_splatnosti
  const splatnostYear = splatnostRaw ? parseInt(splatnostRaw.split('-')[0]) : 0
  const splatnostValid = splatnostYear >= 2020 && splatnostYear <= 2100
  const splatnost = splatnostValid ? new Date(splatnostRaw) : new Date()
  const datumPlatby = addWorkingDays(splatnost, 1)
  const datumPlatbyStr = splatnostValid ? datumPlatby.toISOString().split('T')[0] : null

  // 5. Update Supabase
  await fetch(`${SUPABASE_URL}/rest/v1/faktury?id=eq.${id}`, {
    method: 'PATCH',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify({
      stav: 'schvalena',
      zauctovano_at: new Date().toISOString(),
      platba_naplanovana: true,
      datum_platby: datumPlatbyStr,
      kategorie_id: kategorieId,
    }),
  })

  // 6. Create faktura-prijata in ABRA
  const abraKod = `FP-${id}-${new Date().getFullYear()}`
  const mena = f.mena || 'CZK'
  const abraFirmaId = await getOrCreateAbraFirma(f.ico || '', f.dodavatel || '')

  const abraFaRes = await fetch(`${ABRA_URL}/faktura-prijata.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: ABRA_AUTH },
    body: JSON.stringify({
      winstrom: {
        'faktura-prijata': [{
          typDokl: 'code:FAKTURA',
          kod: abraKod,
          ...(abraFirmaId ? { firma: abraFirmaId } : {}),
          cisDosle: f.cislo_faktury || abraKod,
          varSym: f.variabilni_symbol || '',
          datVyst: f.datum_vystaveni || new Date().toISOString().split('T')[0],
          datSplat: f.datum_splatnosti,
          datUcto: new Date().toISOString().split('T')[0],
          popis: f.popis || f.dodavatel,
          mena: `code:${mena}`,
          stredisko: `code:${stredisko}`,
          polozkyFaktury: [{
            nazev: f.popis || f.dodavatel,
            cenaMj: Number(f.castka_bez_dph),
            mnozstvi: 1,
            sazbyDph: Number(f.dph) > 0 ? 'typSazbyDph.zakladni' : 'typSazbyDph.dphOsvobozeno',
            ucetni: `code:${ucetni_kod}`,
            stredisko: `code:${stredisko}`,
          }],
        }],
      },
    }),
  })

  const abraFaData = await abraFaRes.json()
  const abraFaId = abraFaData?.winstrom?.results?.[0]?.id
  const abraSuccess = abraFaData?.winstrom?.success === 'true'

  // 7. Create prikaz-k-uhrade if faktura created
  let abraPrikazId: string | null = null
  if (abraSuccess && abraFaId) {
    const prikazRes = await fetch(`${ABRA_URL}/prikaz-k-uhrade.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: ABRA_AUTH },
      body: JSON.stringify({
        winstrom: {
          'prikaz-k-uhrade': [{
            banka: 'code:BANKOVNÍ ÚČET',
            datSplat: datumPlatbyStr,
            polozkyPrikazuUhrady: [{
              dokladFaktury: `id:${abraFaId}`,
              varSym: f.variabilni_symbol || '',
              castka: Number(f.castka_s_dph),
              mena: `code:${mena}`,
            }],
          }],
        },
      }),
    })
    const prikazData = await prikazRes.json()
    abraPrikazId = prikazData?.winstrom?.results?.[0]?.id || null
  }

  // 8. Auto-pay via FIO if token + bank account available
  let fioResult: { ok: boolean; payment_id?: string; error?: string } = { ok: false, error: 'FIO not configured' }
  if (FIO_TOKEN && FIO_ACCOUNT && f.cislo_uctu && f.kod_banky) {
    try {
      const xml = `<?xml version="1.0" encoding="utf-8"?>
<Import xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:noNamespaceSchemaLocation="http://www.fio.cz/schema/importIB.xsd">
  <Orders>
    <DomesticTransaction>
      <accountFrom>${FIO_ACCOUNT}</accountFrom>
      <currency>${mena}</currency>
      <amount>${Number(f.castka_s_dph)}</amount>
      <accountTo>${f.cislo_uctu}</accountTo>
      <bankCode>${f.kod_banky}</bankCode>
      <vs>${f.variabilni_symbol || ''}</vs>
      <date>${datumPlatbyStr}</date>
      <messageForRecipient>${(f.popis || f.dodavatel || '').substring(0, 140)}</messageForRecipient>
      <comment>SuperAccount FP-${id}</comment>
      <paymentType>431001</paymentType>
    </DomesticTransaction>
  </Orders>
</Import>`
      const fioRes = await fetch(`https://www.fio.cz/ib_api/rest/import/?token=${FIO_TOKEN}&type=xml&language=cs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/xml' },
        body: xml,
      })
      const fioText = await fioRes.text()
      const paymentId = fioText.match(/<id>(\d+)<\/id>/)?.[1] ?? null
      const fioOk = fioRes.status === 200
      if (fioOk) {
        await fetch(`${SUPABASE_URL}/rest/v1/faktury?id=eq.${id}`, {
          method: 'PATCH',
          headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
          body: JSON.stringify({ fio_payment_id: paymentId, fio_stav: 'odeslano' }),
        })
      }
      fioResult = { ok: fioOk, payment_id: paymentId ?? undefined }
    } catch (e) {
      fioResult = { ok: false, error: String(e) }
    }
  }

  return NextResponse.json({
    ok: true,
    datum_platby: datumPlatbyStr,
    kategorie: kategorie ? { id: kategorieId, l1: kategorie.l1, l2: kategorie.l2, ucetni_kod, stredisko } : null,
    abra: {
      success: abraSuccess,
      faktura_id: abraFaId,
      prikaz_id: abraPrikazId,
      ucetni_kod,
      stredisko,
    },
    fio: fioResult,
  })
}
