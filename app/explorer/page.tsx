'use client'

import { useEffect, useState } from 'react'

type Faktura = {
  id: number
  dodavatel: string
  ico: string
  datum_vystaveni: string
  datum_splatnosti: string
  cislo_faktury: string
  castka_bez_dph: number
  dph: number
  castka_s_dph: number
  mena: string
  popis: string
  variabilni_symbol: string
  stav: string
  kategorie_id: number | null
  stav_workflow?: string | null
  blocker?: string | null
}

type AgentLog = {
  id: number
  created_at: string
  typ: string
  rezim: string | null
  confidence: number | null
  zmena_stavu: string | null
  faktura_id: number
}

type Transakce = {
  id: number
  datum: string
  castka: number
  mena: string
  zprava: string
  variabilni_symbol: string
  typ: string
  stav: string
  faktura_id: number | null
  protiucet: string | null
}

function fmt(n: number, mena?: string) {
  const currency = mena && /^[A-Z]{3}$/.test(mena.trim()) ? mena.trim() : 'CZK'
  return new Intl.NumberFormat('cs-CZ', { style: 'currency', currency, maximumFractionDigits: 0 }).format(n)
}

function fmtDate(d: string | null | undefined) {
  if (!d) return '—'
  const s = d.split('T')[0]
  const parts = s.split('-')
  if (parts.length !== 3) return s
  return `${parts[2]}. ${parts[1]}. ${parts[0]}`
}

function fmtDateTime(d: string | null | undefined) {
  if (!d) return '—'
  const [date, time] = d.split('T')
  return `${fmtDate(date)}  ${(time || '').slice(0, 5)}`
}

