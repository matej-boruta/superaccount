import { NextResponse } from 'next/server'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY!

function addWorkingDays(date: Date, days: number): Date {
  const result = new Date(date)
  let added = 0
  while (added < days) {
    result.setDate(result.getDate() - 1)
    const dow = result.getDay()
    if (dow !== 0 && dow !== 6) added++
  }
  return result
}

export async function POST(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  // Get invoice due date
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/faktury?id=eq.${id}&select=datum_splatnosti`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
  )
  const [faktura] = await res.json()
  if (!faktura) return NextResponse.json({ error: 'Faktura nenalezena' }, { status: 404 })

  const splatnost = new Date(faktura.datum_splatnosti)
  const datumPlatby = addWorkingDays(splatnost, 1)
  const datumPlatbyStr = datumPlatby.toISOString().split('T')[0]

  // Approve + schedule payment
  await fetch(
    `${SUPABASE_URL}/rest/v1/faktury?id=eq.${id}`,
    {
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
      }),
    }
  )

  return NextResponse.json({ ok: true, datum_platby: datumPlatbyStr })
}
