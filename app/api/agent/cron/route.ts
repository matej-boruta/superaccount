/**
 * GET /api/agent/cron
 * Vercel Cron job — spouští PM agenta automaticky každý pracovní den v 7:00.
 * Konfigurováno v vercel.json: { "path": "/api/agent/cron", "schedule": "0 7 * * 1-5" }
 *
 * Autorizace: Vercel posílá hlavičku Authorization: Bearer <CRON_SECRET>
 */
import { NextResponse } from 'next/server'

export async function GET(req: Request) {
  const authHeader = req.headers.get('authorization')
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const year = new Date().getFullYear()
  const baseUrl = process.env.NEXTAUTH_URL
    ?? (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000')

  try {
    // 1. Architekt — proaktivní monitoring (první, detekuje problémy před PM)
    const architectRes = await fetch(`${baseUrl}/api/agent/architect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    })
    const architectData = await architectRes.json()

    // 2. PM — denní plánování
    const res = await fetch(`${baseUrl}/api/agent/pm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ year }),
    })
    const data = await res.json()

    return NextResponse.json({
      ok: true,
      year,
      architect: { findings: architectData.findings_count ?? 0, critical: architectData.critical ?? 0 },
      agent_result: data.type,
      summary: data.summary ?? null,
      question: data.type === 'question' ? data.otazka : null,
    })
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 })
  }
}
