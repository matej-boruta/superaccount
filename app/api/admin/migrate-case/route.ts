/**
 * ONE-TIME migration: přidá CASE workflow sloupce do faktury + agent_log.
 * Spusť jednou: POST /api/admin/migrate-case
 *
 * SQL ke spuštění v Supabase SQL editoru (pokud RPC exec_sql není dostupné):
 *
 * ALTER TABLE faktury
 *   ADD COLUMN IF NOT EXISTS stav_workflow text DEFAULT 'NEW',
 *   ADD COLUMN IF NOT EXISTS priorita integer DEFAULT 50,
 *   ADD COLUMN IF NOT EXISTS blocker text,
 *   ADD COLUMN IF NOT EXISTS case_owner text;
 *
 * ALTER TABLE agent_log
 *   ADD COLUMN IF NOT EXISTS rezim text,
 *   ADD COLUMN IF NOT EXISTS source_of_rule text,
 *   ADD COLUMN IF NOT EXISTS zmena_stavu text,
 *   ADD COLUMN IF NOT EXISTS case_id integer;
 *
 * CREATE INDEX IF NOT EXISTS idx_faktury_stav_workflow ON faktury(stav_workflow);
 * CREATE INDEX IF NOT EXISTS idx_faktury_priorita ON faktury(priorita DESC);
 */

import { NextResponse } from 'next/server'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY!

const SQL_FAKTURY = `
ALTER TABLE faktury
  ADD COLUMN IF NOT EXISTS stav_workflow text DEFAULT 'NEW',
  ADD COLUMN IF NOT EXISTS priorita integer DEFAULT 50,
  ADD COLUMN IF NOT EXISTS blocker text,
  ADD COLUMN IF NOT EXISTS case_owner text;
CREATE INDEX IF NOT EXISTS idx_faktury_stav_workflow ON faktury(stav_workflow);
CREATE INDEX IF NOT EXISTS idx_faktury_priorita ON faktury(priorita DESC);
`.trim()

const SQL_AGENT_LOG = `
ALTER TABLE agent_log
  ADD COLUMN IF NOT EXISTS rezim text,
  ADD COLUMN IF NOT EXISTS source_of_rule text,
  ADD COLUMN IF NOT EXISTS zmena_stavu text,
  ADD COLUMN IF NOT EXISTS case_id integer,
  ADD COLUMN IF NOT EXISTS feedback_type text;
`.trim()

async function runSQL(sql: string): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/exec_sql`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: sql }),
  })
  if (!res.ok) {
    const text = await res.text()
    return { ok: false, error: text }
  }
  return { ok: true }
}

export async function POST() {
  const results: { step: string; ok: boolean; error?: string }[] = []

  const r1 = await runSQL(SQL_FAKTURY)
  results.push({ step: 'faktury columns', ...r1 })

  const r2 = await runSQL(SQL_AGENT_LOG)
  results.push({ step: 'agent_log columns', ...r2 })

  // Backfill: nastavit stav_workflow podle stávajícího stavu faktury
  if (r1.ok) {
    const backfillMap: Record<string, string> = {
      nova: 'ACCOUNTING_PROPOSED',
      schvalena: 'APPROVED',
      zaplacena: 'POSTED',
      zamitnuta: 'REJECTED',
    }
    for (const [stav, workflow] of Object.entries(backfillMap)) {
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/faktury?stav=eq.${stav}&stav_workflow=eq.NEW`,
        {
          method: 'PATCH',
          headers: {
            apikey: SUPABASE_KEY,
            Authorization: `Bearer ${SUPABASE_KEY}`,
            'Content-Type': 'application/json',
            Prefer: 'return=minimal',
          },
          body: JSON.stringify({ stav_workflow: workflow }),
        }
      )
      results.push({ step: `backfill ${stav}→${workflow}`, ok: res.ok })
    }
  }

  const allOk = results.every(r => r.ok)
  return NextResponse.json({
    ok: allOk,
    results,
    note: allOk
      ? 'Migrace dokončena.'
      : 'exec_sql RPC pravděpodobně neexistuje. Spusť SQL manuálně v Supabase SQL editoru — viz komentář v tomto souboru.',
  })
}
