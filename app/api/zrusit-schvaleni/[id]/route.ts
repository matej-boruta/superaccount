import { NextResponse } from 'next/server'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY!
const ABRA_URL = process.env.ABRA_URL!
const ABRA_USER = process.env.ABRA_USER!
const ABRA_PASS = process.env.ABRA_PASS!
const ABRA_AUTH = 'Basic ' + Buffer.from(`${ABRA_USER}:${ABRA_PASS}`).toString('base64')

export async function POST(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  // 1. Reset faktura in Supabase
  await fetch(`${SUPABASE_URL}/rest/v1/faktury?id=eq.${id}`, {
    method: 'PATCH',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify({ stav: 'nova', platba_naplanovana: false, datum_platby: null }),
  })

  // 2. Delete faktura-prijata from ABRA
  const abraKod = `FP-${id}-${new Date().getFullYear()}`
  try {
    const findRes = await fetch(`${ABRA_URL}/faktura-prijata/(kod='${abraKod}').json?fields=id`, {
      headers: { Authorization: ABRA_AUTH },
    })
    const findData = await findRes.json()
    const abraFa = findData?.winstrom?.['faktura-prijata']?.[0]
    if (abraFa?.id) {
      await fetch(`${ABRA_URL}/faktura-prijata/${abraFa.id}.json`, {
        method: 'DELETE',
        headers: { Authorization: ABRA_AUTH },
      })
    }
  } catch { /* non-blocking */ }

  return NextResponse.json({ ok: true })
}
