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
}

function fmt(n: number, mena: string) {
  return new Intl.NumberFormat('cs-CZ', { style: 'currency', currency: mena || 'CZK', maximumFractionDigits: 0 }).format(n)
}

function fmtDate(d: string) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('cs-CZ', { day: 'numeric', month: 'short', year: 'numeric' })
}

const TABS = [
  { key: 'nova', label: 'Ke schválení' },
  { key: 'schvalena', label: 'Schválené' },
  { key: 'zamitnuta', label: 'Zamítnuté' },
  { key: 'vse', label: 'Vše' },
] as const

type Tab = typeof TABS[number]['key']

export default function Home() {
  const [faktury, setFaktury] = useState<Faktura[]>([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<Tab>('nova')
  const [processing, setProcessing] = useState<number | null>(null)

  const load = async () => {
    setLoading(true)
    const res = await fetch('/api/faktury')
    setFaktury(await res.json())
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  const action = async (id: number, akce: 'schvalit' | 'zamítnout') => {
    setProcessing(id)
    await fetch(`/api/${akce}/${id}`, { method: 'POST' })
    await load()
    setProcessing(null)
  }

  const filtered = tab === 'vse' ? faktury : faktury.filter(f => f.stav === tab)
  const count = (s: string) => faktury.filter(f => f.stav === s).length

  const totalNova = faktury.filter(f => f.stav === 'nova').reduce((s, f) => s + Number(f.castka_s_dph), 0)

  return (
    <div style={{ fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Display", "Helvetica Neue", sans-serif' }}
      className="min-h-screen bg-[#f5f5f7]">

      {/* Header */}
      <header className="bg-white/80 backdrop-blur-xl border-b border-black/[0.08] sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-6 h-14 flex items-center justify-between">
          <span className="text-[15px] font-semibold text-gray-900 tracking-tight">SuperAccount</span>
          <button
            onClick={load}
            className="text-[13px] text-[#0071e3] hover:text-[#0077ed] font-medium"
          >
            Obnovit
          </button>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-8">

        {/* Summary card - only show when there are invoices to approve */}
        {count('nova') > 0 && (
          <div className="bg-white rounded-2xl px-6 py-5 mb-6 shadow-sm border border-black/[0.06]">
            <p className="text-[13px] text-gray-500 mb-1">Čeká na schválení</p>
            <div className="flex items-baseline gap-3">
              <span className="text-3xl font-semibold text-gray-900 tracking-tight">
                {count('nova')} faktur
              </span>
              <span className="text-[15px] text-gray-500">
                celkem {fmt(totalNova, 'CZK')}
              </span>
            </div>
          </div>
        )}

        {/* Tabs */}
        <div className="flex gap-1 mb-5 bg-black/[0.05] p-1 rounded-xl w-fit">
          {TABS.map(t => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`px-4 py-1.5 rounded-[10px] text-[13px] font-medium transition-all ${
                tab === t.key
                  ? 'bg-white text-gray-900 shadow-sm'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              {t.label}
              {t.key !== 'vse' && (
                <span className={`ml-1.5 text-[11px] ${tab === t.key ? 'text-gray-400' : 'text-gray-400'}`}>
                  {count(t.key)}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* Table */}
        {loading ? (
          <div className="text-center py-20 text-[13px] text-gray-400">Načítám…</div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-20 text-[13px] text-gray-400">Žádné faktury</div>
        ) : (
          <div className="bg-white rounded-2xl shadow-sm border border-black/[0.06] overflow-hidden">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-100">
                  <th className="text-left px-5 py-3 text-[11px] font-semibold text-gray-400 uppercase tracking-wider">Dodavatel</th>
                  <th className="text-left px-5 py-3 text-[11px] font-semibold text-gray-400 uppercase tracking-wider">Číslo</th>
                  <th className="text-left px-5 py-3 text-[11px] font-semibold text-gray-400 uppercase tracking-wider">Vystavení</th>
                  <th className="text-left px-5 py-3 text-[11px] font-semibold text-gray-400 uppercase tracking-wider">Splatnost</th>
                  <th className="text-right px-5 py-3 text-[11px] font-semibold text-gray-400 uppercase tracking-wider">Částka</th>
                  <th className="text-left px-5 py-3 text-[11px] font-semibold text-gray-400 uppercase tracking-wider">Popis</th>
                  <th className="px-5 py-3"></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((f, i) => (
                  <tr
                    key={f.id}
                    className={`${i < filtered.length - 1 ? 'border-b border-gray-50' : ''} hover:bg-[#f9f9f9] transition-colors`}
                  >
                    <td className="px-5 py-4">
                      <div className="text-[14px] font-medium text-gray-900">{f.dodavatel}</div>
                      <div className="text-[12px] text-gray-400 mt-0.5">IČO {f.ico}</div>
                    </td>
                    <td className="px-5 py-4 text-[13px] text-gray-600">{f.cislo_faktury}</td>
                    <td className="px-5 py-4 text-[13px] text-gray-600">{fmtDate(f.datum_vystaveni)}</td>
                    <td className="px-5 py-4 text-[13px] text-gray-600">{fmtDate(f.datum_splatnosti)}</td>
                    <td className="px-5 py-4 text-right">
                      <div className="text-[14px] font-semibold text-gray-900">{fmt(f.castka_s_dph, f.mena)}</div>
                      <div className="text-[11px] text-gray-400 mt-0.5">{f.mena} bez DPH {fmt(f.castka_bez_dph, f.mena)}</div>
                    </td>
                    <td className="px-5 py-4 text-[13px] text-gray-500 max-w-[220px]">
                      <span className="line-clamp-2">{f.popis}</span>
                    </td>
                    <td className="px-5 py-4">
                      {f.stav === 'nova' ? (
                        <div className="flex gap-2 justify-end">
                          <button
                            onClick={() => action(f.id, 'zamítnout')}
                            disabled={processing === f.id}
                            className="px-3.5 py-1.5 text-[13px] font-medium text-red-600 bg-red-50 rounded-[10px] hover:bg-red-100 disabled:opacity-40 transition-colors"
                          >
                            Zamítnout
                          </button>
                          <button
                            onClick={() => action(f.id, 'schvalit')}
                            disabled={processing === f.id}
                            className="px-3.5 py-1.5 text-[13px] font-medium text-white bg-[#0071e3] rounded-[10px] hover:bg-[#0077ed] disabled:opacity-40 transition-colors"
                          >
                            Schválit
                          </button>
                        </div>
                      ) : (
                        <div className="flex justify-end">
                          <span className={`px-2.5 py-1 rounded-full text-[11px] font-medium ${
                            f.stav === 'schvalena'
                              ? 'bg-green-50 text-green-700'
                              : 'bg-red-50 text-red-600'
                          }`}>
                            {f.stav === 'schvalena' ? 'Schválena' : 'Zamítnuta'}
                          </span>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>
    </div>
  )
}
