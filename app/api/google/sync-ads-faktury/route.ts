/**
 * POST /api/google/sync-ads-faktury
 *
 * Google Ads posílá faktury jako ODKAZ v emailu (ne příloha).
 * Workflow:
 *   1. Najde emaily od billing-noreply@google.com s Google Ads fakturou
 *   2. Extrahuje download link z HTML
 *   3. Stáhne PDF
 *   4. Parsuje přes Claude API (Anthropic)
 *   5. Uloží do Supabase faktury
 */
import { NextResponse } from 'next/server'

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID!
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET!
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY!
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY!

const SB = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }

async function getAccessToken(refreshToken: string): Promise<string> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: 'refresh_token',
    }),
  })
  const data = await res.json()
  if (data.error) throw new Error(data.error_description)
  return data.access_token
}

async function parsePdfWithClaude(pdfBase64: string, filename: string): Promise<{
  cislo_faktury: string | null
  variabilni_symbol: string | null
  castka_s_dph: number | null
  castka_bez_dph: number | null
  dph: number | null
  mena: string
  datum_vystaveni: string | null
  datum_splatnosti: string | null
  dodavatel: string
  popis: string
}> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'pdfs-2024-09-25',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'document',
            source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 },
          },
          {
            type: 'text',
            text: `Extrahuj z této faktury následující pole jako JSON (bez markdown):
{
  "cislo_faktury": "číslo faktury",
  "variabilni_symbol": "VS nebo číslo platebního profilu",
  "castka_s_dph": číslo,
  "castka_bez_dph": číslo,
  "dph": procento DPH (0 pokud neplátce),
  "mena": "CZK/EUR/USD",
  "datum_vystaveni": "YYYY-MM-DD",
  "datum_splatnosti": "YYYY-MM-DD nebo null",
  "dodavatel": "název firmy dodavatele",
  "popis": "krátký popis plnění"
}`,
          },
        ],
      }],
    }),
  })

  const data = await res.json()
  const text = data?.content?.[0]?.text ?? '{}'
  try {
    const parsed = JSON.parse(text.replace(/```json\n?|\n?```/g, '').trim())
    return {
      cislo_faktury: parsed.cislo_faktury ?? filename.replace('.pdf', ''),
      variabilni_symbol: parsed.variabilni_symbol ?? null,
      castka_s_dph: parsed.castka_s_dph ?? null,
      castka_bez_dph: parsed.castka_bez_dph ?? null,
      dph: parsed.dph ?? 0,
      mena: parsed.mena ?? 'EUR',
      datum_vystaveni: parsed.datum_vystaveni ?? null,
      datum_splatnosti: parsed.datum_splatnosti ?? null,
      dodavatel: parsed.dodavatel ?? 'Google Ireland Limited',
      popis: parsed.popis ?? 'Google Ads',
    }
  } catch {
    return {
      cislo_faktury: filename.replace('.pdf', ''),
      variabilni_symbol: null,
      castka_s_dph: null,
      castka_bez_dph: null,
      dph: 0,
      mena: 'EUR',
      datum_vystaveni: null,
      datum_splatnosti: null,
      dodavatel: 'Google Ireland Limited',
      popis: 'Google Ads',
    }
  }
}

