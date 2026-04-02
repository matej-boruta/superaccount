'use client'

import { useEffect, useState } from 'react'

type Faktura = {
  id: number
  dodavatel: string
  castka_s_dph: number
  mena: string
  datum_vystaveni: string
  stav: string
  stav_workflow?: string | null
}

type Transakce = {
  id: number
  faktura_id: number | null
  stav: string
}

type SupplierRow = {
  dodavatel: string
  count: number
  total: number
}

type MonthRow = {
  label: string
  total: number
}

function fmt(n: number) {
  return new Intl.NumberFormat('cs-CZ', { style: 'currency', currency: 'CZK', maximumFractionDigits: 0 }).format(n)
}

function getMonth(datum: string): string {
  const parts = (datum || '').split('T')[0].split('-')
  if (parts.length < 2) return '?'
  return `${parts[0]}-${parts[1]}`
}

export default function CeoWorkspace() {
  const year = new Date().getFullYear()
  const [faktury, setFaktury] = useState<Faktura[]>([])
  const [nesparovano, setNesparovano] = useState<Transakce[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    Promise.all([
      fetch(`/api/faktury?rok=${year}`).then(r => r.json()).catch(() => []),
      fetch(`/api/transakce?stav=nesparovano&rok=${year}`).then(r => r.json()).catch(() => []),
    ]).then(([f, t]) => {
      setFaktury(Array.isArray(f) ? f : [])
      setNesparovano(Array.isArray(t) ? t : [])
    }).finally(() => setLoading(false))
  }, [year])

  // TOP 10 dodavatelů
  const supplierMap = new Map<string, { count: number; total: number }>()
  for (const f of faktury) {
    const key = f.dodavatel || '(neznámý)'
    const prev = supplierMap.get(key) ?? { count: 0, total: 0 }
    supplierMap.set(key, { count: prev.count + 1, total: prev.total + (f.castka_s_dph || 0) })
  }
  const top10: SupplierRow[] = [...supplierMap.entries()]
    .map(([dodavatel, v]) => ({ dodavatel, ...v }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 10)

  // Měsíční náklady
  const monthMap = new Map<string, number>()
  for (const f of faktury) {
    const m = getMonth(f.datum_vystaveni)
    monthMap.set(m, (monthMap.get(m) ?? 0) + (f.castka_s_dph || 0))
  }
  const months: MonthRow[] = [...monthMap.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([label, total]) => ({ label, total }))
  const maxMonth = Math.max(...months.map(m => m.total), 1)

  // Anomálie
  const validAmounts = faktury.map(f => f.castka_s_dph || 0).filter(v => v > 0)
  const avg = validAmounts.length ? validAmounts.reduce((a, b) => a + b, 0) / validAmounts.length : 0
  const threshold = avg * 2.5
  const anomalie = faktury.filter(f => (f.castka_s_dph || 0) > threshold)

  // Souhrn
  const celkemCastka = faktury.reduce((s, f) => s + (f.castka_s_dph || 0), 0)
  const nesparovanoCount = nesparovano.filter(t => !t.faktura_id).length + nesparovano.length

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="sticky top-0 z-10 bg-white border-b border-gray-100 px-6 py-3">
        <div className="text-[15px] font-semibold text-gray-900">CEO pohled</div>
        <div className="text-[11px] text-gray-400 mt-0.5">Přehled financí · {year}</div>
      </div>

      {loading && (
        <div className="text-center py-16 text-[13px] text-gray-400 animate-pulse">Načítám data…</div>
      )}

      {!loading && (
        <div className="p-6 max-w-5xl space-y-6">

          {/* Souhrn — 3 karty */}
          <div className="grid grid-cols-3 gap-4">
            <div className="bg-white rounded-2xl border border-gray-100 px-5 py-4">
              <div className="text-[11px] text-gray-400 uppercase tracking-wide mb-1">Celkem faktur</div>
              <div className="text-[26px] font-semibold text-gray-900 tabular-nums">{faktury.length}</div>
            </div>
            <div className="bg-white rounded-2xl border border-gray-100 px-5 py-4">
              <div className="text-[11px] text-gray-400 uppercase tracking-wide mb-1">Celková částka</div>
              <div className="text-[22px] font-semibold text-gray-900 tabular-nums">{fmt(celkemCastka)}</div>
            </div>
            <div className="bg-white rounded-2xl border border-gray-100 px-5 py-4">
              <div className="text-[11px] text-gray-400 uppercase tracking-wide mb-1">Nespárované transakce</div>
              <div className="text-[26px] font-semibold text-orange-500 tabular-nums">{nesparovanoCount}</div>
            </div>
          </div>

          {/* TOP 10 dodavatelů */}
          <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
            <div className="px-5 py-4 border-b border-gray-50">
              <div className="text-[13px] font-semibold text-gray-900">TOP 10 dodavatelů</div>
              <div className="text-[11px] text-gray-400 mt-0.5">Podle celkové částky s DPH</div>
            </div>
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-50">
                  <th className="text-left px-5 py-2.5 text-[11px] font-medium text-gray-400 uppercase tracking-wide">#</th>
                  <th className="text-left px-5 py-2.5 text-[11px] font-medium text-gray-400 uppercase tracking-wide">Dodavatel</th>
                  <th className="text-right px-5 py-2.5 text-[11px] font-medium text-gray-400 uppercase tracking-wide">Faktur</th>
                  <th className="text-right px-5 py-2.5 text-[11px] font-medium text-gray-400 uppercase tracking-wide">Celkem CZK</th>
                </tr>
              </thead>
              <tbody>
                {top10.map((row, i) => (
                  <tr key={row.dodavatel} className="border-b border-gray-50 last:border-0 hover:bg-gray-50/50 transition-colors">
                    <td className="px-5 py-2.5 text-[12px] text-gray-400 tabular-nums">{i + 1}</td>
                    <td className="px-5 py-2.5 text-[12px] text-gray-800 font-medium">{row.dodavatel}</td>
                    <td className="px-5 py-2.5 text-[12px] text-gray-500 tabular-nums text-right">{row.count}</td>
                    <td className="px-5 py-2.5 text-[12px] text-gray-900 tabular-nums text-right font-medium">{fmt(row.total)}</td>
                  </tr>
                ))}
                {top10.length === 0 && (
                  <tr><td colSpan={4} className="px-5 py-6 text-center text-[12px] text-gray-400">Žádná data</td></tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Měsíční náklady — sparkline */}
          <div className="bg-white rounded-2xl border border-gray-100 px-5 py-4">
            <div className="text-[13px] font-semibold text-gray-900 mb-1">Měsíční náklady</div>
            <div className="text-[11px] text-gray-400 mb-4">Podle data vystavení faktury</div>
            {months.length === 0 && (
              <div className="text-[12px] text-gray-400 text-center py-4">Žádná data</div>
            )}
            {months.length > 0 && (
              <div className="flex items-end gap-2 h-24">
                {months.map(m => {
                  const heightPct = Math.max(4, Math.round((m.total / maxMonth) * 100))
                  return (
                    <div key={m.label} className="flex flex-col items-center gap-1 flex-1 min-w-0" title={`${m.label}: ${fmt(m.total)}`}>
                      <div
                        className="w-full rounded-t-md bg-blue-500 transition-all"
                        style={{ height: `${heightPct}%` }}
                      />
                      <div className="text-[10px] text-gray-400 truncate w-full text-center">
                        {m.label.slice(5)}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          {/* Anomálie */}
          <div className="bg-white rounded-2xl border border-gray-100 overflow-hidden">
            <div className="px-5 py-4 border-b border-gray-50">
              <div className="text-[13px] font-semibold text-gray-900">
                Anomálie{' '}
                {anomalie.length > 0 && (
                  <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-red-50 text-red-600">
                    {anomalie.length}
                  </span>
                )}
              </div>
              <div className="text-[11px] text-gray-400 mt-0.5">
                Faktury nad {fmt(threshold)} (průměr × 2,5)
              </div>
            </div>
            {anomalie.length === 0 && (
              <div className="px-5 py-6 text-center text-[12px] text-gray-400">Žádné anomálie</div>
            )}
            {anomalie.length > 0 && (
              <table className="w-full">
                <thead>
                  <tr className="border-b border-gray-50">
                    <th className="text-left px-5 py-2.5 text-[11px] font-medium text-gray-400 uppercase tracking-wide">Dodavatel</th>
                    <th className="text-left px-5 py-2.5 text-[11px] font-medium text-gray-400 uppercase tracking-wide">Datum</th>
                    <th className="text-left px-5 py-2.5 text-[11px] font-medium text-gray-400 uppercase tracking-wide">Stav</th>
                    <th className="text-right px-5 py-2.5 text-[11px] font-medium text-gray-400 uppercase tracking-wide">Částka</th>
                  </tr>
                </thead>
                <tbody>
                  {anomalie.map(f => (
                    <tr key={f.id} className="border-b border-gray-50 last:border-0 bg-red-50/30 hover:bg-red-50/60 transition-colors">
                      <td className="px-5 py-2.5 text-[12px] text-gray-800 font-medium">{f.dodavatel}</td>
                      <td className="px-5 py-2.5 text-[12px] text-gray-500">{(f.datum_vystaveni || '').split('T')[0]}</td>
                      <td className="px-5 py-2.5 text-[12px] text-gray-500">{f.stav}</td>
                      <td className="px-5 py-2.5 text-[12px] text-red-600 font-semibold tabular-nums text-right">{fmt(f.castka_s_dph)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

        </div>
      )}
    </div>
  )
}
