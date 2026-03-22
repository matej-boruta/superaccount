/**
 * POST /api/google/save-token
 * Saves Google refresh token to Supabase google_tokens table.
 */
import { NextRequest, NextResponse } from 'next/server'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY!

export async function POST(req: NextRequest) {
  const { token, email } = await req.json()
  if (!token) return NextResponse.json({ error: 'No token' }, { status: 400 })
  if (!email) return NextResponse.json({ error: 'No email' }, { status: 400 })

  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/google_tokens`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify({
        email,
        refresh_token: token,
        updated_at: new Date().toISOString(),
      }),
    })

    if (!res.ok) {
      const err = await res.text()
      return NextResponse.json({ ok: false, error: err })
    }

    return NextResponse.json({ ok: true, email, method: 'supabase' })
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) })
  }
}
