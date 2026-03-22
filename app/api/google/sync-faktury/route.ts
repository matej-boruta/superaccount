/**
 * POST /api/google/sync-faktury
 *
 * Stáhne faktury z Gmailu pro:
 * - Google Ads (sender: billing-noreply@google.com)
 * - Google Cloud (sender: invoicing@google.com)
 * - Google Workspace (sender: noreply@google.com)
 *
 * Parsuje PDF přílohy → uloží do Supabase faktury tabulky.
 */
import { NextResponse } from 'next/server'

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID!
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET!
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY!

const SB = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }

// Google invoice senders
const GOOGLE_SENDERS = [
  'billing-noreply@google.com',       // Google Ads
  'invoicing@google.com',             // Google Cloud
  'noreply-apps-invoice@google.com',  // Workspace
  'payments-noreply@google.com',      // Google Pay
]

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

async function gmailSearch(accessToken: string, query: string): Promise<string[]> {
  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=50`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  )
  const data = await res.json()
  return (data.messages ?? []).map((m: { id: string }) => m.id)
}

async function getMessage(accessToken: string, messageId: string) {
  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=full`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  )
  return res.json()
}

async function getAttachment(accessToken: string, messageId: string, attachmentId: string): Promise<string> {
  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/attachments/${attachmentId}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  )
  const data = await res.json()
  return data.data // base64url encoded
}

function getHeader(headers: { name: string; value: string }[], name: string): string {
  return headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value ?? ''
}

function extractParts(payload: Record<string, unknown>): Record<string, unknown>[] {
  const parts: Record<string, unknown>[] = []
  if (payload.parts) {
    for (const part of payload.parts as Record<string, unknown>[]) {
      parts.push(...extractParts(part))
    }
  } else {
    parts.push(payload)
  }
  return parts
}