function StavBadge({ stav }: { stav: string }) {
  const map: Record<string, string> = {
    nova: 'bg-blue-50 text-blue-600',
    schvalena: 'bg-green-50 text-green-600',
    zaplacena: 'bg-emerald-50 text-emerald-700',
    zamitnuta: 'bg-red-50 text-red-600',
  }
  const cls = map[stav] ?? 'bg-gray-100 text-gray-500'
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium ${cls}`}>
      {stav}
    </span>
  )
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <div className="text-[10px] font-medium text-gray-400 uppercase tracking-wide">{label}</div>
      <div className="text-[12px] text-gray-800">{value || '—'}</div>
    </div>
  )
}

export default function ExplorerPage() {
  const year = new Date().getFullYear()
  const [faktury, setFaktury] = useState<Faktura[]>([])
  const [selected, setSelected] = useState<Faktura | null>(null)
  const [agentLog, setAgentLog] = useState<AgentLog[]>([])
  const [transakce, setTransakce] = useState<Transakce[]>([])
  const [loading, setLoading] = useState(true)
  const [logLoading, setLogLoading] = useState(false)
  const [search, setSearch] = useState('')

  useEffect(() => {
    fetch(`/api/faktury?rok=${year}`)
      .then(r => r.json())
      .then(d => { if (Array.isArray(d)) setFaktury(d) })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [year])

  useEffect(() => {
    if (!selected) return
    setLogLoading(true)
    setAgentLog([])
    setTransakce([])

    Promise.all([
      fetch(`/api/explorer/agent-log?faktura_id=${selected.id}`)
        .then(r => r.json())
        .catch(() => []),
      fetch(`/api/transakce?faktura_id=${selected.id}`)
        .then(r => r.json())
        .catch(() => []),
    ]).then(([log, trx]) => {
      setAgentLog(Array.isArray(log) ? log : [])
      setTransakce(Array.isArray(trx) ? trx : [])
    }).finally(() => setLogLoading(false))
  }, [selected])

  const filtered = faktury.filter(f => {
    if (!search) return true
    const q = search.toLowerCase()
    return (
      (f.dodavatel || '').toLowerCase().includes(q) ||
      (f.variabilni_symbol || '').includes(q) ||
      (f.stav || '').toLowerCase().includes(q)
    )
  })

  return (
    <div className="flex h-screen overflow-hidden bg-gray-50">

      {/* Levý panel — seznam faktur */}
      <div className="w-72 shrink-0 border-r border-gray-100 bg-white flex flex-col overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-50">
          <div className="text-[13px] font-semibold text-gray-900">Explorer</div>
          <div className="text-[11px] text-gray-400 mt-0.5">CASE detail · audit trail</div>
        </div>

        <div className="px-3 py-2 border-b border-gray-50">
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Hledat dodavatele…"
            className="w-full rounded-xl border border-gray-100 bg-gray-50 px-3 py-1.5 text-[12px] text-gray-800 placeholder:text-gray-400 outline-none focus:border-blue-300 focus:bg-white transition-colors"
          />
        </div>

        <div className="flex-1 overflow-auto">
          {loading && (
            <div className="text-center py-8 text-[12px] text-gray-400 animate-pulse">Načítám…</div>
          )}
          {!loading && filtered.length === 0 && (
            <div className="text-center py-8 text-[12px] text-gray-400">Žádné faktury</div>
          )}
          {filtered.map(f => (
            <button
              key={f.id}
              onClick={() => setSelected(f)}
              className={`w-full text-left px-4 py-3 border-b border-gray-50 transition-colors hover:bg-gray-50 ${
                selected?.id === f.id ? 'bg-blue-50 border-l-2 border-l-blue-500' : ''
              }`}
            >
              <div className="flex items-center justify-between gap-2 mb-1">
                <div className="text-[12px] font-medium text-gray-900 truncate flex-1">{f.dodavatel || '(neznámý)'}</div>
                <StavBadge stav={f.stav} />
              </div>
              <div className="flex items-center justify-between gap-2">
                <div className="text-[11px] text-gray-400">{fmtDate(f.datum_vystaveni)}</div>
                <div className="text-[11px] font-medium text-gray-600 tabular-nums">{fmt(f.castka_s_dph, f.mena)}</div>
              </div>
              {f.stav_workflow && (
                <div className="text-[10px] text-gray-400 mt-0.5 truncate">{f.stav_workflow}</div>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Pravý panel — detail */}
      <div className="flex-1 overflow-auto p-6">
        {!selected && (
          <div className="flex items-center justify-center h-full text-[13px] text-gray-400">
            Vyberte fakturu ze seznamu
          </div>
        )}

        {selected && (
          <div className="max-w-3xl space-y-5">

            {/* Faktura info */}
            <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
              <div className="px-5 py-4 border-b border-gray-50 flex items-center justify-between">
                <div>
                  <div className="text-[14px] font-semibold text-gray-900">{selected.dodavatel || '(neznámý)'}</div>
                  <div className="text-[11px] text-gray-400 mt-0.5">ID {selected.id} · IČO {selected.ico || '—'}</div>
                </div>
                <div className="text-right">
                  <div className="text-[18px] font-semibold text-gray-900 tabular-nums">{fmt(selected.castka_s_dph, selected.mena)}</div>
                  <div className="mt-1 flex gap-1.5 justify-end">
                    <StavBadge stav={selected.stav} />
                    {selected.stav_workflow && (
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-purple-50 text-purple-600">
                        {selected.stav_workflow}
                      </span>
                    )}
                  </div>
                </div>
              </div>

              <div className="px-5 py-4 grid grid-cols-2 gap-x-8 gap-y-3.5 sm:grid-cols-3">
                <Field label="Datum vystavení" value={fmtDate(selected.datum_vystaveni)} />
                <Field label="Datum splatnosti" value={fmtDate(selected.datum_splatnosti)} />
                <Field label="Variabilní symbol" value={selected.variabilni_symbol} />
                <Field label="Číslo faktury" value={selected.cislo_faktury} />
                <Field label="Částka bez DPH" value={fmt(selected.castka_bez_dph, selected.mena)} />
                <Field label="DPH" value={fmt(selected.dph, selected.mena)} />
                <Field label="Měna" value={selected.mena} />
                <Field label="Kategorie ID" value={selected.kategorie_id?.toString()} />
                <Field label="Popis" value={selected.popis} />
                {selected.blocker && (
                  <div className="col-span-2 sm:col-span-3">
                    <Field
                      label="Blocker"
                      value={
                        <span className="text-red-600 font-medium">{selected.blocker}</span>
                      }
                    />
                  </div>
                )}
              </div>
            </div>

            {/* Agent log — timeline */}
            <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
              <div className="px-5 py-4 border-b border-gray-50">
                <div className="text-[13px] font-semibold text-gray-900">Agent log</div>
                <div className="text-[11px] text-gray-400 mt-0.5">Posledních 20 záznamů</div>
              </div>

              {logLoading && (
                <div className="px-5 py-6 text-center text-[12px] text-gray-400 animate-pulse">Načítám…</div>
              )}

              {!logLoading && agentLog.length === 0 && (
                <div className="px-5 py-6 text-center text-[12px] text-gray-400">Žádné záznamy</div>
              )}

              {!logLoading && agentLog.length > 0 && (
                <div className="divide-y divide-gray-50">
                  {agentLog.map((entry, i) => (
                    <div key={entry.id ?? i} className="px-5 py-3 flex gap-4">
                      <div className="flex flex-col items-center">
                        <div className="w-2 h-2 rounded-full bg-blue-400 mt-1 shrink-0" />
                        {i < agentLog.length - 1 && <div className="w-px flex-1 bg-gray-100 mt-1" />}
                      </div>
                      <div className="flex-1 min-w-0 pb-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-[12px] font-medium text-gray-800">{entry.typ || '—'}</span>
                          {entry.rezim && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 font-medium">{entry.rezim}</span>
                          )}
                          {entry.confidence != null && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-50 text-blue-500 font-medium">
                              {Math.round(entry.confidence * 100)}%
                            </span>
                          )}
                        </div>
                        {entry.zmena_stavu && (
                          <div className="text-[11px] text-gray-500 mt-0.5">{entry.zmena_stavu}</div>
                        )}
                        <div className="text-[10px] text-gray-400 mt-0.5">{fmtDateTime(entry.created_at)}</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Transakce */}
            {transakce.length > 0 && (
              <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
                <div className="px-5 py-4 border-b border-gray-50">
                  <div className="text-[13px] font-semibold text-gray-900">Spárované transakce</div>
                  <div className="text-[11px] text-gray-400 mt-0.5">{transakce.length} záznamů</div>
                </div>
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-gray-50">
                      <th className="text-left px-5 py-2 text-[11px] font-medium text-gray-400 uppercase tracking-wide">Datum</th>
                      <th className="text-left px-5 py-2 text-[11px] font-medium text-gray-400 uppercase tracking-wide">Typ</th>
                      <th className="text-left px-5 py-2 text-[11px] font-medium text-gray-400 uppercase tracking-wide">Stav</th>
                      <th className="text-right px-5 py-2 text-[11px] font-medium text-gray-400 uppercase tracking-wide">Částka</th>
                    </tr>
                  </thead>
                  <tbody>
                    {transakce.map(t => (
                      <tr key={t.id} className="border-b border-gray-50 last:border-0 hover:bg-gray-50/50 transition-colors">
                        <td className="px-5 py-2.5 text-[12px] text-gray-600">{fmtDate(t.datum)}</td>
                        <td className="px-5 py-2.5 text-[12px] text-gray-600">{t.typ}</td>
                        <td className="px-5 py-2.5 text-[12px] text-gray-500">{t.stav}</td>
                        <td className="px-5 py-2.5 text-[12px] text-gray-900 tabular-nums text-right font-medium">{fmt(t.castka, t.mena)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

          </div>
        )}
      </div>
    </div>
  )
}
