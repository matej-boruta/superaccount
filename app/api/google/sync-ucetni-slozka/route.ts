/**
 * POST /api/google/sync-ucetni-slozka
 *
 * Rekurzivně projde účetní složku Google Drive,
 * najde všechna PDF a ta, která ještě nejsou v DB,
 * parsuje přes Claude a uloží se stavem 'ke_schvaleni'.
 */
import { NextResponse } from 'next/server'
import { callClaude, SYSTEM_EXTRAKCE } from '@/lib/claude'

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID!
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET!
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY!
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY!

const UCETNI_FOLDER_ID = '1I4MznYWf7mtdYoV6atBk_CPqw3WQ0Ajw'

const SB = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
  Prefer: 'return=minimal',
}

async function getAccessToken(): Promise<string> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/google_tokens?select=refresh_token&limit=1`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  })
  const [{ refresh_token }] = await r.json()
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ refresh_token, client_id: CLIENT_ID, client_secret: CLIENT_SECRET, grant_type: 'refresh_token' }),
  })
  const data = await res.json()
  if (data.error) throw new Error(data.error_description ?? data.error)
  return data.access_token
}

async function listFolderRecursive(
  folderId: string,
  token: string,
  folderPath = ''
): Promise<Array<{ id: string; name: string; path: string }>> {
  const results: Array<{ id: string; name: string; path: string }> = []
  let pageToken: string | undefined

  do {
    const url = `https://www.googleapis.com/drive/v3/files?q='${folderId}'+in+parents+and+trashed=false&fields=nextPageToken,files(id,name,mimeType)&pageSize=100&supportsAllDrives=true&includeItemsFromAllDrives=true${pageToken ? `&pageToken=${pageToken}` : ''}`
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
    const data = await res.json()

    for (const file of data.files ?? []) {
      if (file.mimeType === 'application/vnd.google-apps.folder') {
        const subPath = folderPath ? `${folderPath} / ${file.name}` : file.name
        const sub = await listFolderRecursive(file.id, token, subPath)
        results.push(...sub)
      } else if (file.mimeType === 'application/pdf') {
        results.push({ id: file.id, name: file.name, path: folderPath })
      }
    }

    pageToken = data.nextPageToken
  } while (pageToken)

  return results
}

async function parseWithClaude(pdfBase64: string): Promise<Record<string, unknown>> {
  const raw = await callClaude(
    ANTHROPIC_KEY,
    [{
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
    { maxTokens: 500, system: SYSTEM_EXTRAKCE, betaHeader: 'pdfs-2024-09-25' }
  ) ?? '{}'
  try {
    return JSON.parse(raw)
  } catch {
    const match = raw.match(/\{[\s\S]*\}/)
    return match ? JSON.parse(match[0]) : {}
  }
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}))
  const batchSize = Number(body.batch ?? 10)

  try {
    const token = await getAccessToken()
    const allPdfs = await listFolderRecursive(UCETNI_FOLDER_ID, token)

    const imported: string[] = []
    const skipped: string[] = []
    const errors: string[] = []
    let processed = 0

    for (const file of allPdfs) {
      if (processed >= batchSize) break
      try {
        // Deduplikace
        const existRes = await fetch(
          `${SUPABASE_URL}/rest/v1/faktury?gdrive_file_id=eq.${file.id}&select=id&limit=1`,
          { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
        )
        const existing = await existRes.json()
        if (Array.isArray(existing) && existing.length > 0) {
          skipped.push(file.name)
          processed++
          continue
        }

        // Stáhni PDF
        const dlRes = await fetch(
          `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media&supportsAllDrives=true`,
          { headers: { Authorization: `Bearer ${token}` } }
        )
        const pdfBase64 = Buffer.from(await dlRes.arrayBuffer()).toString('base64')

        // Parsuj
        const parsed = await parseWithClaude(pdfBase64)

        const faktura = {
          cislo_faktury: String(parsed.cislo_faktury ?? file.name.replace('.pdf', '')),
          dodavatel: parsed.dodavatel ? String(parsed.dodavatel) : null,
          ico: parsed.ico ? String(parsed.ico) : null,
          popis: parsed.popis ? String(parsed.popis) : file.path,
          castka_s_dph: Number(parsed.castka_s_dph ?? 0),
          castka_bez_dph: Number(parsed.castka_bez_dph ?? 0),
          dph: Number(parsed.dph ?? 0),
          mena: String(parsed.mena ?? 'CZK'),
          datum_vystaveni: parsed.datum_vystaveni ? String(parsed.datum_vystaveni) : null,
          datum_splatnosti: parsed.datum_splatnosti ? String(parsed.datum_splatnosti) : null,
          variabilni_symbol: parsed.variabilni_symbol ? String(parsed.variabilni_symbol) : null,
          stav: 'ke_schvaleni',
          gdrive_file_id: file.id,
        }

        const saveRes = await fetch(`${SUPABASE_URL}/rest/v1/faktury`, {
          method: 'POST',
          headers: SB,
          body: JSON.stringify(faktura),
        })

        if (!saveRes.ok) {
          const err = await saveRes.text()
          errors.push(`${file.name}: ${err.substring(0, 100)}`)
        } else {
          imported.push(`${file.path} / ${file.name}`)
        }
        processed++
      } catch (e) {
        errors.push(`${file.name}: ${String(e).substring(0, 100)}`)
        processed++
      }
    }

    return NextResponse.json({
      ok: true,
      total: allPdfs.length,
      imported: imported.length,
      skipped: skipped.length,
      errors: errors.length,
      imported_files: imported,
      error_details: errors,
    })
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 })
  }
}