// Parse key fields from PDF text (pdftotext output)
function parsePdfText(text: string, sender: string): Partial<{
  cislo_faktury: string
  variabilni_symbol: string
  castka_s_dph: number
  castka_bez_dph: number
  dph: number
  mena: string
  datum_vystaveni: string
  datum_splatnosti: string
  dodavatel: string
  popis: string
}> {
  const result: ReturnType<typeof parsePdfText> = {}

  // Invoice number
  const invoiceMatch = text.match(/(?:Invoice|Faktura|Document)\s*(?:ID|No|#|č\.?)[:\s]*([A-Z0-9\-]+)/i)
    ?? text.match(/(\d{10,})/m) // fallback: long number
  if (invoiceMatch) result.cislo_faktury = invoiceMatch[1].trim()

  // Amount — look for total
  const amountMatch = text.match(/(?:Total|Celkem|Amount due)[:\s]*([€$]?\s*[\d,\.]+)\s*(CZK|EUR|USD|GBP)?/i)
  if (amountMatch) {
    result.castka_s_dph = parseFloat(amountMatch[1].replace(/[,\s€$]/g, '').replace(',', '.'))
    result.mena = amountMatch[2] ?? (amountMatch[1].includes('€') ? 'EUR' : amountMatch[1].includes('$') ? 'USD' : 'CZK')
  }

  // Date issued
  const dateMatch = text.match(/(?:Issue date|Datum vystavení|Invoice date)[:\s]*(\d{1,2}[\.\-\/]\d{1,2}[\.\-\/]\d{2,4})/i)
    ?? text.match(/(\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s+\d{4})/i)
  if (dateMatch) {
    const d = new Date(dateMatch[1].replace(/\./g, '/'))
    if (!isNaN(d.getTime())) result.datum_vystaveni = d.toISOString().split('T')[0]
  }

  // Supplier based on sender
  if (sender.includes('google')) {
    if (text.toLowerCase().includes('ads') || text.toLowerCase().includes('advertising')) {
      result.dodavatel = 'Google Ireland Limited'
      result.popis = 'Google Ads'
    } else if (text.toLowerCase().includes('cloud')) {
      result.dodavatel = 'Google Cloud EMEA Limited'
      result.popis = 'Google Cloud'
    } else if (text.toLowerCase().includes('workspace')) {
      result.dodavatel = 'Google Ireland Limited'
      result.popis = 'Google Workspace'
    } else {
      result.dodavatel = 'Google Ireland Limited'
    }
  }

  return result
}

export async function POST() {
  // Load all stored Google tokens
  const tokensRes = await fetch(`${SUPABASE_URL}/rest/v1/google_tokens?select=*`, { headers: SB })
  const tokens: { email: string; refresh_token: string }[] = await tokensRes.json()

  if (!tokens.length) {
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

      // Search for Google invoice emails (last 90 days)
      const query = `from:(${GOOGLE_SENDERS.join(' OR ')}) subject:(invoice OR faktura OR "payment receipt") newer_than:90d has:attachment filename:pdf`
      const messageIds = await gmailSearch(accessToken, query)

      for (const msgId of messageIds) {
        try {
          const msg = await getMessage(accessToken, msgId)
          const headers = msg.payload?.headers ?? []
          const subject = getHeader(headers, 'subject')
          const from = getHeader(headers, 'from')
          const date = getHeader(headers, 'date')
          const emailDate = new Date(date).toISOString().split('T')[0]

          // Find PDF attachments
          const parts = extractParts(msg.payload ?? {})
          const pdfParts = parts.filter((p: Record<string, unknown>) =>
            String(p.mimeType ?? '').includes('pdf') ||
            String((p.filename as string) ?? '').toLowerCase().endsWith('.pdf')
          )

          for (const part of pdfParts) {
            const attachmentId = (part.body as Record<string, unknown>)?.attachmentId as string
            if (!attachmentId) continue

            const filename = String(part.filename ?? 'invoice.pdf')

            // Check if already imported (by filename + date)
            const existingRes = await fetch(
              `${SUPABASE_URL}/rest/v1/faktury?cislo_faktury=eq.${encodeURIComponent(filename)}&datum_vystaveni=eq.${emailDate}&limit=1`,
              { headers: SB }
            )
            const existing = await existingRes.json()
            if (existing.length > 0) { accountResult.skipped++; continue }

            // Download PDF
            const b64 = await getAttachment(accessToken, msgId, attachmentId)
            const pdfBuffer = Buffer.from(b64.replace(/-/g, '+').replace(/_/g, '/'), 'base64')

            // Parse PDF with pdftotext
            let pdfText = ''
            try {
              const { execSync } = await import('child_process')
              const tmpPath = `/tmp/google_invoice_${msgId}_${Date.now()}.pdf`
              require('fs').writeFileSync(tmpPath, pdfBuffer)
              pdfText = execSync(`pdftotext "${tmpPath}" -`, { encoding: 'utf8', timeout: 10000 })
              require('fs').unlinkSync(tmpPath)
            } catch { /* pdftotext not available on Vercel edge, skip */ }

            const parsed = parsePdfText(pdfText || subject, from)

            // Store in Supabase
            const faktura = {
              cislo_faktury: parsed.cislo_faktury ?? filename,
              dodavatel: parsed.dodavatel ?? 'Google Ireland Limited',
              popis: parsed.popis ?? subject.substring(0, 200),
              castka_s_dph: parsed.castka_s_dph ?? 0,
              castka_bez_dph: parsed.castka_bez_dph ?? 0,
              dph: parsed.dph ?? 0,
              mena: parsed.mena ?? 'EUR',
              datum_vystaveni: parsed.datum_vystaveni ?? emailDate,
              datum_splatnosti: parsed.datum_splatnosti ?? emailDate,
              variabilni_symbol: parsed.variabilni_symbol ?? '',
              stav: 'nova',
              zdroj: 'google_gmail',
              gmail_message_id: msgId,
            }

            await fetch(`${SUPABASE_URL}/rest/v1/faktury`, {
              method: 'POST',
              headers: {
                ...SB,
                'Content-Type': 'application/json',
                Prefer: 'return=minimal',
              },
              body: JSON.stringify(faktura),
            })
            accountResult.imported++
          }
        } catch (e) {
          accountResult.errors.push(`${msgId}: ${String(e).substring(0, 100)}`)
        }
      }
    } catch (e) {
      accountResult.errors.push(`Auth error: ${String(e).substring(0, 100)}`)
    }

    results.push(accountResult)
  }

  const totalImported = results.reduce((s, r) => s + r.imported, 0)
  return NextResponse.json({ ok: true, imported: totalImported, accounts: results })
}
