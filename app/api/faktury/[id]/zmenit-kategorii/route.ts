/**
 * PATCH /api/faktury/[id]/zmenit-kategorii
 * Změní kategorii zaplacené faktury: uloží do Supabase a přeúčtuje v ABRA (polozkyFaktury.ucetni).
 */
import { NextResponse } from 'next/server'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY!
const ABRA_URL = process.env.ABRA_URL!
const ABRA_USER = process.env.ABRA_USER!
const ABRA_PASS = process.env.ABRA_PASS!
const ABRA_AUTH = 'Basic ' + Buffer.from(`${ABRA_USER}:${ABRA_PASS}`).toString('base64')
const SB = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { kategorie_id } = await req.json()

  if (!kategorie_id) return NextResponse.json({ error: 'kategorie_id required' }, { status: 400 })

  // 1. Fetch faktura + kategorie
  const [fRes, katRes] = await Promise.all([
    fetch(`${SUPABASE_URL}/rest/v1/faktury?id=eq.${id}&select=id,stav,mena,cislo_faktury`, { headers: SB }),
    fetch(`${SUPABASE_URL}/rest/v1/kategorie?id=eq.${kategorie_id}&select=id,ucetni_kod`, { headers: SB }),
  ])
  const [f] = await fRes.json()
  const [kat] = await katRes.json()

  if (!f) return NextResponse.json({ error: 'Faktura nenalezena' }, { status: 404 })
  if (!kat) return NextResponse.json({ error: 'Kategorie nenalezena' }, { status: 404 })

  // 2. Save to Supabase
  await fetch(`${SUPABASE_URL}/rest/v1/faktury?id=eq.${id}`, {
    method: 'PATCH',
    headers: { ...SB, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({ kategorie_id }),
  })

  // 3. Update ABRA if faktura is zaplacena
  if (f.stav !== 'zaplacena') return NextResponse.json({ ok: true, abra: 'skipped (not zaplacena)' })

  const year = new Date().getFullYear()
  const abraKod = `FP-${id}-${year}`

  const abraRes = await fetch(`${ABRA_URL}/faktura-prijata/(kod='${abraKod}').json?fields=id,polozkyFaktury(id)`, {
    headers: { Authorization: ABRA_AUTH },
  })
  const abraData = await abraRes.json()
  const abraFa = abraData?.winstrom?.['faktura-prijata']?.[0]
  if (!abraFa?.id) return NextResponse.json({ ok: true, abra: 'not_in_abra' })

  const polozky: { id: string }[] = abraFa.polozkyFaktury ?? []
  if (!polozky.length) return NextResponse.json({ ok: true, abra: 'no_polozky' })

  // Patch each polozka's ucetni to new ucetni_kod
  const patchRes = await fetch(`${ABRA_URL}/faktura-prijata/${abraFa.id}.json`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: ABRA_AUTH },
    body: JSON.stringify({
      winstrom: {
        'faktura-prijata': [{
          id: abraFa.id,
          polozkyFaktury: polozky.map(p => ({ id: p.id, ucetni: `code:${kat.ucetni_kod}` })),
        }],
      },
    }),
  })
  const patchData = await patchRes.json()
  const abraOk = patchData?.winstrom?.success === 'true'
  const abraErr = patchData?.winstrom?.results?.[0]?.errors?.[0]?.message

  return NextResponse.json({ ok: true, abra: abraOk ? 'updated' : abraErr ?? 'error' })
}
