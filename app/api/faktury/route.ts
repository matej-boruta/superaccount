import { Pool } from 'pg'
import { NextResponse } from 'next/server'

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
})

export async function GET() {
  const client = await pool.connect()
  try {
    const res = await client.query(`
      SELECT id, dodavatel, ico, datum_vystaveni, datum_splatnosti,
             cislo_faktury, castka_bez_dph, dph, castka_s_dph, mena,
             popis, variabilni_symbol, stav, prijato_at
      FROM faktury
      WHERE stav IN ('nova', 'schvalena', 'zamitnuta')
      ORDER BY
        CASE stav WHEN 'nova' THEN 0 WHEN 'schvalena' THEN 1 ELSE 2 END,
        datum_vystaveni DESC
    `)
    return NextResponse.json(res.rows)
  } finally {
    client.release()
  }
}
