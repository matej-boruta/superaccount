'use client'

import { Fragment, useEffect, useState } from 'react'

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
  kategorie_id: number | null
  zauctovano_platba: boolean | null
}

type Kategorie = {
  id: number
  l1: string
  l2: string
  ucetni_kod: string
  stredisko: string
  popis_pro_ai: string
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

function fmtDate(d: string | null | undefined) {
  if (!d) return '—'
  const parts = d.split('T')[0].split('-')
  if (parts.length !== 3) return '—'
  const year = parseInt(parts[0])
  if (year < 2000 || year > 2100) return '—'
  const date = new Date(year, parseInt(parts[1]) - 1, parseInt(parts[2]))
  return date.toLocaleDateString('cs-CZ', { day: 'numeric', month: 'short', year: 'numeric' })
}

type Tab = 'nova' | 'schvalena' | 'zaplacena' | 'zamitnuta' | 'vse' | 'sparovane' | 'nesparovane'
type Section = 'faktury'
type TFilter = 'vse' | 'nesparovano' | 'sparovano'

const TABS = [
  { key: 'nova' as Tab, label: 'Ke schválení' },
  { key: 'schvalena' as Tab, label: 'Čekající platby' },
  { key: 'zaplacena' as Tab, label: 'Zaplacené' },
  { key: 'zamitnuta' as Tab, label: 'Zamítnuté' },
  { key: 'sparovane' as Tab, label: 'Spárované' },
  { key: 'nesparovane' as Tab, label: 'Nespárované' },
  { key: 'vse' as Tab, label: 'Vše' },
]

function dayLabel(d: string): string | null {
  if (!d) return null
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const date = new Date(d); date.setHours(0, 0, 0, 0)
  const diff = Math.round((date.getTime() - today.getTime()) / 86400000)
  if (diff < 0) return 'Po splatnosti'
  if (diff === 0) return 'Dnes'
  if (diff === 1) return 'Zítra'
  if (diff <= 3) return `Za ${diff} dny`
  return null
}

type MatchCandidate = { t: Transakce; score: number; reasons: string[] }

function scoreCandidate(faktura: Faktura, t: Transakce): MatchCandidate {
  let score = 0
  const reasons: string[] = []
  const amtDiff = Math.abs(Math.abs(t.castka) - faktura.castka_s_dph) / (faktura.castka_s_dph || 1)
  const vsMatch = !!(faktura.variabilni_symbol && t.variabilni_symbol === faktura.variabilni_symbol)
  const nameInZprava = !!(faktura.dodavatel && t.zprava?.toLowerCase().includes(faktura.dodavatel.split(' ')[0].toLowerCase()))
  const daysDiff = faktura.datum_splatnosti && t.datum
    ? Math.abs((new Date(t.datum).getTime() - new Date(faktura.datum_splatnosti).getTime()) / 86400000)
    : 999

  if (vsMatch) { score += 50; reasons.push('VS ✓') }
  if (amtDiff < 0.01) { score += 40; reasons.push('částka ✓') }
  else if (amtDiff < 0.05) { score += 25; reasons.push('částka ≈') }
  else if (amtDiff < 0.15) { score += 10; reasons.push('částka ~') }
  if (nameInZprava) { score += 15; reasons.push('název ✓') }
  if (daysDiff <= 7) { score += 10; reasons.push('datum ✓') }
  else if (daysDiff <= 30) { score += 5; reasons.push('datum ~') }

  return { t, score, reasons }
}

function findTopMatches(faktura: Faktura, transakce: Transakce[], n = 3): MatchCandidate[] {
  const nespar = transakce.filter(t => t.stav === 'nesparovano')
  return nespar
    .map(t => scoreCandidate(faktura, t))
    .filter(c => c.score >= 40)
    .sort((a, b) => b.score - a.score)
    .slice(0, n)
}

function findMatch(faktura: Faktura, transakce: Transakce[]): Transakce | null {
  const top = findTopMatches(faktura, transakce, 1)
  return top[0]?.t ?? null
}

export default function Home() {
  const [faktury, setFaktury] = useState<Faktura[]>([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<Tab>('nova')
  const [processing, setProcessing] = useState(false)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [kategorieList, setKategorieList] = useState<Kategorie[]>([])
  // Map<fakturaId, selectedKategorieId> — for overriding category before approval
  const [kategorieOverride, setKategorieOverride] = useState<Map<number, number>>(new Map())
  const [classifying, setClassifying] = useState(false)

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
    const json = await res.json()
    const data: Faktura[] = Array.isArray(json) ? json : []
    setFaktury(data)
    setLoading(false)
    setSelected(new Set())

    // Auto-classify nova faktury without kategorie_id (batched, max 5 at a time)
    const toClassify = data.filter(f => f.stav === 'nova' && !f.kategorie_id)
    if (toClassify.length > 0) {
      setClassifying(true)
      const batchSize = 5
      const run = async () => {
        for (let i = 0; i < toClassify.length; i += batchSize) {
          const batch = toClassify.slice(i, i + batchSize)
          await Promise.all(batch.map(f => fetch(`/api/klasifikovat/${f.id}`, { method: 'POST' }).catch(() => {})))
          // Update faktury after each batch so user sees progress
          const r = await fetch('/api/faktury')
          const updated = await r.json()
          if (Array.isArray(updated)) setFaktury(updated)
        }
        setClassifying(false)
      }
      run().catch(() => setClassifying(false))
    }
  }

  useEffect(() => {
    fetch('/api/kategorie').then(r => r.json()).then(setKategorieList).catch(() => {})
  }, [])

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
    if (tab === 'schvalena' || tab === 'sparovane' || tab === 'nesparovane') loadTransakce(faktury)
  }, [tab])

  const [selectedSchvalena, setSelectedSchvalena] = useState<Set<number>>(new Set())

  // Only handles zamítnout now
  const action = async (ids: number[], akce: 'zamítnout') => {
    setProcessing(true)
    await Promise.all(ids.map(id => fetch(`/api/${akce}/${id}`, { method: 'POST' })))
    await load()
    setProcessing(false)
  }

  const schvalitAZaplatit = async (id: number, kategorieId?: number) => {
    setProcessing(true)
    await fetch(`/api/schvalit-a-zaplatit/${id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(kategorieId ? { kategorie_id: kategorieId } : {}),
    })
    await load()
    setProcessing(false)
  }

  const zrusitZaplaceni = async (id: number) => {
    setProcessing(true)
    await fetch('/api/zrusit-zaplaceni', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fakturaId: id }),
    })
    await loadTransakce()
    setProcessing(false)
  }

  const zrusitSchvaleni = async (ids: number[]) => {
    setProcessing(true)
    await Promise.all(ids.map(id => fetch(`/api/zrusit-schvaleni/${id}`, { method: 'POST' })))
    setSelectedSchvalena(new Set())
    await load()
    setProcessing(false)
  }

  const zauctovat = async (id: number) => {
    setProcessing(true)
    await fetch(`/api/zauctovat-platbu/${id}`, { method: 'POST' })
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
    // Deduplicate — each transakce can only be paired once
    const usedT = new Set<number>()
    const pairs: { fakturaId: number; transakceId: number }[] = []
    for (const [fakturaId, transakceId] of selectedPairs.entries()) {
      if (!usedT.has(transakceId)) { pairs.push({ fakturaId, transakceId }); usedT.add(transakceId) }
    }
    for (const p of pairs) {
      await fetch('/api/sparovat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(p),
      })
    }
    setSelectedPairs(new Map())
    await loadTransakce()
    setProcessing(false)
  }

  // ===== FAKTURY computed =====
  const isTransakceTab = tab === 'sparovane' || tab === 'nesparovane'
  const filtered = tab === 'vse' ? faktury : isTransakceTab ? [] : faktury.filter(f => f.stav === tab)

  // For schvalena tab: sort by datum_platby ascending
  const filteredSorted = tab === 'schvalena'
    ? [...filtered].sort((a, b) => {
        if (!a.datum_platby && !b.datum_platby) return 0
        if (!a.datum_platby) return 1
        if (!b.datum_platby) return -1
        return new Date(a.datum_platby).getTime() - new Date(b.datum_platby).getTime()
      })
    : filtered

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

  const schvalenaFiltered = filteredSorted.filter(f => f.stav === 'schvalena')
  const allSchvalenaChecked = schvalenaFiltered.length > 0 && schvalenaFiltered.every(f => selectedSchvalena.has(f.id))
  const someSchvalenaChecked = schvalenaFiltered.some(f => selectedSchvalena.has(f.id))
  const toggleAllSchvalena = () => allSchvalenaChecked
    ? setSelectedSchvalena(new Set())
    : setSelectedSchvalena(new Set(schvalenaFiltered.map(f => f.id)))
  const toggleSchvalena = (id: number) => {
    const next = new Set(selectedSchvalena)
    next.has(id) ? next.delete(id) : next.add(id)
    setSelectedSchvalena(next)
  }
  const selectedSchvalenaTotal = faktury.filter(f => selectedSchvalena.has(f.id)).reduce((s, f) => s + Number(f.castka_s_dph), 0)

  // Schvalena banner
  const schvalenaFaktury = faktury.filter(f => f.stav === 'schvalena')
  const schvalenaCelkem = schvalenaFaktury.reduce((s, f) => s + Number(f.castka_s_dph), 0)
  const nejblizsiPlatba = schvalenaFaktury
    .filter(f => f.datum_platby)
    .sort((a, b) => new Date(a.datum_platby!).getTime() - new Date(b.datum_platby!).getTime())[0]

  // ===== PÁROVÁNÍ =====
  const pairedFakturaIds = new Set(transakce.filter(t => t.faktura_id !== null).map(t => t.faktura_id!))
  const schvalenaUnpaired = faktury.filter(f => f.stav === 'schvalena' && !skipped.has(f.id))
  const nesparTransakce = transakce.filter(t => t.stav === 'nesparovano')
  const withSuggestions = schvalenaUnpaired.filter(f => findMatch(f, transakce))
  const allPairsChecked = withSuggestions.length > 0 && withSuggestions.every(f => selectedPairs.has(f.id))
  const somePairsChecked = withSuggestions.some(f => selectedPairs.has(f.id))
  const toggleAllPairs = () => {
    if (allPairsChecked) { setSelectedPairs(new Map()); return }
    const next = new Map<number, number>()
    const usedT = new Set<number>()
    withSuggestions.forEach(f => {
      const s = findMatch(f, transakce)
      if (s && !usedT.has(s.id)) { next.set(f.id, s.id); usedT.add(s.id) }
    })
    setSelectedPairs(next)
  }
  const exactMatches = schvalenaUnpaired.filter(f => {
    if (!f.variabilni_symbol) return false
    return !!nesparTransakce.find(t =>
      t.variabilni_symbol === f.variabilni_symbol &&
      Math.abs(Math.abs(t.castka) - f.castka_s_dph) / f.castka_s_dph < 0.05
    )
  })
  const sparovatExact = async () => {
    setProcessing(true)
    const pairs: { fakturaId: number; transakceId: number }[] = []
    const used = new Set<number>()
    for (const f of exactMatches) {
      const t = nesparTransakce.find(t =>
        !used.has(t.id) &&
        t.variabilni_symbol === f.variabilni_symbol &&
        Math.abs(Math.abs(t.castka) - f.castka_s_dph) / f.castka_s_dph < 0.05
      )
      if (t) { pairs.push({ fakturaId: f.id, transakceId: t.id }); used.add(t.id) }
    }
    await Promise.all(pairs.map(p =>
      fetch('/api/sparovat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) })
    ))
    await loadTransakce(faktury)
    setProcessing(false)
  }

  // ===== TRANSAKCE =====
  const filteredT = tFilter === 'vse' ? transakce : transakce.filter(t => t.stav === tFilter)

  const SECTIONS: { key: Section; label: string }[] = [
    { key: 'faktury', label: 'Faktury' },
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
                </button>
              ))}
            </nav>
          </div>
          <div className="flex items-center gap-3">
            {classifying && (
              <span className="text-[12px] text-gray-400 animate-pulse">Klasifikuji kategorie…</span>
            )}
            <button
              onClick={() => { load(); if (section !== 'faktury') loadTransakce() }}
              className="text-[13px] text-[#0071e3] hover:text-[#0077ed] font-medium"
            >
              Obnovit
            </button>
          </div>
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
                      <span className="ml-1.5 text-[11px] text-gray-400">
                        {t.key === 'sparovane' ? transakce.filter(tx => tx.stav === 'sparovano').length
                          : t.key === 'nesparovane' ? transakce.filter(tx => tx.stav === 'nesparovano').length
                          : count(t.key)}
                      </span>
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
                    onClick={async () => {
                      setProcessing(true)
                      await Promise.all(Array.from(selected).map(id => {
                        const override = kategorieOverride.get(id)
                        return fetch(`/api/schvalit-a-zaplatit/${id}`, {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify(override ? { kategorie_id: override } : {}),
                        })
                      }))
                      await load()
                      setProcessing(false)
                    }}
                    disabled={processing}
                    className="px-4 py-1.5 text-[13px] font-medium text-white bg-[#0071e3] rounded-[10px] hover:bg-[#0077ed] disabled:opacity-40 transition-colors"
                  >
                    {processing ? 'Zpracovávám…' : `Schválit ${selected.size}`}
                  </button>
                </div>
              )}
              {selectedSchvalena.size > 0 && (
                <div className="flex items-center gap-3 bg-white rounded-2xl px-4 py-2.5 shadow-sm border border-black/[0.06]">
                  <span className="text-[13px] text-gray-600">
                    {selectedSchvalena.size} faktur · <span className="font-semibold text-gray-900">{fmt(selectedSchvalenaTotal, 'CZK')}</span>
                  </span>
                  <div className="w-px h-4 bg-gray-200" />
                  <button
                    onClick={() => zrusitSchvaleni(Array.from(selectedSchvalena))}
                    disabled={processing}
                    className="text-[13px] font-medium text-red-600 hover:text-red-700 disabled:opacity-40"
                  >
                    {processing ? 'Zpracovávám…' : `Zrušit schválení ${selectedSchvalena.size}`}
                  </button>
                </div>
              )}
            </div>

            {/* Čekající platby summary banner */}
            {tab === 'schvalena' && schvalenaFaktury.length > 0 && (
              <div className="bg-blue-50 border border-blue-100 rounded-2xl px-5 py-3.5 mb-4 flex items-center gap-3">
                <span className="text-[13px] text-blue-800">
                  <span className="font-semibold">{schvalenaFaktury.length}</span> faktur čeká na zaplacení
                  {' · '}celkem <span className="font-semibold">{fmt(schvalenaCelkem, 'CZK')}</span>
                  {nejblizsiPlatba && nejblizsiPlatba.datum_platby && (
                    <> · nejbližší platba: <span className="font-semibold">{fmtDate(nejblizsiPlatba.datum_platby)}</span></>
                  )}
                </span>
              </div>
            )}

            {loading ? (
              <div className="text-center py-20 text-[13px] text-gray-400">Načítám…</div>
            ) : filteredSorted.length === 0 ? (
              <div className="text-center py-20 text-[13px] text-gray-400">Žádné faktury</div>
            ) : (
              <div className="bg-white rounded-2xl shadow-sm border border-black/[0.06] overflow-hidden">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-gray-100">
                      <th className="px-4 py-3 w-10">
                        {novaFiltered.length > 0 && tab === 'nova' && (
                          <input
                            type="checkbox"
                            checked={allChecked}
                            ref={el => { if (el) el.indeterminate = someChecked && !allChecked }}
                            onChange={toggleAll}
                            className="w-4 h-4 rounded accent-[#0071e3] cursor-pointer"
                          />
                        )}
                        {schvalenaFiltered.length > 0 && tab === 'schvalena' && (
                          <input
                            type="checkbox"
                            checked={allSchvalenaChecked}
                            ref={el => { if (el) el.indeterminate = someSchvalenaChecked && !allSchvalenaChecked }}
                            onChange={toggleAllSchvalena}
                            className="w-4 h-4 rounded accent-[#0071e3] cursor-pointer"
                          />
                        )}
                      </th>
                      <th className="text-left px-4 py-3 text-[11px] font-semibold text-gray-400 uppercase tracking-wider">Dodavatel</th>
                      <th className="text-left px-4 py-3 text-[11px] font-semibold text-gray-400 uppercase tracking-wider">Faktura / VS</th>
                      <th className="text-left px-4 py-3 text-[11px] font-semibold text-gray-400 uppercase tracking-wider">Splatnost</th>
                      <th className="text-left px-4 py-3 text-[11px] font-semibold text-gray-400 uppercase tracking-wider">Kategorie</th>
                      <th className="text-right px-4 py-3 text-[11px] font-semibold text-gray-400 uppercase tracking-wider">Částka</th>
                      <th className="px-4 py-3 w-48"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredSorted.map((f, i) => {
                      const dl = f.datum_platby ? dayLabel(f.datum_platby) : null
                      const isUrgent = dl === 'Dnes' || dl === 'Po splatnosti'
                      const isSoon = dl === 'Zítra' || (dl !== null && dl.startsWith('Za'))
                      const effectiveKategorieId = kategorieOverride.get(f.id) ?? f.kategorie_id ?? undefined
                      const kat = kategorieList.find(k => k.id === effectiveKategorieId)
                      const suggestion = f.stav === 'schvalena' ? findMatch(f, transakce) : null
                      const pairedT = transakce.find(t => t.faktura_id === f.id && t.stav === 'sparovano')
                      const showPicker = activePicker === f.id
                      return (
                        <Fragment key={f.id}>
                        <tr
                          onClick={() => f.stav === 'nova' && toggle(f.id)}
                          className={`${i < filteredSorted.length - 1 || showPicker ? 'border-b border-gray-50' : ''} transition-colors ${
                            selected.has(f.id) ? 'bg-blue-50/60' : 'hover:bg-[#f9f9f9]'
                          } ${f.stav === 'nova' ? 'cursor-pointer' : ''} text-sm`}
                        >
                          <td className="px-4 py-2.5" onClick={e => e.stopPropagation()}>
                            {f.stav === 'nova' && (
                              <input
                                type="checkbox"
                                checked={selected.has(f.id)}
                                onChange={() => toggle(f.id)}
                                className="w-4 h-4 rounded accent-[#0071e3] cursor-pointer"
                              />
                            )}
                            {f.stav === 'schvalena' && (
                              <input
                                type="checkbox"
                                checked={selectedSchvalena.has(f.id)}
                                onChange={() => toggleSchvalena(f.id)}
                                className="w-4 h-4 rounded accent-[#0071e3] cursor-pointer"
                              />
                            )}
                          </td>
                          {/* col: Dodavatel */}
                          <td className="px-4 py-2.5">
                            <div className="text-[13px] font-medium text-gray-900">{f.dodavatel}</div>
                            <div className="text-[11px] text-gray-400">IČO {f.ico}</div>
                          </td>
                          {/* col: Faktura / VS */}
                          <td className="px-4 py-2.5">
                            <div className="text-[13px] text-gray-700">{f.cislo_faktury || '—'}</div>
                            {f.variabilni_symbol && (
                              <div className="text-[11px] font-mono text-gray-400 mt-0.5">VS {f.variabilni_symbol}</div>
                            )}
                          </td>
                          {/* col: Splatnost */}
                          <td className="px-4 py-2.5">
                            {(() => {
                              const actualPayDate = pairedT?.datum ?? f.datum_platby ?? null
                              const onTime = actualPayDate && f.datum_splatnosti
                                ? new Date(actualPayDate) <= new Date(f.datum_splatnosti) : null
                              return (
                                <div>
                                  <div className="text-[13px] text-gray-700">{fmtDate(f.datum_splatnosti)}</div>
                                  {actualPayDate && (
                                    <div className={`text-[11px] mt-0.5 ${onTime === false ? 'text-red-500' : 'text-gray-400'}`}>
                                      pl. {fmtDate(actualPayDate)}{onTime === false ? ' !' : ''}
                                    </div>
                                  )}
                                </div>
                              )
                            })()}
                          </td>
                          {/* col: Kategorie */}
                          <td className="px-4 py-2.5" onClick={e => e.stopPropagation()}>
                            {f.stav === 'nova' && kategorieList.length > 0 ? (
                              <select
                                value={effectiveKategorieId ?? ''}
                                onChange={e => {
                                  const next = new Map(kategorieOverride)
                                  const val = Number(e.target.value)
                                  if (val) next.set(f.id, val); else next.delete(f.id)
                                  setKategorieOverride(next)
                                }}
                                className={`text-[11px] rounded-lg px-2 py-1 border outline-none cursor-pointer max-w-[130px] ${
                                  kat ? 'bg-purple-50 border-purple-200 text-purple-800 font-medium' : 'bg-gray-50 border-gray-200 text-gray-400'
                                }`}
                              >
                                <option value="">— kategorie —</option>
                                {kategorieList.map(k => (
                                  <option key={k.id} value={k.id}>{k.l1} / {k.l2}</option>
                                ))}
                              </select>
                            ) : kat ? (
                              <span className="text-[11px] px-2 py-0.5 rounded-lg bg-purple-50 text-purple-700 font-medium">{kat.l1} / {kat.l2}</span>
                            ) : (
                              <span className="text-[12px] text-gray-400">—</span>
                            )}
                          </td>
                          {/* col: Částka */}
                          <td className="px-4 py-2.5 text-right">
                            <div className="text-[13px] font-semibold text-gray-900">{fmt(Number(f.castka_s_dph), f.mena)}</div>
                            {f.stav !== 'schvalena' && (
                              <div className="text-[11px] text-gray-400">bez DPH {fmt(f.castka_bez_dph, f.mena)}</div>
                            )}
                          </td>
                          {/* col: Actions */}
                          <td className="px-4 py-2.5" onClick={e => e.stopPropagation()}>
                            <div className="flex items-center gap-2 justify-end">
                              {f.stav === 'nova' && (<>
                                <button onClick={() => action([f.id], 'zamítnout')} disabled={processing}
                                  className="px-3 py-1.5 text-[12px] font-medium text-red-600 bg-red-50 rounded-[8px] hover:bg-red-100 disabled:opacity-40">
                                  Zamítnout
                                </button>
                                <button onClick={() => schvalitAZaplatit(f.id, kategorieOverride.get(f.id) ?? f.kategorie_id ?? undefined)} disabled={processing}
                                  className="px-3 py-1.5 text-[12px] font-medium text-white bg-[#0071e3] rounded-[8px] hover:bg-[#0077ed] disabled:opacity-40 whitespace-nowrap">
                                  Schválit
                                </button>
                              </>)}
                              {f.stav === 'schvalena' && (<>
                                <button onClick={() => setActivePicker(showPicker ? null : f.id)}
                                  className="px-2.5 py-1 text-[12px] font-medium text-[#0071e3] bg-blue-50 rounded-[7px] hover:bg-blue-100 whitespace-nowrap">
                                  {showPicker ? 'Zavřít' : '···'}
                                </button>
                                <button onClick={() => zrusitSchvaleni([f.id])} disabled={processing}
                                  className="px-2.5 py-1 text-[12px] font-medium text-gray-500 bg-gray-100 rounded-[7px] hover:bg-red-50 hover:text-red-600 disabled:opacity-40 transition-colors whitespace-nowrap">
                                  Zrušit
                                </button>
                              </>)}
                              {f.stav === 'zaplacena' && (<>
                                <span className="inline-flex px-2.5 py-1 rounded-full text-[11px] font-semibold bg-green-50 text-green-700">Zaplaceno</span>
                                <button onClick={() => zrusitZaplaceni(f.id)} disabled={processing}
                                  className="px-2.5 py-1 text-[12px] font-medium text-gray-500 bg-gray-100 rounded-[7px] hover:bg-red-50 hover:text-red-600 disabled:opacity-40 transition-colors whitespace-nowrap">
                                  Zrušit
                                </button>
                              </>)}
                              {f.stav === 'zamitnuta' && (
                                <span className="inline-flex px-2.5 py-1 rounded-full text-[11px] font-semibold bg-red-50 text-red-600">Zamítnuto</span>
                              )}
                            </div>
                          </td>
                        </tr>
                        {/* Sub-řádek: navrhovaná platba (schvalena) — 7 cols aligned */}
                        {f.stav === 'schvalena' && suggestion && !showPicker && (() => {
                          const vsOk = !!f.variabilni_symbol && suggestion.variabilni_symbol === f.variabilni_symbol
                          const amtOk = Math.abs(Math.abs(suggestion.castka) - Number(f.castka_s_dph)) < 1
                          return (
                            <tr className="border-b border-blue-100/60 bg-blue-50/25">
                              <td className="pl-4 pr-0 py-2 text-blue-400 text-[11px]">↳</td>
                              {/* Dodavatel col: zpráva platby */}
                              <td className="px-4 py-2 text-[12px] text-gray-500 line-clamp-1 max-w-[180px]">
                                {suggestion.zprava || suggestion.protiucet || '—'}
                              </td>
                              {/* Faktura/VS col: TX VS (srovnej s FA VS výše) */}
                              <td className="px-4 py-2">
                                <span className={`text-[12px] font-mono ${vsOk ? 'text-green-600 font-semibold' : 'text-gray-500'}`}>
                                  VS {suggestion.variabilni_symbol || '—'}
                                </span>
                                {vsOk && <span className="ml-1 text-[11px] text-green-600">✓</span>}
                                {!vsOk && f.variabilni_symbol && suggestion.variabilni_symbol && (
                                  <span className="ml-1 text-[11px] text-orange-500">≠</span>
                                )}
                              </td>
                              {/* Splatnost col: TX datum (srovnej s datem faktury výše) */}
                              <td className="px-4 py-2 text-[12px] text-gray-500">{fmtDate(suggestion.datum)}</td>
                              {/* Kategorie col: prázdné */}
                              <td></td>
                              {/* Částka col: TX částka (srovnej s FA částkou výše) */}
                              <td className="px-4 py-2 text-right">
                                <span className={`text-[13px] font-semibold ${amtOk ? 'text-green-600' : 'text-orange-500'}`}>
                                  {fmt(Math.abs(suggestion.castka), suggestion.mena)}
                                  {amtOk && <span className="ml-1 text-[11px]">✓</span>}
                                </span>
                              </td>
                              {/* Actions col: Spárovat */}
                              <td className="px-4 py-2 text-right" onClick={e => e.stopPropagation()}>
                                <button onClick={() => sparovat(f.id, suggestion.id)} disabled={processing}
                                  className="px-3 py-1.5 text-[12px] font-medium text-white bg-[#0071e3] rounded-[7px] hover:bg-[#0077ed] disabled:opacity-40 whitespace-nowrap">
                                  Spárovat
                                </button>
                              </td>
                            </tr>
                          )
                        })()}
                        {/* Sub-řádek: spárovaná transakce (zaplacena) — 7 cols aligned */}
                        {f.stav === 'zaplacena' && pairedT && (() => {
                          const vsOk = !!f.variabilni_symbol && pairedT.variabilni_symbol === f.variabilni_symbol
                          const amtOk = Math.abs(Math.abs(pairedT.castka) - Number(f.castka_s_dph)) < 1
                          return (
                            <tr className="border-b border-green-100/60 bg-green-50/20">
                              <td className="pl-4 pr-0 py-2 text-green-500 text-[11px]">↳</td>
                              <td className="px-4 py-2 text-[12px] text-gray-500 line-clamp-1 max-w-[180px]">
                                {pairedT.zprava || pairedT.protiucet || '—'}
                              </td>
                              <td className="px-4 py-2">
                                <span className={`text-[12px] font-mono ${vsOk ? 'text-green-600 font-semibold' : 'text-gray-500'}`}>
                                  VS {pairedT.variabilni_symbol || '—'}
                                </span>
                                {vsOk && <span className="ml-1 text-[11px] text-green-600">✓</span>}
                              </td>
                              <td className="px-4 py-2 text-[12px] text-gray-500">{fmtDate(pairedT.datum)}</td>
                              <td></td>
                              <td className="px-4 py-2 text-right">
                                <span className={`text-[13px] font-semibold ${amtOk ? 'text-green-600' : 'text-orange-500'}`}>
                                  {fmt(Math.abs(pairedT.castka), pairedT.mena)}
                                  {amtOk && <span className="ml-1 text-[11px]">✓</span>}
                                </span>
                              </td>
                              <td></td>
                            </tr>
                          )
                        })()}
                        {f.stav === 'schvalena' && showPicker && (() => {
                          const topMatches = findTopMatches(f, transakce)
                          return (
                            <tr className="border-b border-gray-50 bg-gray-50/50">
                              <td colSpan={7} className="px-6 py-3">
                                {topMatches.length === 0 ? (
                                  <div className="text-[12px] text-gray-400 py-1">Žádná odpovídající platba — čekáme na příchod transakce z banky.</div>
                                ) : (
                                  <div className="space-y-1.5">
                                    <div className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-2">Navrhované platby</div>
                                    {topMatches.map((c, idx) => (
                                      <button key={c.t.id} onClick={() => sparovat(f.id, c.t.id)} disabled={processing}
                                        className={`w-full text-left px-3 py-2.5 rounded-xl transition-colors flex items-center justify-between gap-4 disabled:opacity-40 ${
                                          idx === 0 ? 'bg-blue-50 border border-blue-200 hover:bg-blue-100' : 'bg-white border border-gray-100 hover:bg-gray-50'
                                        }`}>
                                        <div className="min-w-0 flex-1">
                                          <div className="flex items-center gap-2 mb-0.5">
                                            {idx === 0 && <span className="text-[10px] font-bold text-blue-600 bg-blue-100 px-1.5 py-0.5 rounded">Nejlepší shoda</span>}
                                            <span className="flex gap-1">
                                              {c.reasons.map(r => (
                                                <span key={r} className="text-[10px] font-medium text-green-700 bg-green-50 px-1.5 py-0.5 rounded">{r}</span>
                                              ))}
                                            </span>
                                          </div>
                                          <div className="text-[13px] text-gray-800 line-clamp-1">{c.t.zprava || '—'}</div>
                                          <div className="text-[11px] text-gray-400">{fmtDate(c.t.datum)}{c.t.variabilni_symbol ? ` · VS ${c.t.variabilni_symbol}` : ''}</div>
                                        </div>
                                        <span className={`text-[13px] font-semibold flex-shrink-0 ${c.t.castka < 0 ? 'text-red-600' : 'text-green-700'}`}>
                                          {fmt(c.t.castka, c.t.mena)}
                                        </span>
                                      </button>
                                    ))}
                                  </div>
                                )}
                              </td>
                            </tr>
                          )
                        })()}
                        </Fragment>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {/* ===== TRANSAKCE ZÁLOŽKY (Spárované / Nespárované) ===== */}
            {isTransakceTab && (() => {
              const tList = transakce.filter(t => tab === 'sparovane' ? t.stav === 'sparovano' : t.stav === 'nesparovano')
              return transakceLoading ? (
                <div className="text-center py-20 text-[13px] text-gray-400">Načítám…</div>
              ) : tList.length === 0 ? (
                <div className="text-center py-20 text-[13px] text-gray-400">Žádné transakce</div>
              ) : (
                <div className="bg-white rounded-2xl shadow-sm border border-black/[0.06] overflow-hidden">
                  <table className="w-full">
                    <thead>
                      <tr className="border-b border-gray-100">
                        <th className="text-left px-4 py-3 text-[11px] font-semibold text-gray-400 uppercase tracking-wider">Datum</th>
                        <th className="text-left px-4 py-3 text-[11px] font-semibold text-gray-400 uppercase tracking-wider">Popis</th>
                        <th className="text-right px-4 py-3 text-[11px] font-semibold text-gray-400 uppercase tracking-wider">Částka</th>
                        <th className="text-left px-4 py-3 text-[11px] font-semibold text-gray-400 uppercase tracking-wider">VS</th>
                        {tab === 'sparovane' && <th className="text-left px-4 py-3 text-[11px] font-semibold text-gray-400 uppercase tracking-wider">Faktura</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {tList.map((t, i) => {
                        const pairedF = t.faktura_id ? faktury.find(f => f.id === t.faktura_id) : null
                        return (
                          <tr key={t.id} className={`${i < tList.length - 1 ? 'border-b border-gray-50' : ''} hover:bg-[#f9f9f9] transition-colors`}>
                            <td className="px-4 py-3 text-[13px] text-gray-600 whitespace-nowrap">{fmtDate(t.datum)}</td>
                            <td className="px-4 py-3 max-w-[300px]">
                              <div className="text-[13px] text-gray-800 line-clamp-1">{t.zprava || '—'}</div>
                              {t.protiucet && <div className="text-[11px] text-gray-400 font-mono">{t.protiucet}</div>}
                            </td>
                            <td className={`px-4 py-3 text-right text-[13px] font-semibold tabular-nums ${t.castka < 0 ? 'text-red-600' : 'text-green-700'}`}>
                              {fmt(t.castka, t.mena)}
                            </td>
                            <td className="px-4 py-3 text-[12px] text-gray-500 font-mono">{t.variabilni_symbol || '—'}</td>
                            {tab === 'sparovane' && (
                              <td className="px-4 py-3 text-[12px] text-gray-500">{pairedF ? pairedF.dodavatel : '—'}</td>
                            )}
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )
            })()}
          </>
        )}

      </main>
    </div>
  )
}
