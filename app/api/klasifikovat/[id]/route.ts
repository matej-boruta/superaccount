import { NextResponse } from 'next/server'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY!
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY!

export async function POST(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  const fRes = await fetch(`${SUPABASE_URL}/rest/v1/faktury?id=eq.${id}&select=*`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
  })
  const [f] = await fRes.json()
  if (!f) return NextResponse.json({ error: 'Nenalezena' }, { status: 404 })

  // Already classified
  if (f.kategorie_id) return NextResponse.json({ kategorie_id: f.kategorie_id })

  // Check history: same ICO with kategorie_id already set
  if (f.ico) {
    const histRes = await fetch(
      `${SUPABASE_URL}/rest/v1/faktury?ico=eq.${encodeURIComponent(f.ico)}&kategorie_id=not.is.null&select=kategorie_id&order=id.desc&limit=1`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    )
    const [prev] = await histRes.json()
    if (prev?.kategorie_id) {
      await fetch(`${SUPABASE_URL}/rest/v1/faktury?id=eq.${id}`, {
        method: 'PATCH',
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({ kategorie_id: prev.kategorie_id }),
      })
      return NextResponse.json({ kategorie_id: prev.kategorie_id, source: 'history' })
    }
  }

  const kRes = await fetch(`${SUPABASE_URL}/rest/v1/kategorie?select=*&order=id.asc`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
  })
  const kategorieList = await kRes.json()
  if (!Array.isArray(kategorieList) || kategorieList.length === 0) {
    return NextResponse.json({ kategorie_id: null })
  }

  const kategorieId = await classifyWithAI(f, kategorieList)
  if (!kategorieId) return NextResponse.json({ kategorie_id: null })

  await fetch(`${SUPABASE_URL}/rest/v1/faktury?id=eq.${id}`, {
    method: 'PATCH',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify({ kategorie_id: kategorieId }),
  })

  return NextResponse.json({ kategorie_id: kategorieId })
}

async function classifyWithAI(f: { dodavatel?: string; popis?: string; castka_s_dph?: number; mena?: string }, kategorieList: { id: number; l1: string; l2: string; popis_pro_ai: string }[]): Promise<number | null> {
  if (!ANTHROPIC_API_KEY) return null

  const kategorieText = kategorieList.map(k =>
    `ID ${k.id}: ${k.l1} / ${k.l2} – ${k.popis_pro_ai}`
  ).join('\n')

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 10,
      messages: [{
        role: 'user',
        content: `Klasifikuj fakturu do správné kategorie. Odpověz POUZE číslem ID kategorie, nic jiného.

Faktura:
- Dodavatel: ${f.dodavatel || ''}
- Popis: ${f.popis || ''}
- Částka: ${f.castka_s_dph} ${f.mena || 'CZK'}

Dostupné kategorie:
${kategorieText}`,
      }],
    }),
  })

  const data = await res.json()
  const text = data?.content?.[0]?.text?.trim()
  const id = parseInt(text)
  if (isNaN(id) || id < 1 || id > kategorieList.length) return null
  return id
}
