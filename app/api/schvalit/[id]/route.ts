import { Pool } from 'pg'
import { NextResponse } from 'next/server'

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
})

export async function POST(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const client = await pool.connect()
  try {
    await client.query(
      `UPDATE faktury SET stav = 'schvalena', zauctovano_at = NOW() WHERE id = $1`,
      [id]
    )
    return NextResponse.json({ ok: true })
  } finally {
    client.release()
  }
}
