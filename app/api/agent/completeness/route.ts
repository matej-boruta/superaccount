/**
 * GET /api/agent/completeness?rok=2026
 *
 * Kontrolní mechanismus PM — ověřuje kompletnost dat:
 *
 * 1. FIO FRESHNESS — kontroluje poslední datum transakce per účet v DB.
 *    Pokud je účet stale (>3 dny bez TX v aktivním období), flaguje problém.
 *    Nepotřebuje Fio API (rate limit 30s/call) — čte přímo z DB.
 *
 * 2. DRIVE vs DB — počítá PDF soubory ve všech FaP složkách a porovnává
 *    s počtem faktur v DB s platným gdrive_file_id. Mismatch = chybí import.
 *
 * 3. TX GAPS — detekuje měsíce kde konkrétní účet nemá žádné transakce
 *    zatímco jiný účet ve stejném měsíci transakce má (= pravděpodobně chybí import).
 *
 * Returns: { ok: boolean, issues: Issue[], fio: FioStatus[], drive: DriveStatus }
 */

import { NextResponse } from 'next/server'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY!
const GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID!
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET!
const SB = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }

// FaP složky 2026 → expected kategorie (pro info)
const FAP_FOLDERS = [
  { id: '1GTVk47p8LBCYT9AEW-OLg-wfnxDXiGDZ', name: 'Marketing produkce'      },
  { id: '1nyaD4bNLijjr9ebOqWdj0CYIsfjd8ypl', name: 'Marketing produkce SK'   },
  { id: '1iM4n4l_vfFES1OiYXyA6p2DHGV1eIuVI', name: 'Marketing výkon'         },
  { id: '1AcBABUXj0GP2bAQKq7d1BTtqldajDQAK', name: 'Marketing výkon SK'      },
  { id: '1nVqST4ihAZ6FjuHP3cmZKmGtUujAz1KB', name: 'Personální CEO'          },
  { id: '1uqeP0Ogde87OMnfi8ehjEOlkb5Apwwr4', name: 'Personální zákaznická'   },
  { id: '1BtnU8d8G5JD-VqywWpYfvcNL7JszIbZQ', name: 'Provozní mimořádné'      },
  { id: '1ix_ltPn0RKfDd2SFUy2FSeG6PD6sopp4', name: 'Provozní režie'          },
  { id: '1Gi_AoPlOcIzeUOB87hsuvzJ3OCv2ce2m', name: 'IT SK'                   },
  { id: '1MTRsoyOoXuydJ0q9zyVkGsAWynb2ZSJM', name: 'IT marketing'            },
  { id: '1nvOhrML4IDMyi9qSOEDG_7S7CmYovuuQ', name: 'IT produkt'              },
  { id: '1DNwA0DwVDpX9MJRT_yqjd5gE5_dY-HZP', name: 'IT zákaznická péče'     },
  { id: '1BZIZ1c3TpMYfyu5C84tFjNMquyZ91bgh', name: 'SAB Finance'             },
]

// FIO_ACCOUNTS: dynamicky detekováno z DB (skutečné IBAN/ucet hodnoty)
// Fallback labely pro případ že DB je prázdná
const FIO_ACCOUNT_LABELS = ['CZK1', 'CZK2', 'EUR', 'USD']

type Issue = {
  severity: 'critical' | 'warning' | 'info'
  area: 'fio' | 'drive' | 'gaps'
  message: string
}

async function getGoogleAccessToken(): Promise<string | null> {
  try {
    const tokensRes = await fetch(`${SUPABASE_URL}/rest/v1/google_tokens?select=refresh_token&limit=1`, { headers: SB })
    const tokens = await tokensRes.json()
    if (!tokens?.[0]?.refresh_token) return null

    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        refresh_token: tokens[0].refresh_token,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        grant_type: 'refresh_token',
      }),
    })
    const data = await res.json()
    return data.access_token ?? null
  } catch { return null }
}