export async function POST() {
  // Load stored Google tokens
  const tokensRes = await fetch(`${SUPABASE_URL}/rest/v1/google_tokens?select=*`, { headers: SB })
  const tokens: { email: string; refresh_token: string }[] = await tokensRes.json()

  if (!Array.isArray(tokens) || !tokens.length) {
    return NextResponse.json({
      error: 'Žádný Google účet není připojen',
      auth_url: 'https://approval-ui-alpha.vercel.app/api/google/auth',
    }, { status: 401 })
  }

  const results: { email: string; imported: number; skipped: number; errors: string[] }[] = []

  for (const tokenRow of tokens) {
    const accountResult = { email: tokenRow.email, imported: 0, skipped: 0, errors: [] as string[] }
    try {
      const accessToken = await getAccessToken(tokenRow.refresh_token)

      // Search for Google Ads invoice emails (last 180 days)
      const query = 'from:(billing-noreply@google.com OR payments-noreply@google.com) subject:(invoice OR faktura OR "your invoice") newer_than:180d'
      const searchRes = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=100`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      )
      const searchData = await searchRes.json()
      const messageIds: string[] = (searchData.messages ?? []).map((m: { id: string }) => m.id)

      for (const msgId of messageIds) {
        try {
          const msgRes = await fetch(
            `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msgId}?format=full`,
            { headers: { Authorization: `Bearer ${accessToken}` } }
          )
          const msg = await msgRes.json()
          const headers = msg.payload?.headers ?? []
          const getH = (name: string) => headers.find((h: { name: string; value: string }) => h.name.toLowerCase() === name)?.value ?? ''
          const subject = getH('subject')
          const date = getH('date')
          const emailDate = new Date(date).toISOString().split('T')[0]

          // First check PDF attachments (Workspace, Cloud)
          let pdfBase64: string | null = null
          let pdfFilename = 'invoice.pdf'

          const findParts = (payload: Record<string, unknown>): Record<string, unknown>[] => {
            const parts: Record<string, unknown>[] = []
            if (payload.parts) {
              for (const p of payload.parts as Record<string, unknown>[]) parts.push(...findParts(p))
            } else parts.push(payload)
            return parts
          }

          const allParts = findParts(msg.payload ?? {})
          const pdfPart = allParts.find(p =>
            String(p.mimeType ?? '').includes('pdf') ||
            String(p.filename ?? '').toLowerCase().endsWith('.pdf')
          )

          if (pdfPart) {
            const attachmentId = (pdfPart.body as Record<string, unknown>)?.attachmentId as string
            pdfFilename = String(pdfPart.filename ?? 'invoice.pdf')

            // Skip if already imported
            const existing = await (await fetch(
              `${SUPABASE_URL}/rest/v1/faktury?email_id=eq.${msgId}&limit=1`,
              { headers: SB }
            )).json()
            if (existing.length > 0) { accountResult.skipped++; continue }

            if (attachmentId) {
              const attRes = await fetch(
                `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msgId}/attachments/${attachmentId}`,
                { headers: { Authorization: `Bearer ${accessToken}` } }
              )
              const attData = await attRes.json()
              pdfBase64 = attData.data?.replace(/-/g, '+').replace(/_/g, '/') ?? null
            }
          } else {
            // No PDF attachment — look for download link in HTML body (Google Ads)
            const htmlPart = allParts.find(p => String(p.mimeType ?? '') === 'text/html')
            if (!htmlPart) { accountResult.skipped++; continue }

            const bodyData = String((htmlPart.body as Record<string, unknown>)?.data ?? '')
            const html = Buffer.from(bodyData.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')

            // Find PDF download link
            const linkMatch = html.match(/href="(https:\/\/[^"]*(?:invoice|billing|faktura)[^"]*\.pdf[^"]*)"/i)
              ?? html.match(/href="(https:\/\/payments\.google\.com[^"]*)"/i)
              ?? html.match(/"(https:\/\/storage\.googleapis\.com[^"]*\.pdf[^"]*)"/i)

            if (!linkMatch) { accountResult.skipped++; continue }

            const pdfUrl = linkMatch[1].replace(/&amp;/g, '&')

            // Skip if already imported
            const existing = await (await fetch(
              `${SUPABASE_URL}/rest/v1/faktury?email_id=eq.${msgId}&limit=1`,
              { headers: SB }
            )).json()
            if (existing.length > 0) { accountResult.skipped++; continue }

            // Download PDF with Google auth
            const pdfRes = await fetch(pdfUrl, {
              headers: { Authorization: `Bearer ${accessToken}` },
            })
            if (!pdfRes.ok) { accountResult.skipped++; continue }

            const pdfBuffer = await pdfRes.arrayBuffer()
            pdfBase64 = Buffer.from(pdfBuffer).toString('base64')
            pdfFilename = pdfUrl.split('/').pop()?.split('?')[0] ?? 'invoice.pdf'
          }

          if (!pdfBase64) { accountResult.skipped++; continue }

          // Parse PDF with Claude
          const parsed = await parsePdfWithClaude(pdfBase64, pdfFilename)

          // Store in Supabase
          await fetch(`${SUPABASE_URL}/rest/v1/faktury`, {
            method: 'POST',
            headers: { ...SB, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
            body: JSON.stringify({
              ...parsed,
              stav: 'nova',
              email_id: msgId,
              predmet: subject.substring(0, 200),
            }),
          })
          accountResult.imported++

        } catch (e) {
          accountResult.errors.push(`${msgId}: ${String(e).substring(0, 100)}`)
        }
      }
    } catch (e) {
      accountResult.errors.push(`Auth: ${String(e).substring(0, 100)}`)
    }
    results.push(accountResult)
  }

  const total = results.reduce((s, r) => s + r.imported, 0)
  return NextResponse.json({ ok: true, imported: total, accounts: results })
}
