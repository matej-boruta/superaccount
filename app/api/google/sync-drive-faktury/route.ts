/**
 * POST /api/google/sync-drive-faktury
 *
 * Stáhne PDF faktury z Google Drive složky (DRIVE_FOLDER_ID),
 * parsuje přes Claude a uloží do Supabase.
 * Každý soubor se zpracuje jen jednou (gdrive_file_id deduplikace).
 */
import { NextResponse } from 'next/server'

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID!
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET!
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY!
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY!
const DRIVE_FOLDER_ID = '19uD7bGxQTbDLn57L4tpBtH-9bG4lYXl8'

const SB = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
  Prefer: 'return=minimal',
}

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

async function listDriveFiles(accessToken: string): Promise<{ id: string; name: string; createdTime: string }[]> {
  const query = encodeURIComponent(`'${DRIVE_FOLDER_ID}' in parents and mimeType='application/pdf' and trashed=false`)
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id,name,createdTime)&orderBy=createdTime desc&pageSize=50`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  )
  const data = await res.json()
  return data.files ?? []
}

async function downloadDriveFile(accessToken: string, fileId: string): Promise<Buffer> {
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  )
  const arrayBuffer = await res.arrayBuffer()
  return Buffer.from(arrayBuffer)
}

async function parseWithClaude(pdfBase64: string): Promise<Record<string, unknown>> {
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
  "dph": číslo (výše DPH v Kč, ne procento),
  "mena": "CZK/EUR/USD",
  "datum_vystaveni": "YYYY-MM-DD",
  "datum_splatnosti": "YYYY-MM-DD nebo null",
  "dodavatel": "název firmy dodavatele",
  "ico": "IČO dodavatele nebo null",
  "popis": "krátký popis plnění"
}`,
          },
        ],
      }],
    }),
  })
  const data = await res.json()
  const text = data.content?.[0]?.text ?? '{}'
  try {
    return JSON.parse(text)
  } catch {
    const match = text.match(/\{[\s\S]*\}/)
    return match ? JSON.parse(match[0]) : {}
  }
}

export async function POST() {
  const tokensRes = await fetch(`${SUPABASE_URL}/rest/v1/google_tokens?select=*`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  })
  const tokens: { refresh_token: string; email: string }[] = await tokensRes.json()

  if (!tokens.length) {
    return NextResponse.json({
      error: 'Žádný Google účet není připojen',
      auth_url: 'https://approval-ui-alpha.vercel.app/api/google/auth',
    }, { status: 401 })
  }

  const accessToken = await getAccessToken(tokens[0].refresh_token)
  const files = await listDriveFiles(accessToken)

  const imported: string[] = []
  const skipped: string[] = []
  const errors: string[] = []

  for (const file of files) {
    try {
      // Deduplikace — přeskoč pokud už v DB je
      const existRes = await fetch(
        `${SUPABASE_URL}/rest/v1/faktury?gdrive_file_id=eq.${file.id}&select=id&limit=1`,
        { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
      )
      const existing = await existRes.json()
      if (Array.isArray(existing) && existing.length > 0) {
        skipped.push(file.name)
        continue
      }

      const pdfBuffer = await downloadDriveFile(accessToken, file.id)
      const pdfBase64 = pdfBuffer.toString('base64')
      const parsed = await parseWithClaude(pdfBase64)

      const faktura = {
        cislo_faktury: String(parsed.cislo_faktury ?? file.name.replace('.pdf', '')),
        dodavatel: String(parsed.dodavatel ?? ''),
        ico: parsed.ico ? String(parsed.ico) : null,
        popis: String(parsed.popis ?? ''),
        castka_s_dph: Number(parsed.castka_s_dph ?? 0),
        castka_bez_dph: Number(parsed.castka_bez_dph ?? 0),
        dph: Number(parsed.dph ?? 0),
        mena: String(parsed.mena ?? 'CZK'),
        datum_vystaveni: parsed.datum_vystaveni ? String(parsed.datum_vystaveni) : file.createdTime.split('T')[0],
        datum_splatnosti: parsed.datum_splatnosti ? String(parsed.datum_splatnosti) : null,
        variabilni_symbol: String(parsed.variabilni_symbol ?? ''),
        stav: 'nova',
        gdrive_file_id: file.id,
      }

      await fetch(`${SUPABASE_URL}/rest/v1/faktury`, {
        method: 'POST',
        headers: SB,
        body: JSON.stringify(faktura),
      })

      imported.push(file.name)
    } catch (e) {
      errors.push(`${file.name}: ${String(e).substring(0, 100)}`)
    }
  }

  return NextResponse.json({ ok: true, imported: imported.length, skipped: skipped.length, imported_files: imported, errors })
}