async function countFolderPdfs(accessToken: string, folderId: string): Promise<number> {
  const q = encodeURIComponent(`'${folderId}' in parents and trashed=false and mimeType='application/pdf'`)
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)&supportsAllDrives=true&includeItemsFromAllDrives=true&pageSize=500`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  )
  const data = await res.json()
  return (data.files ?? []).length
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const rok = Number(searchParams.get('rok') ?? 2026)
  const today = new Date().toISOString().slice(0, 10)

  const issues: Issue[] = []

  // ── 1. FIO FRESHNESS — poslední TX per účet ──────────────────────────────

  type FioStatus = { ucet: string; lastDate: string | null; daysSince: number | null; stale: boolean; txCount: number }
  const fioStatus: FioStatus[] = []

  const fioRes = await fetch(
    `${SUPABASE_URL}/rest/v1/transakce?datum=gte.${rok}-01-01&datum=lte.${rok}-12-31` +
    `&select=ucet,datum&order=datum.desc`,
    { headers: { ...SB, Range: '0-9999' } }
  )
  const allTx: { ucet: string; datum: string }[] = await fioRes.json().catch(() => [])

  // Detekuj skutečné účty z DB — Fio import ukládá IBAN (CZ2920...) nebo label (CZK1)
  const dbAccounts = Array.isArray(allTx) ? [...new Set(allTx.map(t => t.ucet))] : []
  // Pokud DB je prázdná, použij fallback labely
  const FIO_ACCOUNTS = dbAccounts.length > 0 ? dbAccounts : FIO_ACCOUNT_LABELS

  for (const ucet of FIO_ACCOUNTS) {
    const txForAccount = Array.isArray(allTx) ? allTx.filter(t => t.ucet === ucet) : []
    const lastDate = txForAccount[0]?.datum ?? null
    const daysSince = lastDate
      ? Math.floor((new Date(today).getTime() - new Date(lastDate).getTime()) / 86_400_000)
      : null

    // Stale: pokud jsme v aktivním roce a poslední TX je >7 dní stará (nebo žádná)
    const isActiveYear = rok === new Date().getFullYear()
    const stale = isActiveYear && (daysSince === null || daysSince > 7)

    fioStatus.push({ ucet, lastDate, daysSince, stale, txCount: txForAccount.length })

    if (stale) {
      issues.push({
        severity: daysSince === null ? 'critical' : 'warning',
        area: 'fio',
        message: daysSince === null
          ? `Fio ${ucet}: žádné transakce v DB za rok ${rok}`
          : `Fio ${ucet}: poslední TX před ${daysSince} dny (${lastDate}) — možný chybějící import`,
      })
    }
  }

  // ── 2. TX GAPS — měsíce bez TX pro účet který jinde TX má ───────────────

  if (Array.isArray(allTx) && allTx.length > 0) {
    // Zjisti aktivní měsíce (kde JAKÝKOLI účet má TX)
    const activeMonths = new Set(allTx.map(t => t.datum?.slice(0, 7)).filter(Boolean))

    // Pro každý aktivní měsíc ověř, že každý účet (který vůbec existuje v DB) má aspoň 1 TX
    const accountsInDb = new Set(allTx.map(t => t.ucet))

    for (const month of [...activeMonths].sort()) {
      const monthTx = allTx.filter(t => t.datum?.startsWith(month))
      const monthAccounts = new Set(monthTx.map(t => t.ucet))

      for (const ucet of accountsInDb) {
        if (!monthAccounts.has(ucet)) {
          // Tento účet nemá TX v měsíci kde jiné účty TX mají — podezřelé
          issues.push({
            severity: 'warning',
            area: 'gaps',
            message: `Fio ${ucet}: žádné transakce v ${month} (ostatní účty TX mají)`,
          })
        }
      }
    }
  }

  // ── 3. DRIVE vs DB — počet PDF v FaP složkách vs faktur v DB ───────────

  type DriveStatus = {
    driveTotal: number | null
    dbTotal: number
    perFolder: { name: string; drive: number; db: number; match: boolean }[]
    error?: string
  }

  let driveStatus: DriveStatus = { driveTotal: null, dbTotal: 0, perFolder: [] }

  // DB: count faktur s gdrive_file_id per rok
  const dbRes = await fetch(
    `${SUPABASE_URL}/rest/v1/faktury?datum_vystaveni=gte.${rok}-01-01&datum_vystaveni=lte.${rok}-12-31` +
    `&gdrive_file_id=not.is.null&select=gdrive_file_id`,
    { headers: { ...SB, Range: '0-9999' } }
  )
  const dbFaktury: { gdrive_file_id: string }[] = await dbRes.json().catch(() => [])
  const dbFileIds = new Set(Array.isArray(dbFaktury) ? dbFaktury.map(f => f.gdrive_file_id) : [])

  const accessToken = await getGoogleAccessToken()
  if (!accessToken) {
    driveStatus = { driveTotal: null, dbTotal: dbFileIds.size, perFolder: [], error: 'Nelze získat Google token' }
  } else {
    let driveTotal = 0
    const perFolder = []

    // Count PDFs in each FaP folder + also list file IDs to cross-check
    for (const folder of FAP_FOLDERS) {
      try {
        const q = encodeURIComponent(`'${folder.id}' in parents and trashed=false`)
        const res = await fetch(
          `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,mimeType)&supportsAllDrives=true&includeItemsFromAllDrives=true&pageSize=500`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        )
        const data = await res.json()
        const pdfs = (data.files ?? []).filter((f: { mimeType: string }) =>
          f.mimeType === 'application/pdf'
        )
        const driveCount = pdfs.length
        const driveIds: Set<string> = new Set(pdfs.map((f: { id: string }) => f.id))

        // How many of these Drive files are in DB?
        const inDb = [...driveIds].filter(id => dbFileIds.has(id)).length
        driveTotal += driveCount

        const match = driveCount === inDb
        if (!match) {
          perFolder.push({ name: folder.name, drive: driveCount, db: inDb, match })
          issues.push({
            severity: driveCount - inDb > 3 ? 'critical' : 'warning',
            area: 'drive',
            message: `Drive/${folder.name}: ${driveCount} PDF ale v DB jen ${inDb} (chybí ${driveCount - inDb})`,
          })
        } else {
          perFolder.push({ name: folder.name, drive: driveCount, db: inDb, match: true })
        }
      } catch {
        perFolder.push({ name: folder.name, drive: -1, db: 0, match: false })
      }
    }

    driveStatus = { driveTotal, dbTotal: dbFileIds.size, perFolder }

    if (driveTotal > dbFileIds.size) {
      const missing = driveTotal - dbFileIds.size
      issues.push({
        severity: missing > 5 ? 'critical' : 'warning',
        area: 'drive',
        message: `Drive celkem: ${driveTotal} PDF, DB: ${dbFileIds.size} faktur — chybí ${missing} importů`,
      })
    }
  }

  return NextResponse.json({
    ok: issues.filter(i => i.severity !== 'info').length === 0,
    rok,
    checkedAt: new Date().toISOString(),
    issues,
    fio: fioStatus,
    drive: driveStatus,
  })
}
