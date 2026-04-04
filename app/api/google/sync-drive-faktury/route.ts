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
const DEFAULT_DRIVE_FOLDER_ID = '1vCbrmWcLhDR54KVL0EHYaDLg2Qr2RCsM'

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

type DriveFile = { id: string; name: string; createdTime: string; folderName: string | null }

async function listFolderFiles(
  accessToken: string,
  folderId: string,
  folderName: string | null = null
): Promise<DriveFile[]> {
  const query = encodeURIComponent(`'${folderId}' in parents and trashed=false`)
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id,name,mimeType,createdTime)&supportsAllDrives=true&includeItemsFromAllDrives=true&pageSize=200`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  )
  const data = await res.json()
  const items: { id: string; name: string; mimeType: string; createdTime: string }[] = data.files ?? []

  const pdfs = items
    .filter(f => f.mimeType === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'))
    .map(f => ({ id: f.id, name: f.name, createdTime: f.createdTime, folderName }))

  const subfolders = items.filter(f => f.mimeType === 'application/vnd.google-apps.folder')

  // Recurse — pass THIS subfolder's name down so PDFs inside know which category folder they're in
  const subFiles = await Promise.all(subfolders.map(sf => listFolderFiles(accessToken, sf.id, sf.name)))
  return [...pdfs, ...subFiles.flat()]
}

async function listDriveFiles(accessToken: string, folderId: string): Promise<DriveFile[]> {
  return listFolderFiles(accessToken, folderId)
}

/**
 * Přímá lookup tabulka: suffix za "FaP.XX " → kategorie_id.
 * Naučeno z reálné struktury Google Drive složek, confidence=100.
 * Pokrývá CZ i SK varianty; case-insensitive matching přes toLowerCase().
 */
const FOLDER_KATEGORIE_MAP: Record<string, number> = {
  'marketing produkce':        6,  // Marketing/Produkce
  'marketing produkce sk':     6,
  'marketing výkon':           5,  // Marketing/Výkon
  'marketing výkon sk':        5,
  'personální ceo':            3,  // Personální/CEO
  'personální zákaznická péče': 1, // Personální/CS
  'provozní mimořádné':        11, // Provozní/Mimořádné
  'provozní režie':            10, // Provozní/Režie
  'it sk':                     7,  // IT/CS
  'it marketing':              8,  // IT/MKT
  'it produkt':                9,  // IT/Produkt
  'it zákaznická péče':        7,  // IT/CS
  'sab finance':               12, // FX/Směna
}

/**
 * Extrahuje suffix za "FaP.XX " a vrátí kategorie_id z přímé tabulky.
 * Ignoruje parametr kategorie (DB lookup) — tabulka je autoritativní.
 */
function matchKategorieByFolderName(
  folderName: string,
  _kategorie: { id: number; l1: string; l2: string }[]
): number | null {
  // Extrakce suffixu za "FaP.číslo mezera", ořež " - zauctovane" a podobné přípony
  const match = folderName.match(/FaP\.\d+\s+(.+)$/i)
  const raw = match ? match[1].trim().toLowerCase() : folderName.toLowerCase()
  const suffix = raw.replace(/\s*-\s*(zauctovan[eé]|archiv|done|old|backup).*$/i, '').trim()
  return FOLDER_KATEGORIE_MAP[suffix] ?? null
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

export async function POST(req: Request) {
  let body: { folder_id?: string } = {}
  try { body = await req.json() } catch { /* no body */ }
  const folderId = body.folder_id ?? DEFAULT_DRIVE_FOLDER_ID

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
  const files = await listDriveFiles(accessToken, folderId)

  // Načti kategorie jednou pro celý sync — použijeme pro mapování názvů složek
  const katRes = await fetch(
    `${SUPABASE_URL}/rest/v1/kategorie?select=id,l1,l2&order=id.asc`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
  )
  const kategorieList: { id: number; l1: string; l2: string }[] = await katRes.json().catch(() => [])

  const imported: string[] = []
  const skipped: string[] = []
  const errors: string[] = []

  // Typy dokumentů od SAB Finance, které se nepárují jako faktury
  const SAB_SKIP_KEYWORDS = ['souhrnný doklad', 'výpis z klientského účtu', 'vypis z klientskeho uctu']

  for (const file of files) {
    try {
      // Přeskoč interní SAB Finance dokumenty (nejde o faktury k úhradě)
      const nameLower = file.name.toLowerCase()
      if (SAB_SKIP_KEYWORDS.some(kw => nameLower.includes(kw))) {
        skipped.push(file.name)
        continue
      }

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

      const cisloFaktury = String(parsed.cislo_faktury ?? file.name.replace('.pdf', ''))

      // Sekundární deduplikace podle cislo_faktury + dodavatel + datum_vystaveni
      // (různí dodavatelé mohou mít stejné číslo; jeden dodavatel může vystavit dvě faktury stejného čísla v jiném roce)
      const dodavatelParsed = String(parsed.dodavatel ?? '')
      const datumVystaveniParsed = parsed.datum_vystaveni ? String(parsed.datum_vystaveni) : file.createdTime.split('T')[0]
      const datumYear = datumVystaveniParsed.slice(0, 4)
      const existByCisloRes = await fetch(
        `${SUPABASE_URL}/rest/v1/faktury?cislo_faktury=eq.${encodeURIComponent(cisloFaktury)}` +
        `&dodavatel=eq.${encodeURIComponent(dodavatelParsed)}` +
        `&datum_vystaveni=gte.${datumYear}-01-01&datum_vystaveni=lte.${datumYear}-12-31` +
        `&select=id&limit=1`,
        { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
      )
      const existByCislo = await existByCisloRes.json()
      if (Array.isArray(existByCislo) && existByCislo.length > 0) {
        skipped.push(file.name)
        continue
      }

      // Auto-assign kategorie: 1) folder name, 2) pravidla (unified), 3) history
      let kategorieId: number | null = null
      let katSource = ''

      // 1. Název složky — přímá lookup tabulka (confidence=100)
      if (file.folderName) {
        const matched = matchKategorieByFolderName(file.folderName, kategorieList)
        if (matched) { kategorieId = matched; katSource = `folder:${file.folderName}` }
      }

      // 2. pravidla — jeden dotaz, seřazeno od nejdelšího patternu (nejspecifičtější)
      if (!kategorieId) {
        const pravidlaRes = await fetch(
          `${SUPABASE_URL}/rest/v1/pravidla?aktivni=eq.true&kategorie_id=not.is.null&dodavatel_pattern=not.is.null&select=dodavatel_pattern,ico,kategorie_id&order=dodavatel_pattern.desc&limit=200`,
          { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
        )
        const pravidla: { dodavatel_pattern: string; ico: string | null; kategorie_id: number }[] = await pravidlaRes.json().catch(() => [])
        const dodavatelUpper = dodavatelParsed.toUpperCase()
        const icoFile = parsed.ico ? String(parsed.ico) : null
        const matched = pravidla.find(p => {
          if (icoFile && p.ico && p.ico === icoFile) return true
          const pat = p.dodavatel_pattern.replace(/%/g, '').toUpperCase()
          return pat && dodavatelUpper.includes(pat)
        })
        if (matched) { kategorieId = matched.kategorie_id; katSource = 'pravidla' }
      }

      // 4. Fallback: inherit from last faktura of same dodavatel (ICO first, then name)
      if (!kategorieId) {
        const icoFile = parsed.ico ? String(parsed.ico) : null
        const histField = icoFile
          ? `ico=eq.${encodeURIComponent(icoFile)}`
          : `dodavatel=eq.${encodeURIComponent(dodavatelParsed)}`
        const prevRes = await fetch(
          `${SUPABASE_URL}/rest/v1/faktury?${histField}&kategorie_id=not.is.null&select=kategorie_id&order=id.desc&limit=1`,
          { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
        )
        const prev = await prevRes.json().catch(() => [])
        if (Array.isArray(prev) && prev.length > 0) { kategorieId = prev[0].kategorie_id; katSource = 'history' }
      }

      void katSource // logged implicitly via imported_files

      const faktura = {
        cislo_faktury: cisloFaktury,
        dodavatel: dodavatelParsed,
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
        ...(kategorieId ? { kategorie_id: kategorieId } : {}),
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
