/**
 * POST /api/google/copy-folders
 *
 * Zkopíruje obsah zdrojové složky do cílové složky Google Drive.
 * Přejmenuje složky: odstraní prefix "ORG.fakturace.ucet " ze začátku názvů.
 * Rekurzivně kopíruje i podsložky (zaúčtované atd.).
 */
import { NextResponse } from 'next/server'

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID!
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET!
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY!

const SB = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }

async function getAccessToken(): Promise<string> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/google_tokens?select=refresh_token&limit=1`, { headers: SB })
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

async function driveGet(url: string, token: string) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) throw new Error(`Drive GET ${url}: ${res.status} ${await res.text()}`)
  return res.json()
}

async function drivePost(url: string, body: unknown, token: string) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`Drive POST: ${res.status} ${await res.text()}`)
  return res.json()
}

async function listFolder(folderId: string, token: string): Promise<Array<{id: string; name: string; mimeType: string}>> {
  const items: Array<{id: string; name: string; mimeType: string}> = []
  let pageToken: string | undefined
  do {
    const url = `https://www.googleapis.com/drive/v3/files?q='${folderId}'+in+parents+and+trashed=false&fields=nextPageToken,files(id,name,mimeType)&pageSize=100${pageToken ? `&pageToken=${pageToken}` : ''}`
    const data = await driveGet(url, token)
    items.push(...(data.files ?? []))
    pageToken = data.nextPageToken
  } while (pageToken)
  return items
}

function renameFolderName(name: string): string {
  // Remove prefix "ORG.fakturace.ucet " (with trailing space)
  return name.replace(/^ORG\.fakturace\.ucet\s+/, '').trim()
}

async function copyFolderContents(
  sourceFolderId: string,
  targetFolderId: string,
  token: string,
  depth = 0,
  stats = { folders: 0, files: 0, errors: [] as string[] }
): Promise<typeof stats> {
  const items = await listFolder(sourceFolderId, token)

  for (const item of items) {
    const newName = renameFolderName(item.name)

    if (item.mimeType === 'application/vnd.google-apps.folder') {
      // Create subfolder in target
      try {
        const newFolder = await drivePost(
          'https://www.googleapis.com/drive/v3/files?fields=id,name',
          { name: newName, mimeType: 'application/vnd.google-apps.folder', parents: [targetFolderId] },
          token
        )
        stats.folders++
        // Recurse
        await copyFolderContents(item.id, newFolder.id, token, depth + 1, stats)
      } catch (e) {
        stats.errors.push(`Folder ${item.name}: ${String(e)}`)
      }
    } else {
      // Copy file
      try {
        await drivePost(
          `https://www.googleapis.com/drive/v3/files/${item.id}/copy?fields=id`,
          { name: newName, parents: [targetFolderId] },
          token
        )
        stats.files++
      } catch (e) {
        stats.errors.push(`File ${item.name}: ${String(e)}`)
      }
    }
  }

  return stats
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}))
  const sourceId = body.source || '1vCbrmWcLhDR54KVL0EHYaDLg2Qr2RCsM'
  const targetId = body.target || '1I4MznYWf7mtdYoV6atBk_CPqw3WQ0Ajw'

  try {
    const token = await getAccessToken()
    const stats = await copyFolderContents(sourceId, targetId, token)
    return NextResponse.json({ ok: true, ...stats })
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 })
  }
}
