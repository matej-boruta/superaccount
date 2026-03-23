/**
 * POST /api/google/sync-ads-api
 *
 * Stahuje faktury z Google Ads API (InvoiceService.ListInvoices).
 * Nevyžaduje parsování emailů — přímý přístup k PDF přes API.
 *
 * Potřebuje:
 *   - GOOGLE_ADS_DEVELOPER_TOKEN (z Google Ads → Nástroje → API Center)
 *   - GOOGLE_ADS_CUSTOMER_ID (číslo účtu bez pomlček, např. 218298479)
 *   - OAuth token s scope: adwords (re-auth přes /api/google/auth)
 */
import { NextResponse } from 'next/server'

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID!
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET!
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY!
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY!
const DEVELOPER_TOKEN = process.env.GOOGLE_ADS_DEVELOPER_TOKEN!
const CUSTOMER_ID = process.env.GOOGLE_ADS_CUSTOMER_ID || '218298479'
const DRIVE_FOLDER_ID = '19uD7bGxQTbDLn57L4tpBtH-9bG4lYXl8'

const SB = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
const SB_W = { ...SB, 'Content-Type': 'application/json', Prefer: 'return=minimal' }

const MONTHS = [
  'JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE',
  'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER',
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
  if (data.error) throw new Error(data.error_description ?? data.error)
  return data.access_token
}

async function listInvoices(
  accessToken: string,
  year: number,
  month: string
): Promise<AdsInvoice[]> {
  const res = await fetch(
    `https://googleads.googleapis.com/v18/customers/${CUSTOMER_ID}/invoices:listInvoices` +
    `?issue_year=${year}&issue_month=${month}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'developer-token': DEVELOPER_TOKEN,
        'login-customer-id': CUSTOMER_ID,
      },
    }
  )
  const data = await res.json()
  if (data.error) {
    // Ignore "no invoices" errors
    if (String(data.error.message ?? '').includes('no invoice')) return []
    throw new Error(JSON.stringify(data.error))
  }
  return data.invoices ?? []
}

type AdsInvoice = {
  resourceName: string
  id: string
  billingSetup: string
  issueDate: string
  dueDate: string
  serviceDateRange: { startDate: string; endDate: string }
  currencyCode: string
  adjustmentsSubtotalAmountMicros: string
  adjustmentsTaxAmountMicros: string
  adjustmentsTotalAmountMicros: string
  replacedInvoices: string[]
  pdf: { pdfUrl: string }
  subtotalAmountMicros: string
  taxAmountMicros: string
  totalAmountMicros: string
  correctedInvoice: string
  accountBudgetSummaries: {
    customer: string
    customerDescriptiveName: string
    accountBudget: string
    accountBudgetName: string
    purchaseOrderNumber: string
    subtotalAmountMicros: string
    taxAmountMicros: string
    totalAmountMicros: string
    billableActivityDateRange: { startDate: string; endDate: string }
  }[]
  invoiceType: string
}

async function downloadPdf(accessToken: string, pdfUrl: string): Promise<Buffer | null> {
  try {
    const res = await fetch(pdfUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (!res.ok) return null
    return Buffer.from(await res.arrayBuffer())
  } catch {
    return null
  }
}

async function uploadToDrive(accessToken: string, pdfBuffer: Buffer, filename: string): Promise<string | null> {
  try {
    const metadata = JSON.stringify({ name: filename, parents: [DRIVE_FOLDER_ID] })
    const boundary = 'faktura_boundary'
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: application/pdf\r\n\r\n`),
      pdfBuffer,
      Buffer.from(`\r\n--${boundary}--`),
    ])
    const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body,
    })
    const data = await res.json()
    return data.id ?? null
  } catch {
    return null
  }
}

