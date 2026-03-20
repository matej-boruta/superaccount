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
  platba_naplanovana: boolean
  datum_platby: string | null
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
type Section = 'faktury' | 'parovani' | 'transakce'
type TFilter = 'vse' | 'nesparovano' | 'sparovano'

function findMatch(faktura: Faktura, transakce: Transakce[]): Transakce | null {
  const nespar = transakce.filter(t => t.stav === 'nesparovano')
  if (faktura.variabilni_symbol) {
    const byVS = nespar.find(t => t.variabilni_symbol === faktura.variabilni_symbol)
    if (byVS) return byVS
  }
  const byAmt = nespar.find(t => {
    const diff = Math.abs(Math.abs(t.castka) - faktura.castka_s_dph) / faktura.castka_s_dph
    return diff < 0.10
  })
  return byAmt || null
}

export default function Home() {
  const [faktury, setFaktury] = useState<Faktura[]>([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<Tab>('nova')
  const [processing, setProcessing] = useState(false)
  const [selected, setSelected] = useState<Set<number>>(new Set())

  const [section, setSection] = useState<Section>('faktury')
  const [transakce, setTransakce] = useState<Transakce[]>([])
  const [transakceLoading, setTransakceLoading] = useState(false)
  const [tFilter, setTFilter] = useState<TFilter>('vse')
  const [activePicker, setActivePicker] = useState<number | null>(null)
  const [skipped, setSkipped] = useState<Set<number>>(new Set())
  // Map<fakturaId, transakceId> — checked pairs in párování
  const [selectedPairs, setSelectedPairs] = useState<Map<number, number>>(new Map())

  const load = async () => {
    setLoading(true)
    const res = await fetch('/api/faktury')
    setFaktury(await res.json())
    setLoading(false)
    setSelected(new Set())
  }

  const loadTransakce = async (currentFaktury?: Faktura[]) => {
    setTransakceLoading(true)
    const res = await fetch('/api/transakce')
    const data: Transakce[] = await res.json()
    setTransakce(data)
    setTransakceLoading(false)

    // Auto-pair: faktura where both VS and amount match (within 5%)
    const fList = currentFaktury ?? faktury
    const nespar = data.filter(t => t.stav === 'nesparovano')
    const pairedIds = new Set(data.filter(t => t.faktura_id !== null).map(t => t.faktura_id!))
    const autoPairs: { fakturaId: number; transakceId: number }[] = []
    const usedTransakceIds = new Set<number>()

    for (const f of fList.filter(f => f.stav === 'schvalena' && !pairedIds.has(f.id))) {
      if (!f.variabilni_symbol) continue
      const match = nespar.find(t =>
        !usedTransakceIds.has(t.id) &&
        t.variabilni_symbol === f.variabilni_symbol &&
        Math.abs(Math.abs(t.castka) - f.castka_s_dph) / f.castka_s_dph < 0.05
      )
      if (match) {
        autoPairs.push({ fakturaId: f.id, transakceId: match.id })
        usedTransakceIds.add(match.id)
      }
    }

    if (autoPairs.length > 0) {
      await Promise.all(autoPairs.map(p =>
        fetch('/api/sparovat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(p),
        })
      ))
      // Reload after auto-pairing
      const res2 = await fetch('/api/transakce')
      setTransakce(await res2.json())
    }
  }

  useEffect(() => { load() }, [])

  useEffect(() => {
    if (section !== 'faktury') loadTransakce(faktury)
  }, [section])

  const action = async (ids: number[], akce: 'schvalit' | 'zamítnout') => {
    setProcessing(true)
    await Promise.all(ids.map(id => fetch(`/api/${akce}/${id}`, { method: 'POST' })))
    await load()
    setProcessing(false)
  }

  const schvalitAZaplatit = async (id: number) => {
    setProcessing(true)
    await fetch(`/api/schvalit-a-zaplatit/${id}`, { method: 'POST' })
    await load()
    setProcessing(false)
  }

  const sparovat = async (fakturaId: number, transakceId: number) => {
    setProcessing(true)
    await fetch('/api/sparovat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fakturaId, transakceId }),
    })
    await loadTransakce()
    setProcessing(false)
    setActivePicker(null)
  }

  const sparovatVybrané = async () => {
    setProcessing(true)
    await Promise.all(
      Array.from(selectedPairs.entries()).map(([fakturaId, transakceId]) =>
        fetch('/api/sparovat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fakturaId, transakceId }),
        })
      )
    )
    setSelectedPairs(new Map())
    await loadTransakce()
    setProcessing(false)
  }

  // Faktury tab
  const filtered = tab === 'vse' ? faktury : faktury.filter(f => f.stav === tab)
  const novaFiltered = filtered.filter(f => f.stav === 'nova')
  const count = (s: string) => faktury.filter(f => f.stav === s).length
  const allChecked = novaFiltered.length > 0 && novaFiltered.every(f => selected.has(f.id))
  const someChecked = novaFiltered.some(f => selected.has(f.id))
  const toggleAll = () => allChecked ? setSelected(new Set()) : setSelected(new Set(novaFiltered.map(f => f.id)))
  const toggle = (id: number) => {
    const next = new Set(selected)
    next.has(id) ? next.delete(id) : next.add(id)
    setSelected(next)
  }
  const selectedTotal = faktury.filter(f => selected.has(f.id)).reduce((s, f) => s + Number(f.castka_s_dph), 0)
  const totalNova = faktury.filter(f => f.stav === 'nova').reduce((s, f) => s + Number(f.castka_s_dph), 0)

  // Párování
  const pairedFakturaIds = new Set(transakce.filter(t => t.faktura_id !== null).map(t => t.faktura_id!))
  const schvalenaUnpaired = faktury.filter(f => f.stav === 'schvalena' && !pairedFakturaIds.has(f.id) && !skipped.has(f.id))

  // Transakce
  const filteredT = tFilter === 'vse' ? transakce : transakce.filter(t => t.stav === tFilter)

  const SECTIONS: { key: Section; label: string }[] = [
    { key: 'faktury', label: 'Faktury' },
    { key: 'parovani', label: 'Párování' },
    { key: 'transakce', label: 'Transakce' },
  ]

  return (
    <div style={{ fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Display", "Helvetica Neue", sans-serif' }}
      className="min-h-screen bg-[#f5f5f7]">

      <header className="bg-white/80 backdrop-blur-xl border-b border-black/[0.08] sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-6 h-14 flex items-center justify-between">
          <div className="flex items-center gap-6">
            <span className="text-[15px] font-semibold text-gray-900 tracking-tight">SuperAccount</span>
            <nav className="flex gap-0.5">
              {SECTIONS.map(s => (
                <button
                  key={s.key}
                  onClick={() => setSection(s.key)}
                  className={`relative px-3 py-1.5 rounded-lg text-[13px] font-medium transition-colors ${
                    section === s.key ? 'text-gray-900 bg-black/[0.06]' : 'text-gray-500 hover:text-gray-700'
                  }`}
                >
                  {s.label}
                  {s.key === 'parovani' && schvalenaUnpaired.length > 0 && (
                    <span className="ml-1 inline-flex items-center justify-center w-4 h-4 text-[10px] font-bold text-white bg-[#0071e3] rounded-full">
                      {schvalenaUnpaired.length}
                    </span>
                  )}
                </button>
              ))}
            </nav>
          </div>
          <button
            onClick={() => { load(); if (section !== 'faktury') loadTransakce() }}
            className="text-[13px] text-[#0071e3] hover:text-[#0077ed] font-medium"
          >
            Obnovit
          </button>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-8">

        {/* ===== FAKTURY ===== */}
        {section === 'faktury' && (
          <>
            {count('nova') > 0 && (
              <div className="bg-white rounded-2xl px-6 py-5 mb-6 shadow-sm border border-black/[0.06]">
                <p className="text-[13px] text-gray-500 mb-1">Čeká na schválení</p>
                <div className="flex items-baseline gap-3">
                  <span className="text-3xl font-semibold text-gray-900 tracking-tight">{count('nova')} faktur</span>
                  <span className="text-[15px] text-gray-500">celkem {fmt(totalNova, 'CZK')}</span>
                </div>
              </div>
            )}

            <div className="flex items-center justify-between mb-5">
              <div className="flex gap-1 bg-black/[0.05] p-1 rounded-xl w-fit">
                {TABS.map(t => (
                  <button
                    key={t.key}
                    onClick={() => { setTab(t.key); setSelected(new Set()) }}
                    className={`px-4 py-1.5 rounded-[10px] text-[13px] font-medium transition-all ${
                      tab === t.key ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
                    }`}
                  >
                    {t.label}
                    {t.key !== 'vse' && (
                      <span className="ml-1.5 text-[11px] text-gray-400">{count(t.key)}</span>
                    )}
                  </button>
                ))}
              </div>

              {selected.size > 0 && (
                <div className="flex items-center gap-3 bg-white rounded-2xl px-4 py-2.5 shadow-sm border border-black/[0.06]">
                  <span className="text-[13px] text-gray-600">
                    {selected.size} faktur · <span className="font-semibold text-gray-900">{fmt(selectedTotal, 'CZK')}</span>
                  </span>
                  <div className="w-px h-4 bg-gray-200" />
                  <button
                    onClick={() => action(Array.from(selected), 'zamítnout')}
                    disabled={processing}
                    className="text-[13px] font-medium text-red-600 hover:text-red-700 disabled:opacity-40"
                  >
                    Zamítnout vše
                  </button>
                  <button
                    onClick={() => action(Array.from(selected), 'schvalit')}
                    disabled={processing}
                    className="px-4 py-1.5 text-[13px] font-medium text-white bg-[#0071e3] rounded-[10px] hover:bg-[#0077ed] disabled:opacity-40 transition-colors"
                  >
                    {processing ? 'Zpracovávám…' : `Schválit ${selected.size}`}
                  </button>
                </div>
              )}
            </div>

            {loading ? (
              <div className="text-center py-20 text-[13px] text-gray-400">Načítám…</div>
            ) : filtered.length === 0 ? (
              <div className="text-center py-20 text-[13px] text-gray-400">Žádné faktury</div>
            ) : (
              <div className="bg-white rounded-2xl shadow-sm border border-black/[0.06] overflow-hidden">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-gray-100">
                      <th className="px-4 py-3 w-10">
                        {novaFiltered.length > 0 && (
                          <input
                            type="checkbox"
                            checked={allChecked}
                            ref={el => { if (el) el.indeterminate = someChecked && !allChecked }}
                            onChange={toggleAll}
                            className="w-4 h-4 rounded accent-[#0071e3] cursor-pointer"
                          />
                        )}
                      </th>
                      <th className="text-left px-4 py-3 text-[11px] font-semibold text-gray-400 uppercase tracking-wider">Dodavatel</th>
                      <th className="text-left px-4 py-3 text-[11px] font-semibold text-gray-400 uppercase tracking-wider">Číslo</th>
                      <th className="text-left px-4 py-3 text-[11px] font-semibold text-gray-400 uppercase tracking-wider">Vystavení</th>
                      <th className="text-left px-4 py-3 text-[11px] font-semibold text-gray-400 uppercase tracking-wider">Splatnost</th>
                      <th className="text-right px-4 py-3 text-[11px] font-semibold text-gray-400 uppercase tracking-wider">Částka</th>
                      <th className="text-left px-4 py-3 text-[11px] font-semibold text-gray-400 uppercase tracking-wider">Popis</th>
                      <th className="px-4 py-3 w-32"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((f, i) => (
                      <tr
                        key={f.id}
                        onClick={() => f.stav === 'nova' && toggle(f.id)}
                        className={`${i < filtered.length - 1 ? 'border-b border-gray-50' : ''} transition-colors ${
                          selected.has(f.id) ? 'bg-blue-50/60' : 'hover:bg-[#f9f9f9]'
                        } ${f.stav === 'nova' ? 'cursor-pointer' : ''}`}
                      >
                        <td className="px-4 py-4" onClick={e => e.stopPropagation()}>
                          {f.stav === 'nova' && (
                            <input
                              type="checkbox"
                              checked={selected.has(f.id)}
                              onChange={() => toggle(f.id)}
                              className="w-4 h-4 rounded accent-[#0071e3] cursor-pointer"
                            />
                          )}
                        </td>
                        <td className="px-4 py-4">
                          <div className="text-[14px] font-medium text-gray-900">{f.dodavatel}</div>
                          <div className="text-[12px] text-gray-400 mt-0.5">IČO {f.ico}</div>
                        </td>
                        <td className="px-4 py-4 text-[13px] text-gray-600">{f.cislo_faktury}</td>
                        <td className="px-4 py-4 text-[13px] text-gray-600">{fmtDate(f.datum_vystaveni)}</td>
                        <td className="px-4 py-4 text-[13px] text-gray-600">{fmtDate(f.datum_splatnosti)}</td>
                        <td className="px-4 py-4 text-right">
                          <div className="text-[14px] font-semibold text-gray-900">{fmt(f.castka_s_dph, f.mena)}</div>
                          <div className="text-[11px] text-gray-400 mt-0.5">bez DPH {fmt(f.castka_bez_dph, f.mena)}</div>
                        </td>
                        <td className="px-4 py-4 text-[13px] text-gray-500 max-w-[200px]">
                          <span className="line-clamp-2">{f.popis}</span>
                        </td>
                        <td className="px-4 py-4" onClick={e => e.stopPropagation()}>
                          {f.stav === 'nova' ? (
                            <div className="flex flex-col gap-1.5 items-end">
                              <div className="flex gap-2">
                                <button
                                  onClick={() => action([f.id], 'zamítnout')}
                                  disabled={processing}
                                  className="px-3 py-1.5 text-[12px] font-medium text-red-600 bg-red-50 rounded-[8px] hover:bg-red-100 disabled:opacity-40"
                                >
                                  Zamítnout
                                </button>
                                <button
                                  onClick={() => action([f.id], 'schvalit')}
                                  disabled={processing}
                                  className="px-3 py-1.5 text-[12px] font-medium text-white bg-[#0071e3] rounded-[8px] hover:bg-[#0077ed] disabled:opacity-40"
                                >
                                  Schválit
                                </button>
                              </div>
                              <button
                                onClick={() => schvalitAZaplatit(f.id)}
                                disabled={processing}
                                className="px-3 py-1.5 text-[12px] font-medium text-white bg-[#34c759] rounded-[8px] hover:bg-[#2db84e] disabled:opacity-40 whitespace-nowrap"
                              >
                                Schválit a zaplatit
                              </button>
                            </div>
                          ) : (
                            <div className="flex flex-col items-end gap-1.5">
                              <span className={`px-2.5 py-1 rounded-full text-[11px] font-medium ${
                                f.stav === 'schvalena' ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-600'
                              }`}>
                                {f.stav === 'schvalena' ? 'Schválena' : 'Zamítnuta'}
                              </span>
                              {f.platba_naplanovana && f.datum_platby && (
                                <span className="px-2.5 py-1 rounded-full text-[11px] font-medium bg-blue-50 text-blue-700 whitespace-nowrap">
                                  Platba {fmtDate(f.datum_platby)}
                                </span>
                              )}
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}

        {/* ===== PÁROVÁNÍ ===== */}
        {section === 'parovani' && (
          <>
            {transakceLoading ? (
              <div className="text-center py-20 text-[13px] text-gray-400">Načítám…</div>
            ) : schvalenaUnpaired.length === 0 ? (
              <div className="bg-white rounded-2xl shadow-sm border border-black/[0.06] text-center py-20">
                <div className="text-[13px] text-gray-400">
                  {faktury.filter(f => f.stav === 'schvalena').length === 0
                    ? 'Nejsou žádné schválené faktury k párování'
                    : 'Všechny schválené faktury jsou spárovány'}
                </div>
              </div>
            ) : (
              <>
                {/* Bulk action bar */}
                {(() => {
                  const withSuggestions = schvalenaUnpaired.filter(f => findMatch(f, transakce))
                  const allChecked = withSuggestions.length > 0 && withSuggestions.every(f => selectedPairs.has(f.id))
                  const someChecked = withSuggestions.some(f => selectedPairs.has(f.id))
                  const toggleAllPairs = () => {
                    if (allChecked) {
                      setSelectedPairs(new Map())
                    } else {
                      const next = new Map<number, number>()
                      withSuggestions.forEach(f => {
                        const s = findMatch(f, transakce)
                        if (s) next.set(f.id, s.id)
                      })
                      setSelectedPairs(next)
                    }
                  }
                  return (
                    <div className="flex items-center justify-between mb-4">
                      <div className="flex items-center gap-3">
                        {withSuggestions.length > 0 && (
                          <label className="flex items-center gap-2 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={allChecked}
                              ref={el => { if (el) el.indeterminate = someChecked && !allChecked }}
                              onChange={toggleAllPairs}
                              className="w-4 h-4 rounded accent-[#0071e3] cursor-pointer"
                            />
                            <span className="text-[13px] text-gray-500">Vybrat vše s návrhem</span>
                          </label>
                        )}
                        <span className="text-[13px] text-gray-400">{schvalenaUnpaired.length} faktur čeká</span>
                      </div>
                      {selectedPairs.size > 0 && (
                        <div className="flex items-center gap-3 bg-white rounded-2xl px-4 py-2.5 shadow-sm border border-black/[0.06]">
                          <span className="text-[13px] text-gray-600">
                            <span className="font-semibold text-gray-900">{selectedPairs.size}</span> párů vybráno
                          </span>
                          <div className="w-px h-4 bg-gray-200" />
                          <button
                            onClick={sparovatVybrané}
                            disabled={processing}
                            className="px-4 py-1.5 text-[13px] font-medium text-white bg-[#0071e3] rounded-[10px] hover:bg-[#0077ed] disabled:opacity-40 transition-colors"
                          >
                            {processing ? 'Zpracovávám…' : `Spárovat ${selectedPairs.size}`}
                          </button>
                        </div>
                      )}
                    </div>
                  )
                })()}
                <div className="space-y-3">
                  {schvalenaUnpaired.map(f => {
                    const suggestion = findMatch(f, transakce)
                    const nespar = transakce.filter(t => t.stav === 'nesparovano')
                    const showPicker = activePicker === f.id
                    const isChecked = selectedPairs.has(f.id)
                    const togglePair = () => {
                      if (!suggestion) return
                      const next = new Map(selectedPairs)
                      isChecked ? next.delete(f.id) : next.set(f.id, suggestion.id)
                      setSelectedPairs(next)
                    }

                    return (
                      <div key={f.id} className={`bg-white rounded-2xl shadow-sm border p-5 transition-colors ${isChecked ? 'border-[#0071e3]/40 bg-blue-50/30' : 'border-black/[0.06]'}`}>
                        <div className="flex gap-5 items-start">

                          {/* Checkbox */}
                          <div className="flex-shrink-0 self-center">
                            {suggestion && (
                              <input
                                type="checkbox"
                                checked={isChecked}
                                onChange={togglePair}
                                className="w-4 h-4 rounded accent-[#0071e3] cursor-pointer"
                              />
                            )}
                          </div>

                          {/* Faktura */}
                          <div className="flex-1 min-w-0">
                            <div className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-2">Faktura</div>
                            <div className="text-[15px] font-semibold text-gray-900 truncate">{f.dodavatel}</div>
                            <div className="text-[12px] text-gray-500 mt-0.5">{f.cislo_faktury} · spl. {fmtDate(f.datum_splatnosti)}</div>
                            <div className="text-[20px] font-semibold text-gray-900 mt-2 tracking-tight">{fmt(f.castka_s_dph, f.mena)}</div>
                            {f.variabilni_symbol && (
                              <div className="text-[11px] text-gray-400 mt-0.5">VS {f.variabilni_symbol}</div>
                            )}
                          </div>

                          {/* Connector */}
                          <div className="flex-shrink-0 self-center">
                            <div className="w-8 h-px bg-gray-200 relative">
                              <span className="absolute -top-2.5 left-1/2 -translate-x-1/2 text-gray-300 text-[10px]">↔</span>
                            </div>
                          </div>

                          {/* Transakce */}
                          <div className="flex-1 min-w-0">
                            <div className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                              Transakce
                              {suggestion && (
                                <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                                  suggestion.variabilni_symbol === f.variabilni_symbol
                                    ? 'bg-green-50 text-green-600'
                                    : 'bg-blue-50 text-blue-600'
                                }`}>
                                  {suggestion.variabilni_symbol === f.variabilni_symbol ? 'shoda VS' : 'shoda částky'}
                                </span>
                              )}
                            </div>
                            {suggestion ? (
                              <>
                                <div className="text-[14px] font-medium text-gray-900 line-clamp-2 leading-snug">{suggestion.zprava || '—'}</div>
                                <div className="text-[12px] text-gray-500 mt-0.5">{fmtDate(suggestion.datum)} · {suggestion.typ}</div>
                                <div className={`text-[20px] font-semibold mt-2 tracking-tight ${suggestion.castka < 0 ? 'text-red-600' : 'text-green-700'}`}>
                                  {fmt(suggestion.castka, suggestion.mena)}
                                </div>
                                {suggestion.variabilni_symbol && (
                                  <div className="text-[11px] text-gray-400 mt-0.5">VS {suggestion.variabilni_symbol}</div>
                                )}
                              </>
                            ) : (
                              <div className="text-[13px] text-gray-400 italic pt-1">Žádná automatická shoda</div>
                            )}
                          </div>

                          {/* Actions */}
                          <div className="flex-shrink-0 flex flex-col gap-1.5 self-center min-w-[110px]">
                            {suggestion && (
                              <button
                                onClick={() => sparovat(f.id, suggestion.id)}
                                disabled={processing}
                                className="px-4 py-2 text-[13px] font-medium text-white bg-[#0071e3] rounded-[10px] hover:bg-[#0077ed] disabled:opacity-40 transition-colors"
                              >
                                Potvrdit
                              </button>
                            )}
                            <button
                              onClick={() => setActivePicker(showPicker ? null : f.id)}
                              className={`px-4 py-2 text-[13px] font-medium rounded-[10px] transition-colors ${
                                showPicker ? 'text-gray-700 bg-gray-100' : 'text-[#0071e3] bg-blue-50 hover:bg-blue-100'
                              }`}
                            >
                              {showPicker ? 'Zavřít' : 'Vybrat jinou'}
                            </button>
                            <button
                              onClick={() => setSkipped(s => new Set([...s, f.id]))}
                              className="px-4 py-2 text-[13px] font-medium text-gray-400 hover:text-gray-600 transition-colors"
                            >
                              Přeskočit
                            </button>
                          </div>
                        </div>

                        {/* Picker */}
                        {showPicker && (
                          <div className="mt-4 pt-4 border-t border-gray-100">
                            <div className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-2">
                              Nespárované transakce ({nespar.length})
                            </div>
                            {nespar.length === 0 ? (
                              <div className="text-[13px] text-gray-400 py-2">Žádné dostupné transakce</div>
                            ) : (
                              <div className="max-h-64 overflow-y-auto -mx-1">
                                {nespar.map(t => (
                                  <button
                                    key={t.id}
                                    onClick={() => sparovat(f.id, t.id)}
                                    disabled={processing}
                                    className="w-full text-left px-3 py-2.5 mx-1 rounded-xl hover:bg-[#f5f5f7] transition-colors flex items-center justify-between gap-4 disabled:opacity-40"
                                  >
                                    <div className="min-w-0 flex-1">
                                      <div className="text-[13px] font-medium text-gray-900 line-clamp-1">{t.zprava || '—'}</div>
                                      <div className="text-[11px] text-gray-400 mt-0.5">
                                        {fmtDate(t.datum)}{t.variabilni_symbol ? ` · VS ${t.variabilni_symbol}` : ''}
                                      </div>
                                    </div>
                                    <div className={`text-[14px] font-semibold flex-shrink-0 ${t.castka < 0 ? 'text-red-600' : 'text-green-700'}`}>
                                      {fmt(t.castka, t.mena)}
                                    </div>
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </>
            )}
          </>
        )}

        {/* ===== TRANSAKCE ===== */}
        {section === 'transakce' && (
          <>
            <div className="flex items-center justify-between mb-5">
              <div className="flex gap-1 bg-black/[0.05] p-1 rounded-xl w-fit">
                {([
                  { key: 'vse' as TFilter, label: 'Vše', n: transakce.length },
                  { key: 'nesparovano' as TFilter, label: 'Nespárované', n: transakce.filter(t => t.stav === 'nesparovano').length },
                  { key: 'sparovano' as TFilter, label: 'Spárované', n: transakce.filter(t => t.stav === 'sparovano').length },
                ]).map(item => (
                  <button
                    key={item.key}
                    onClick={() => setTFilter(item.key)}
                    className={`px-4 py-1.5 rounded-[10px] text-[13px] font-medium transition-all ${
                      tFilter === item.key ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
                    }`}
                  >
                    {item.label}
                    <span className="ml-1.5 text-[11px] text-gray-400">{item.n}</span>
                  </button>
                ))}
              </div>
              <span className="text-[13px] text-gray-400">{filteredT.length} pohybů</span>
            </div>

            {transakceLoading ? (
              <div className="text-center py-20 text-[13px] text-gray-400">Načítám…</div>
            ) : filteredT.length === 0 ? (
              <div className="text-center py-20 text-[13px] text-gray-400">Žádné transakce</div>
            ) : (
              <div className="bg-white rounded-2xl shadow-sm border border-black/[0.06] overflow-hidden">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-gray-100">
                      <th className="text-left px-4 py-3 text-[11px] font-semibold text-gray-400 uppercase tracking-wider">Datum</th>
                      <th className="text-left px-4 py-3 text-[11px] font-semibold text-gray-400 uppercase tracking-wider">Popis</th>
                      <th className="text-left px-4 py-3 text-[11px] font-semibold text-gray-400 uppercase tracking-wider">Typ</th>
                      <th className="text-right px-4 py-3 text-[11px] font-semibold text-gray-400 uppercase tracking-wider">Částka</th>
                      <th className="text-left px-4 py-3 text-[11px] font-semibold text-gray-400 uppercase tracking-wider">VS</th>
                      <th className="text-left px-4 py-3 text-[11px] font-semibold text-gray-400 uppercase tracking-wider">Stav</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredT.map((t, i) => {
                      const pairedF = t.faktura_id ? faktury.find(f => f.id === t.faktura_id) : null
                      return (
                        <tr
                          key={t.id}
                          className={`${i < filteredT.length - 1 ? 'border-b border-gray-50' : ''} hover:bg-[#f9f9f9] transition-colors`}
                        >
                          <td className="px-4 py-3.5 text-[13px] text-gray-600 whitespace-nowrap">{fmtDate(t.datum)}</td>
                          <td className="px-4 py-3.5 max-w-[280px]">
                            <div className="text-[13px] text-gray-800 line-clamp-1">{t.zprava || '—'}</div>
                            {t.protiucet && <div className="text-[11px] text-gray-400 mt-0.5 font-mono">{t.protiucet}</div>}
                          </td>
                          <td className="px-4 py-3.5 text-[12px] text-gray-500 whitespace-nowrap">{t.typ}</td>
                          <td className={`px-4 py-3.5 text-right text-[14px] font-semibold tabular-nums ${t.castka < 0 ? 'text-red-600' : 'text-green-700'}`}>
                            {fmt(t.castka, t.mena)}
                          </td>
                          <td className="px-4 py-3.5 text-[12px] text-gray-500 font-mono">{t.variabilni_symbol || '—'}</td>
                          <td className="px-4 py-3.5">
                            {t.stav === 'sparovano' ? (
                              <div>
                                <span className="inline-flex px-2.5 py-1 rounded-full text-[11px] font-medium bg-green-50 text-green-700">
                                  Spárováno
                                </span>
                                {pairedF && (
                                  <div className="text-[11px] text-gray-400 mt-1 line-clamp-1">{pairedF.dodavatel}</div>
                                )}
                              </div>
                            ) : (
                              <span className="inline-flex px-2.5 py-1 rounded-full text-[11px] font-medium bg-gray-100 text-gray-500">
                                Nespárováno
                              </span>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}

      </main>
    </div>
  )
}
