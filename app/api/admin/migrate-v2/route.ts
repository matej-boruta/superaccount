/**
 * ONE-TIME migration: SuperAccount 2.0
 * Vytvoří pravidla + rozhodnuti, přelije data z ucetni_pravidla.
 * POST /api/admin/migrate-v2
 */
import { NextResponse } from 'next/server'
import { Client } from 'pg'

// Supabase Session Pooler
const DB = 'postgresql://postgres.ktjncpnotdrklwgerufq:MatejBoruta1234.@aws-0-eu-central-1.pooler.supabase.com:5432/postgres'

async function runSQL(sql: string, label: string) {
  const client = new Client({ connectionString: DB, ssl: { rejectUnauthorized: false } })
  await client.connect()
  try {
    await client.query(sql)
    return { step: label, ok: true }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    return { step: label, ok: false, error: msg }
  } finally {
    await client.end()
  }
}

const STEPS: [string, string][] = [
  ['create pravidla', `
    CREATE TABLE IF NOT EXISTS pravidla (
      id                SERIAL PRIMARY KEY,
      dodavatel_pattern TEXT,
      ico               TEXT,
      keyword           TEXT,
      typ               TEXT NOT NULL DEFAULT 'kategorie'
                        CHECK (typ IN ('kategorie','parovani','schvaleni')),
      typ_platby        TEXT,
      kategorie_id      INT REFERENCES kategorie(id),
      limit_kc          INT,
      confidence        INT NOT NULL DEFAULT 70 CHECK (confidence BETWEEN 0 AND 100),
      zdroj             TEXT NOT NULL DEFAULT 'manual',
      md_ucet           TEXT,
      dal_ucet          TEXT,
      sazba_dph         NUMERIC,
      poznamka          TEXT,
      aktivni           BOOL NOT NULL DEFAULT TRUE,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_pravidla_ico     ON pravidla(ico) WHERE ico IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_pravidla_pattern ON pravidla(dodavatel_pattern) WHERE dodavatel_pattern IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_pravidla_typ     ON pravidla(typ, aktivni);
  `],

  ['migrate ucetni_pravidla → pravidla', `
    INSERT INTO pravidla
      (dodavatel_pattern, ico, keyword, typ, typ_platby, kategorie_id, limit_kc,
       confidence, zdroj, md_ucet, dal_ucet, sazba_dph, poznamka, aktivni, created_at)
    SELECT
      dodavatel_pattern, ico,
      parovat_keyword,
      CASE WHEN parovat_keyword IS NOT NULL THEN 'parovani'
           WHEN auto_schvalit = true        THEN 'schvaleni'
           ELSE 'kategorie' END,
      typ_platby, kategorie_id, limit_auto_kc,
      COALESCE(confidence, 70),
      COALESCE(zdroj, 'manual'),
      md_ucet, dal_ucet, sazba_dph, poznamka,
      COALESCE(aktivni, true), COALESCE(created_at, NOW())
    FROM ucetni_pravidla
    WHERE aktivni = true
    ON CONFLICT DO NOTHING;
  `],

  ['create rozhodnuti', `
    CREATE TABLE IF NOT EXISTS rozhodnuti (
      id           SERIAL PRIMARY KEY,
      faktura_id   INT REFERENCES faktury(id),
      transakce_id INT REFERENCES transakce(id),
      typ          TEXT NOT NULL CHECK (typ IN (
                     'kategorizace','parovani','schvaleni',
                     'korekce','eskalace','audit_ok','needs_info')),
      agent        TEXT NOT NULL CHECK (agent IN (
                     'accountant','auditor','pm','architect','system','human')),
      pravidlo_id  INT REFERENCES pravidla(id),
      confidence   INT CHECK (confidence BETWEEN 0 AND 100),
      vstup        JSONB,
      vystup       JSONB,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_rozhodnuti_faktura ON rozhodnuti(faktura_id) WHERE faktura_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_rozhodnuti_created ON rozhodnuti(created_at DESC);
  `],

  ['migrate agent_log → rozhodnuti', `
    INSERT INTO rozhodnuti (faktura_id, transakce_id, typ, agent, confidence, vstup, vystup, created_at)
    SELECT
      faktura_id, transakce_id,
      CASE WHEN typ = 'korekce'    THEN 'korekce'
           WHEN typ = 'eskalace'   THEN 'eskalace'
           WHEN typ = 'audit_ok'   THEN 'audit_ok'
           ELSE 'kategorizace' END,
      CASE WHEN agent_id ILIKE '%audit%'    THEN 'auditor'
           WHEN agent_id ILIKE '%account%'  THEN 'accountant'
           WHEN agent_id ILIKE '%pm%'       THEN 'pm'
           WHEN agent_id ILIKE '%architect%'THEN 'architect'
           ELSE 'system' END,
      confidence, vstup, vystup, created_at
    FROM agent_log
    ON CONFLICT DO NOTHING;
  `],
]

export async function POST() {
  if (!DB) return NextResponse.json({ ok: false, error: 'DATABASE_URL not set' }, { status: 500 })

  const results = []
  for (const [label, sql] of STEPS) {
    const r = await runSQL(sql, label)
    results.push(r)
    if (!r.ok && label.startsWith('create')) {
      return NextResponse.json({ ok: false, results }, { status: 200 })
    }
  }

  // Počty po migraci
  const client = new Client({ connectionString: DB, ssl: { rejectUnauthorized: false } })
  await client.connect()
  const { rows } = await client.query(`
    SELECT 'pravidla' AS tbl, COUNT(*)::int AS cnt FROM pravidla
    UNION ALL
    SELECT 'rozhodnuti', COUNT(*)::int FROM rozhodnuti
  `)
  await client.end()

  return NextResponse.json({ ok: true, results, counts: Object.fromEntries(rows.map(r => [r.tbl, r.cnt])) })
}

export async function GET() {
  const PASS = 'MatejBoruta1234.'
  const IPV6 = '2a05:d018:135e:16d5:2c87:caec:34fc:ffbc'
  const results: Record<string, string> = {}

  const cfgs: [string, object][] = [
    ['ipv6-5432', { host: IPV6, port: 5432, user: 'postgres', password: PASS, database: 'postgres', ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 8000 }],
    ['ipv6-6543', { host: IPV6, port: 6543, user: 'postgres', password: PASS, database: 'postgres', ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 8000 }],
  ]

  for (const [label, cfg] of cfgs) {
    try {
      const c = new Client(cfg)
      await c.connect()
      const { rows } = await c.query('SELECT current_database()')
      await c.end()
      results[label] = `✅ OK — ${rows[0].current_database}`
    } catch (e: unknown) {
      results[label] = e instanceof Error ? e.message.slice(0, 100) : String(e)
    }
  }
  return NextResponse.json(results)
}