async function parsePdfWithClaude(pdfBase64: string, invoiceId: string): Promise<Record<string, unknown>> {
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
            text: `Extrahuj z této faktury JSON (bez markdown):
{
  "cislo_faktury": "číslo faktury",
  "variabilni_symbol": "VS nebo číslo platebního profilu",
  "castka_s_dph": číslo,
  "castka_bez_dph": číslo,
  "dph": procento DPH (0 pokud reverse charge),
  "mena": "CZK/EUR",
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
    const cleaned = text.replace(/```json\n?|\n?```/g, '').trim()
    return JSON.parse(cleaned)
  } catch {
    const match = text.match(/\{[\s\S]*\}/)
    return match ? JSON.parse(match[0]) : {}
  }
}

function microsToAmount(micros: string | number): number {
  return Math.abs(Number(micros)) / 1_000_000
}

export async function POST() {
  if (!DEVELOPER_TOKEN) {
    return NextResponse.json({
      error: 'Chybí GOOGLE_ADS_DEVELOPER_TOKEN. Nastav v Vercel env vars.',
      help: 'Google Ads → Nástroje → API Center → Developer token',
    }, { status: 500 })
  }

  // Load Google token
  const tokensRes = await fetch(`${SUPABASE_URL}/rest/v1/google_tokens?select=*`, { headers: SB })
  const tokens: { email: string; refresh_token: string }[] = await tokensRes.json()
  if (!tokens.length) {
    return NextResponse.json({
      error: 'Žádný Google účet. Re-auth přes /api/google/auth',
    }, { status: 401 })
  }

  const accessToken = await getAccessToken(tokens[0].refresh_token)

  // Generate months from 2025-01 to current month
  const now = new Date()
  const periods: { year: number; month: string; monthNum: number }[] = []
  for (let y = 2025; y <= now.getFullYear(); y++) {
    const maxM = y < now.getFullYear() ? 12 : now.getMonth() + 1
    for (let m = 1; m <= maxM; m++) {
      periods.push({ year: y, month: MONTHS[m - 1], monthNum: m })
    }
  }

  const imported: string[] = []
  const skipped: string[] = []
  const errors: string[] = []

  for (const period of periods) {
    try {
      const invoices = await listInvoices(accessToken, period.year, period.month)

      for (const inv of invoices) {
        const invoiceId = inv.id
        const issueDate = inv.issueDate // YYYY-MM-DD

        // Deduplikace přes cislo_faktury
        const existRes = await fetch(
          `${SUPABASE_URL}/rest/v1/faktury?cislo_faktury=eq.${encodeURIComponent(invoiceId)}&select=id,gdrive_file_id&limit=1`,
          { headers: SB }
        )
        const existing: { id: number; gdrive_file_id: string | null }[] = await existRes.json()
        if (existing.length > 0) {
          // Pokud chybí gdrive_file_id, doplníme ho
          if (!existing[0].gdrive_file_id) {
            const pdfBuffer2 = await downloadPdf(accessToken, inv.pdf?.pdfUrl ?? '')
            if (pdfBuffer2) {
              const datePart2 = issueDate.replace(/-/g, '')
              const driveFilename2 = `${datePart2}_Google Ads faktura_${invoiceId}.pdf`
              const gdriveId2 = await uploadToDrive(accessToken, pdfBuffer2, driveFilename2)
              if (gdriveId2) {
                await fetch(`${SUPABASE_URL}/rest/v1/faktury?id=eq.${existing[0].id}`, {
                  method: 'PATCH', headers: SB_W,
                  body: JSON.stringify({ gdrive_file_id: gdriveId2 }),
                })
                skipped.push(`${invoiceId} (aktualizován gdrive_file_id)`)
                continue
              }
            }
          }
          skipped.push(`${invoiceId} (${issueDate})`)
          continue
        }

        // Download PDF
        const pdfUrl = inv.pdf?.pdfUrl
        if (!pdfUrl) {
          errors.push(`${invoiceId}: chybí pdf_url`)
          continue
        }

        const pdfBuffer = await downloadPdf(accessToken, pdfUrl)
        if (!pdfBuffer) {
          errors.push(`${invoiceId}: stažení PDF selhalo`)
          continue
        }

        const pdfBase64 = pdfBuffer.toString('base64')

        // Upload to Drive: YYYYMMDD_Google Ads faktura_invoiceId.pdf
        const datePart = issueDate.replace(/-/g, '')
        const driveFilename = `${datePart}_Google Ads faktura_${invoiceId}.pdf`
        const gdriveFileId = await uploadToDrive(accessToken, pdfBuffer, driveFilename)

        // Parse with Claude (fallback to API data)
        let parsed: Record<string, unknown> = {}
        try {
          parsed = await parsePdfWithClaude(pdfBase64, invoiceId)
        } catch { /* use API data */ }

        const totalMicros = inv.totalAmountMicros ?? '0'
        const taxMicros = inv.taxAmountMicros ?? '0'
        const subtotalMicros = inv.subtotalAmountMicros ?? '0'
        const mena = inv.currencyCode ?? 'CZK'

        const faktura = {
          cislo_faktury: invoiceId,
          dodavatel: String(parsed.dodavatel ?? 'Google Ireland Limited'),
          popis: String(parsed.popis ?? 'Google Ads'),
          castka_s_dph: parsed.castka_s_dph ? Number(parsed.castka_s_dph) : microsToAmount(totalMicros),
          castka_bez_dph: parsed.castka_bez_dph ? Number(parsed.castka_bez_dph) : microsToAmount(subtotalMicros),
          dph: parsed.dph !== undefined ? Number(parsed.dph) : microsToAmount(taxMicros),
          mena: String(parsed.mena ?? mena),
          datum_vystaveni: String(parsed.datum_vystaveni ?? issueDate),
          datum_splatnosti: inv.dueDate ?? (parsed.datum_splatnosti ? String(parsed.datum_splatnosti) : null),
          variabilni_symbol: String(parsed.variabilni_symbol ?? invoiceId),
          stav: 'nova',
          ...(gdriveFileId ? { gdrive_file_id: gdriveFileId } : {}),
        }

        await fetch(`${SUPABASE_URL}/rest/v1/faktury`, {
          method: 'POST',
          headers: SB_W,
          body: JSON.stringify(faktura),
        })

        imported.push(`${invoiceId} (${issueDate}, ${faktura.castka_s_dph} ${faktura.mena})`)
      }
    } catch (e) {
      errors.push(`${period.year}-${period.monthNum.toString().padStart(2, '0')}: ${String(e).substring(0, 150)}`)
    }
  }

  return NextResponse.json({
    ok: true,
    imported: imported.length,
    skipped: skipped.length,
    imported_invoices: imported,
    skipped_invoices: skipped,
    errors,
  })
}
