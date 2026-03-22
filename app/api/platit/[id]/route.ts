import { NextResponse } from 'next/server'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY!
const ABRA_URL = process.env.ABRA_URL!
const ABRA_USER = process.env.ABRA_USER!
const ABRA_PASS = process.env.ABRA_PASS!
const ABRA_AUTH = 'Basic ' + Buffer.from(`${ABRA_USER}:${ABRA_PASS}`).toString('base64')
const FIO_TOKEN = process.env.FIO_TOKEN!
const FIO_ACCOUNT = process.env.FIO_ACCOUNT!

export async function POST(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  const fRes = await fetch(`${SUPABASE_URL}/rest/v1/faktury?id=eq.${id}&select=*`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  })
  const [f] = await fRes.json()
  if (!f) return NextResponse.json({ error: 'Faktura nenalezena' }, { status: 404 })
  if (f.stav !== 'schvalena') return NextResponse.json({ error: 'Faktura není schválena' }, { status: 400 })

  // Look up supplier bank account from ABRA adresar
  const abraKod = `FP-${id}-${new Date().getFullYear()}`
  const faRes = await fetch(`${ABRA_URL}/faktura-prijata/(kod='${abraKod}').json?fields=id,firma`, {
    headers: { Authorization: ABRA_AUTH },
  })
  const faData = await faRes.json()
  const abraFa = faData?.winstrom?.['faktura-prijata']?.[0]

  let cisloUctu: string | null = null
  let kodBanky: string | null = null

  if (abraFa?.firma) {
    const firmaId = abraFa.firma['@ref']?.match(/\/(\d+)\.json/)?.[1] ?? abraFa.firma
    const adresarRes = await fetch(`${ABRA_URL}/adresar/${firmaId}.json?fields=id,bankovniUcty`, {
      headers: { Authorization: ABRA_AUTH },
    })
    const adresarData = await adresarRes.json()
    const ucty = adresarData?.winstrom?.adresar?.[0]?.bankovniUcty ?? []
    if (ucty.length > 0) {
      cisloUctu = ucty[0].cisloUctu ?? null
      kodBanky = ucty[0].kodBanky ?? null
    }
  }

  if (!cisloUctu || !kodBanky) {
    return NextResponse.json({
      error: 'Chybí číslo účtu dodavatele v ABRA — doplňte v Adresáři',
      faktura_id: id,
    }, { status: 422 })
  }

  const datumPlatby = f.datum_platby ?? new Date().toISOString().split('T')[0]
  const castka = Number(f.castka_s_dph)
  const mena = f.mena || 'CZK'

  const xml = `<?xml version="1.0" encoding="utf-8"?>
<Import xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:noNamespaceSchemaLocation="http://www.fio.cz/schema/importIB.xsd">
  <Orders>
    <DomesticTransaction>
      <accountFrom>${FIO_ACCOUNT}</accountFrom>
      <currency>${mena}</currency>
      <amount>${castka}</amount>
      <accountTo>${cisloUctu}</accountTo>
      <bankCode>${kodBanky}</bankCode>
      <vs>${f.variabilni_symbol || ''}</vs>
      <date>${datumPlatby}</date>
      <messageForRecipient>${(f.popis || f.dodavatel || '').substring(0, 140)}</messageForRecipient>
      <comment>SuperAccount ${abraKod}</comment>
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
  const ok = fioRes.status === 200
  const paymentId = fioText.match(/<id>(\d+)<\/id>/)?.[1] ?? null

  return NextResponse.json({ ok, payment_id: paymentId, error: ok ? undefined : fioText.substring(0, 200) })
}
