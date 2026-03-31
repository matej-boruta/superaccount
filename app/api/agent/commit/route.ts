/**
 * POST /api/agent/commit
 *
 * Exportuje aktuální stav agentovy paměti do memory/ složky a commitne do gitu.
 * Volá se automaticky po každém učení nebo změně manuálu/ústavy.
 *
 * Body (volitelné):
 * {
 *   message?: string   — commit message (agent ji vygeneruje pokud chybí)
 *   push?: boolean     — pushne na GitHub (vyžaduje GITHUB_TOKEN + GITHUB_REPO)
 *   scope?: string[]   — co exportovat: ["ustava","manual","pravidla","api"] (default: vše)
 * }
 */
import { NextResponse } from 'next/server'
import { exec } from 'child_process'
import { promisify } from 'util'
import { writeFile, mkdir } from 'fs/promises'
import path from 'path'

const execAsync = promisify(exec)

const SB_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SB_KEY = process.env.SUPABASE_SERVICE_KEY!
const GITHUB_TOKEN = process.env.GITHUB_TOKEN
const GITHUB_REPO = process.env.GITHUB_REPO
const SB = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` }

const REPO_ROOT = process.cwd()
const MEMORY_DIR = path.join(REPO_ROOT, 'memory')

async function sbGet(endpoint: string) {
  const res = await fetch(`${SB_URL}/rest/v1/${endpoint}`, { headers: SB })
  return res.json()
}

async function exportUstava(): Promise<string | null> {
  const rows = await sbGet('agent_ustava?aktivni=eq.true&select=verze,platnost_od,text&limit=1')
  if (!rows[0]) return null
  const v = rows[0]
  const content = `# Ústava agenta SuperAccount ${v.verze}\n*Platnost od: ${v.platnost_od}*\n\n${v.text}`
  await writeFile(path.join(MEMORY_DIR, `ustava_${v.verze}.md`), content, 'utf8')
  return `memory/ustava_${v.verze}.md`
}

async function exportManual(): Promise<string[]> {
  const sekce = await sbGet('agent_manual?select=*&order=poradi.asc')
  const dir = path.join(MEMORY_DIR, 'manual')
  await mkdir(dir, { recursive: true })
  const files: string[] = []
  for (const s of sekce) {
    const filepath = path.join(dir, `${s.sekce}.md`)
    await writeFile(filepath, `${s.obsah}\n\n---\n*Verze ${s.verze} | ${s.updated_at.slice(0, 10)} | ${s.updated_by}*\n`, 'utf8')
    files.push(`memory/manual/${s.sekce}.md`)
  }
  return files
}

async function exportPravidla(): Promise<string[]> {
  const pravidla = await sbGet('ucetni_pravidla?aktivni=eq.true&order=typ.asc,confidence.desc')
  const dir = path.join(MEMORY_DIR, 'pravidla')
  await mkdir(dir, { recursive: true })

  const byTyp: Record<string, typeof pravidla> = {}
  for (const p of pravidla) {
    if (!byTyp[p.typ]) byTyp[p.typ] = []
    byTyp[p.typ].push(p)
  }

  const today = new Date().toISOString().slice(0, 10)
  let md = `# Účetní pravidla — aktuální stav\n*Export: ${today} | Počet: ${pravidla.length}*\n\n`
  for (const [typ, rows] of Object.entries(byTyp)) {
    md += `## ${typ}\n\n| Dodavatel / IČO | MD | DAL | DPH | Kat | Auto | Conf | Zdroj |\n|---|---|---|---|---|---|---|---|\n`
    for (const r of rows as Record<string, unknown>[]) {
      const d = (r.dodavatel_pattern as string) || `IČO:${r.ico || '—'}`
      md += `| ${d} | ${r.md_ucet || '—'} | ${r.dal_ucet || '—'} | ${r.sazba_dph ?? '—'}% | ${r.kategorie_id || '—'} | ${r.auto_schvalit ? '✓' : '—'} | ${r.confidence} | ${r.zdroj} |\n`
    }
    md += '\n'
  }
  await writeFile(path.join(dir, 'ucetni_pravidla.md'), md, 'utf8')

  // agent_api
  const apis = await sbGet('agent_api?select=klic,nazev,typ,stav,poznamka&order=klic.asc')
  let apiMd = `# Registry API přístupů\n\n| Klíč | Název | Typ | Stav | Poznámka |\n|---|---|---|---|---|\n`
  for (const a of apis) {
    apiMd += `| ${a.klic} | ${a.nazev} | ${a.typ} | ${a.stav} | ${(a.poznamka || '').slice(0, 60)} |\n`
  }
  await writeFile(path.join(dir, 'agent_api.md'), apiMd, 'utf8')

  return ['memory/pravidla/ucetni_pravidla.md', 'memory/pravidla/agent_api.md']
}

export async function POST(req: Request) {
  let body: { message?: string; push?: boolean; scope?: string[] } = {}
  try { body = await req.json() } catch { /* no body */ }

  const scope = body.scope ?? ['ustava', 'manual', 'pravidla']
  const shouldPush = body.push ?? false
  const changedFiles: string[] = []

  try {
    await mkdir(MEMORY_DIR, { recursive: true })

    if (scope.includes('ustava')) {
      const f = await exportUstava()
      if (f) changedFiles.push(f)
    }
    if (scope.includes('manual')) {
      changedFiles.push(...await exportManual())
    }
    if (scope.includes('pravidla')) {
      changedFiles.push(...await exportPravidla())
    }

    if (changedFiles.length === 0) {
      return NextResponse.json({ ok: true, message: 'Nic ke commitu' })
    }

    // Git add
    await execAsync(`git add ${changedFiles.map(f => `"${f}"`).join(' ')}`, { cwd: REPO_ROOT })

    // Check if there are staged changes
    const { stdout: diffStat } = await execAsync('git diff --cached --stat', { cwd: REPO_ROOT })
    if (!diffStat.trim()) {
      return NextResponse.json({ ok: true, message: 'Žádné změny oproti poslednímu commitu' })
    }

    // Commit
    const message = body.message ?? `Agent memory: aktualizace ${scope.join(', ')} [${new Date().toISOString().slice(0, 10)}]`
    await execAsync(`git commit -m "${message.replace(/"/g, "'")}"`, { cwd: REPO_ROOT })

    // Push pokud nakonfigurováno
    let pushed = false
    if (shouldPush && GITHUB_TOKEN && GITHUB_REPO) {
      const repoWithAuth = GITHUB_REPO.replace('https://', `https://${GITHUB_TOKEN}@`)
      await execAsync(`git push "${repoWithAuth}" main`, { cwd: REPO_ROOT })
      pushed = true
    }

    return NextResponse.json({ ok: true, committed: changedFiles.length, message, pushed })
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 })
  }
}
