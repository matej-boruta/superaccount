'use client'

import React, { Fragment, useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'

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
  stav_workflow?: string | null
  blocker?: string | null
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
  const validCurrency = /^[A-Z]{3}$/.test((mena || '').trim()) ? mena.trim() : 'CZK'
  return new Intl.NumberFormat('cs-CZ', { style: 'currency', currency: validCurrency, maximumFractionDigits: 0 }).format(n)
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

type Tab = 'nova' | 'schvalena' | 'zaplacena' | 'zamitnuta' | 'vse' | 'sparovane' | 'nesparovane' | 'vydane' | 'vykazy' | 'abra'

type Pravidlo = {
  id: number
  dodavatel_pattern: string
  ico: string | null
  typ_platby: string | null
  auto_schvalit: boolean
  auto_parovat: boolean
  poznamka: string | null
  kategorie_id: number | null
}

type FakturaVydana = {
  id: number
  cislo_faktury: string
  odberatel: string
  castka_bez_dph: number
  dph: number
  castka_s_dph: number
  mena: string
  datum_vystaveni: string
  datum_splatnosti: string | null
  variabilni_symbol: string | null
  stav: string
  popis: string | null
  transakce_id: number | null
}
type TFilter = 'vse' | 'nesparovano' | 'sparovano'

const TABS = [
  { key: 'nova' as Tab, label: 'Ke schválení' },
  { key: 'schvalena' as Tab, label: 'Čekající platby' },
  { key: 'zaplacena' as Tab, label: 'Zaplacené' },
  { key: 'zamitnuta' as Tab, label: 'Zamítnuté' },
  { key: 'sparovane' as Tab, label: 'Spárované' },
  { key: 'nesparovane' as Tab, label: 'Nespárované' },
  { key: 'vydane' as Tab, label: 'Vydané faktury' },
  { key: 'vykazy' as Tab, label: 'Výkazy' },
  { key: 'abra' as Tab, label: 'ABRA check' },
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

// Klíčová slova známých dodavatelů pro detekci konfliktů v popisu kart. transakcí
const KNOWN_SUPPLIER_KEYWORDS: Record<string, string[]> = {
  'google': ['google ads', 'google *ads', 'google cloud', 'google workspace', 'google ireland'],
  'seznam': ['seznam', 'sklik'],
  'facebook': ['facebook', 'meta '],
  'twilio': ['twilio'],
  'daktela': ['daktela'],
  'ipex': ['ipex'],
  'freepik': ['freepik'],
}

function scoreCandidate(faktura: Faktura, t: Transakce): MatchCandidate {
  let score = 0
  const reasons: string[] = []
  const amtDiff = Math.abs(Math.abs(t.castka) - faktura.castka_s_dph) / (faktura.castka_s_dph || 1)
  const vsMatch = !!(faktura.variabilni_symbol && t.variabilni_symbol === faktura.variabilni_symbol)
  const zprava = (t.zprava ?? '').toLowerCase()
  const dodavatelLower = (faktura.dodavatel ?? '').toLowerCase()
  const nameInZprava = !!(faktura.dodavatel && zprava.includes(dodavatelLower.split(' ')[0]))
  const daysDiff = faktura.datum_splatnosti && t.datum
    ? Math.abs((new Date(t.datum).getTime() - new Date(faktura.datum_splatnosti).getTime()) / 86400000)
    : 999

  // Negativní signál: zpráva kart. transakce obsahuje jiného dodavatele
  if (t.typ === 'karta' || (!t.protiucet && t.zprava?.startsWith('Nákup'))) {
    for (const [key, keywords] of Object.entries(KNOWN_SUPPLIER_KEYWORDS)) {
      const zpravaMatchesOther = keywords.some(kw => zprava.includes(kw))
      const fakturaBelongsToThis = dodavatelLower.includes(key) || key === 'google' && dodavatelLower.includes('ireland')
      if (zpravaMatchesOther && !fakturaBelongsToThis) {
        // Zpráva jednoznačně ukazuje na jiného dodavatele → diskvalifikovat
        return { t, score: -100, reasons: [`zpráva=${t.zprava?.slice(0, 20)} ≠ dodavatel`] }
      }
    }
    // Pro kartové transakce: bez VS shody vyžadujeme alespoň shodu jména v zprávě
    if (!vsMatch && !nameInZprava) {
      return { t, score: 0, reasons: ['karta bez VS/název'] }
    }
  }

  if (vsMatch) { score += 50; reasons.push('VS ✓') }
  if (amtDiff < 0.01) { score += 40; reasons.push('částka ✓') }
  else if (amtDiff < 0.05) { score += 25; reasons.push('částka ≈') }
  else if (amtDiff < 0.15) { score += 10; reasons.push('částka ~') }
  if (nameInZprava) { score += 15; reasons.push('název ✓') }
  if (daysDiff <= 1) { score += 30; reasons.push('datum D+1 ✓') }
  else if (daysDiff <= 2) { score += 22; reasons.push('datum D+2 ✓') }
  else if (daysDiff <= 3) { score += 15; reasons.push('datum D+3') }
  else if (daysDiff <= 7) { score += 5; reasons.push('datum ~7d') }
  else if (daysDiff <= 30) { score += 2; reasons.push('datum ~') }

  return { t, score, reasons }
}

function findTopMatches(faktura: Faktura, transakce: Transakce[], n = 3): MatchCandidate[] {
  const nespar = transakce.filter(t => t.stav === 'nesparovano' && t.castka < 0)
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

type VysledovkaRow = { ucetni_kod: string; l1: string; l2: string; stredisko: string; mesice: Record<number, number> }
type VysledovkaData = {
  year: number
  months: number[]
  naklady: VysledovkaRow[]
  nakladyTotal: Record<number, number>
  vynosy: Record<number, number>  // month → amount
  poznamka?: string
}

const MESICE = ['', 'Led', 'Úno', 'Bře', 'Dub', 'Kvě', 'Čvn', 'Čvc', 'Srp', 'Zář', 'Říj', 'Lis', 'Pro']

function VykazVysledovka({ rok }: { rok: number }) {
  const [open, setOpen] = React.useState(false)
  const [loading, setLoading] = React.useState(false)
  const [data, setData] = React.useState<VysledovkaData | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => { setData(null) }, [rok])

  const load = async () => {
    if (data) return  // already loaded
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/vykazy/vysledovka?rok=${rok}`)
      const d = await res.json()
      if (d.error) setError(d.error)
      else setData(d)
    } catch (e) {
      setError(String(e))
    }
    setLoading(false)
  }

  const fmt = (v: number) =>
    v === 0 ? '—' : new Intl.NumberFormat('cs-CZ', { maximumFractionDigits: 0 }).format(Math.round(v))

  const rowTotal = (mesice: Record<number, number>, months: number[]) =>
    months.reduce((s, m) => s + (mesice[m] ?? 0), 0)

  return (
    <div className="space-y-4">
      <details
        className="bg-white rounded-2xl shadow-sm border border-black/[0.06] overflow-clip"
        onToggle={(e) => { if ((e.target as HTMLDetailsElement).open) { setOpen(true); load() } else setOpen(false) }}
      >
        <summary className="px-5 py-4 cursor-pointer text-[14px] font-semibold text-gray-800 select-none hover:bg-gray-50 flex items-center justify-between">
          <span>Analytická výsledovka</span>
          {data && <span className="text-[12px] font-normal text-gray-400">{data.year} · {data.months.length} měsíců</span>}
        </summary>

        <div className="px-0 pb-4">
          {loading && <div className="text-center py-8 text-[13px] text-gray-400">Načítám z ABRA…</div>}
          {error && <div className="text-center py-8 text-[13px] text-red-500">{error}</div>}
          {data && !loading && (() => {
            const months = data.months
            const colW = 'w-[90px] min-w-[90px]'
            return (
              <div className="overflow-x-auto">
                <table className="w-full text-[12px]">
                  <thead>
                    <tr className="border-b border-gray-100 bg-gray-50">
                      <th className="px-5 py-2 text-left text-[11px] font-semibold text-gray-400 uppercase tracking-wide sticky left-0 bg-gray-50">Účet</th>
                      {months.map(m => (
                        <th key={m} className={`px-3 py-2 text-right text-[11px] font-semibold text-gray-400 uppercase tracking-wide ${colW}`}>
                          {MESICE[m]}
                        </th>
                      ))}
                      <th className={`px-3 py-2 text-right text-[11px] font-semibold text-gray-500 uppercase tracking-wide ${colW}`}>Celkem</th>
                    </tr>
                  </thead>
                  <tbody>
                    {/* NÁKLADY */}
                    <tr className="bg-red-50/60">
                      <td colSpan={months.length + 2} className="px-5 py-1.5 text-[11px] font-semibold text-red-700 uppercase tracking-wider">Náklady</td>
                    </tr>
                    {data.naklady.map(r => (
                      <tr key={r.ucetni_kod} className="border-b border-gray-50 hover:bg-gray-50/50">
                        <td className="px-5 py-2 sticky left-0 bg-white">
                          <span className="font-mono text-[11px] text-gray-400 mr-2">{r.ucetni_kod}</span>
                          <span className="text-gray-700">{r.l1}{r.l2 ? ` / ${r.l2}` : ''}</span>
                        </td>
                        {months.map(m => (
                          <td key={m} className={`px-3 py-2 text-right text-gray-700 tabular-nums ${colW} ${r.mesice[m] ? '' : 'text-gray-300'}`}>
                            {fmt(r.mesice[m] ?? 0)}
                          </td>
                        ))}
                        <td className={`px-3 py-2 text-right font-semibold text-gray-800 tabular-nums ${colW}`}>
                          {fmt(rowTotal(r.mesice, months))}
                        </td>
                      </tr>
                    ))}
                    <tr className="bg-red-50 border-t-2 border-red-200">
                      <td className="px-5 py-2 font-semibold text-red-700 sticky left-0 bg-red-50">Náklady celkem</td>
                      {months.map(m => (
                        <td key={m} className={`px-3 py-2 text-right font-semibold text-red-700 tabular-nums ${colW}`}>
                          {fmt(data.nakladyTotal[m] ?? 0)}
                        </td>
                      ))}
                      <td className={`px-3 py-2 text-right font-bold text-red-800 tabular-nums ${colW}`}>
                        {fmt(rowTotal(data.nakladyTotal, months))}
                      </td>
                    </tr>

                    {/* VÝNOSY */}
                    {Object.keys(data.vynosy).length > 0 && (<>
                      <tr className="bg-green-50/60">
                        <td colSpan={months.length + 2} className="px-5 py-1.5 text-[11px] font-semibold text-green-700 uppercase tracking-wider">Výnosy</td>
                      </tr>
                      <tr className="bg-green-50 border-t-2 border-green-200">
                        <td className="px-5 py-2 font-semibold text-green-700 sticky left-0 bg-green-50">Výnosy celkem</td>
                        {months.map(m => (
                          <td key={m} className={`px-3 py-2 text-right font-semibold text-green-700 tabular-nums ${colW}`}>
                            {fmt(data.vynosy[m] ?? 0)}
                          </td>
                        ))}
                        <td className={`px-3 py-2 text-right font-bold text-green-800 tabular-nums ${colW}`}>
                          {fmt(months.reduce((s, m) => s + (data.vynosy[m] ?? 0), 0))}
                        </td>
                      </tr>
                    </>)}

                    {/* VÝSLEDEK */}
                    <tr className="border-t-2 border-gray-300 bg-gray-100">
                      <td className="px-5 py-3 font-bold text-gray-900 sticky left-0 bg-gray-100">Náklady celkem (HV)</td>
                      {months.map(m => {
                        const val = (data.vynosy[m] ?? 0) - (data.nakladyTotal[m] ?? 0)
                        return (
                          <td key={m} className={`px-3 py-3 text-right font-bold tabular-nums ${colW} ${val >= 0 ? 'text-green-700' : 'text-red-700'}`}>
                            {fmt(val)}
                          </td>
                        )
                      })}
                      {(() => {
                        const totalVynosy = months.reduce((s, m) => s + (data.vynosy[m] ?? 0), 0)
                        const total = totalVynosy - rowTotal(data.nakladyTotal, months)
                        return (
                          <td className={`px-3 py-3 text-right font-bold tabular-nums ${colW} ${total >= 0 ? 'text-green-700' : 'text-red-700'}`}>
                            {fmt(total)}
                          </td>
                        )
                      })()}
                    </tr>
                  </tbody>
                </table>
              </div>
            )
          })()}
        </div>
      </details>
    </div>
  )
}

export default function Home() {
  const router = useRouter()
  const currentYear = new Date().getFullYear()
  const AVAILABLE_YEARS = [currentYear - 1, currentYear] // 2025, 2026 — rozšiř dle potřeby
  const [selectedYear, setSelectedYear] = useState<number>(currentYear)
  useEffect(() => {
    const p = new URLSearchParams(window.location.search).get('rok')
    if (p && parseInt(p) !== currentYear) setSelectedYear(parseInt(p))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const [faktury, setFaktury] = useState<Faktura[]>([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<Tab>('nova')
  const [onlyProblematic, setOnlyProblematic] = useState(false)
  const [processing, setProcessing] = useState(false)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [kategorieList, setKategorieList] = useState<Kategorie[]>([])
  // Map<fakturaId, selectedKategorieId> — for overriding category before approval
  const [kategorieOverride, setKategorieOverride] = useState<Map<number, number>>(new Map())
  const [classifying, setClassifying] = useState(false)
  type PairedSummaryItem = { dodavatel: string; count: number; castka: number }
  const [pairedBanner, setPairedBanner] = useState<PairedSummaryItem[] | null>(null)
  const [pairedBannerExpanded, setPairedBannerExpanded] = useState(false)

  const [transakce, setTransakce] = useState<Transakce[]>([])
  const [transakceLoading, setTransakceLoading] = useState(false)
  const [tFilter, setTFilter] = useState<TFilter>('vse')
  const [dodavatelSearch, setDodavatelSearch] = useState('')
  const [transakceSearch, setTransakceSearch] = useState('')
  const [activePicker, setActivePicker] = useState<number | null>(null)
  const [skipped, setSkipped] = useState<Set<number>>(new Set())
  const [rejectedSuggestions, setRejectedSuggestions] = useState<Set<number>>(new Set())
  const [transakceDir, setTransakceDir] = useState<'vse' | 'prijate' | 'odeslane'>('vse')
  // Map<fakturaId, transakceId> — checked pairs in párování
  const [selectedPairs, setSelectedPairs] = useState<Map<number, number>>(new Map())

  const load = useCallback(async (year?: number) => {
    const rok = year ?? selectedYear
    setLoading(true)
    const res = await fetch(`/api/faktury?rok=${rok}`)
    const json = res.ok ? await res.json().catch(() => []) : []
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
          const r = await fetch(`/api/faktury?rok=${rok}`)
          const updated = await r.json()
          if (Array.isArray(updated)) setFaktury(updated)
        }
        setClassifying(false)
      }
      run().catch(() => setClassifying(false))
    }
  }, [selectedYear])

  useEffect(() => {
    fetch('/api/kategorie').then(r => r.json()).then(setKategorieList).catch(() => {})
  }, [])

  const loadTransakce = useCallback(async (currentFaktury?: Faktura[], year?: number) => {
    const rok = year ?? selectedYear
    setTransakceLoading(true)
    const res = await fetch(`/api/transakce?rok=${rok}`)
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
      const match = nespar.find(t => {
        if (usedTransakceIds.has(t.id)) return false
        if (t.variabilni_symbol !== f.variabilni_symbol) return false
        if (Math.abs(Math.abs(t.castka) - f.castka_s_dph) / f.castka_s_dph >= 0.05) return false
        // Kartové transakce: ověř že zpráva neobsahuje jiného dodavatele
        const isKarta = t.typ === 'karta' || (!t.protiucet && (t.zprava ?? '').startsWith('Nákup'))
        if (isKarta) {
          const c = scoreCandidate(f, t)
          if (c.score <= 0) return false
        }
        return true
      })
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
      const res2 = await fetch(`/api/transakce?rok=${rok}`)
      setTransakce(await res2.json())
    }
  }, [selectedYear])

  // Reload when year changes
  useEffect(() => {
    load(selectedYear)
    loadTransakce(undefined, selectedYear)
    setVydane([])
    setChybejici(null)
    // Update URL param
    const params = new URLSearchParams(window.location.search)
    params.set('rok', String(selectedYear))
    router.replace(`?${params.toString()}`, { scroll: false })
  }, [selectedYear])

  useEffect(() => {
    // Background ABRA sync — fire and forget, catches any gaps from previous sessions
    if (selectedYear === currentYear) fetch('/api/abra-sync', { method: 'POST' }).catch(() => {})
    // Auto-parovani on mount — pair any matched invoices, then load today's summary
    fetch('/api/auto-parovani', { method: 'POST' })
      .then(() => { load(); loadTransakce() })
      .catch(() => {})

    // Banner: always load today's auto-paired faktury from Supabase (persists across sessions)
    fetch('/api/dnes-sparovano')
      .then(r => r.json())
      .then((summary: { dodavatel: string; count: number; castka: number }[]) => {
        if (summary.length > 0) setPairedBanner(summary)
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (tab === 'schvalena' || tab === 'sparovane' || tab === 'nesparovane') loadTransakce(faktury, selectedYear)
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
    // Background ABRA sync after pairing — catches any failures in sparovat's inline ABRA call
    fetch('/api/abra-sync', { method: 'POST' }).catch(() => {})
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
  const [chybejici, setChybejici] = useState<{
    dodavatel: string
    chybi_mesic: number
    chybi_mesic_nazev: string
    nesparovana_count: number
    nesparovana_castka: number
    nesparovana_mena: string
  }[] | null>(null)
  const filtered = (() => {
    let base = tab === 'vse' ? faktury : isTransakceTab ? [] : faktury.filter(f => f.stav === tab)
    if (tab === 'nova' && onlyProblematic) {
      base = base.filter(f => !f.kategorie_id || f.stav_workflow === 'NEEDS_INFO')
    }
    if (dodavatelSearch.trim()) {
      const q = dodavatelSearch.trim().toLowerCase()
      return base.filter(f => {
        const kat = kategorieList.find(k => k.id === (kategorieOverride.get(f.id) ?? f.kategorie_id))
        const katStr = kat ? `${kat.l1} ${kat.l2}`.toLowerCase() : ''
        const castkaStr = String(f.castka_s_dph)
        return (
          (f.dodavatel || '').toLowerCase().includes(q) ||
          (f.cislo_faktury || '').toLowerCase().includes(q) ||
          (f.variabilni_symbol || '').toLowerCase().includes(q) ||
          katStr.includes(q) ||
          castkaStr.includes(q) ||
          (f.popis || '').toLowerCase().includes(q)
        )
      })
    }
    return base
  })()

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
  const todayStr = new Date().toDateString()
  const overdueSchvalena = schvalenaFaktury.filter(f =>
    f.datum_splatnosti && new Date(f.datum_splatnosti) < new Date(todayStr)
  ).length

  // ===== MANAŽERSKÉ METRIKY =====
  const todayMs = new Date().setHours(0, 0, 0, 0)
  const poSplatnostiFaktury = faktury.filter(f =>
    (f.stav === 'nova' || f.stav === 'schvalena') &&
    f.datum_splatnosti && new Date(f.datum_splatnosti).setHours(0,0,0,0) < todayMs
  )
  const poSplatnostiCelkem = poSplatnostiFaktury.reduce((s, f) => s + Number(f.castka_s_dph), 0)
  const zavazkyFaktury = faktury.filter(f => f.stav === 'nova' || f.stav === 'schvalena')
  const zavazkySum = zavazkyFaktury.reduce((s, f) => s + Number(f.castka_s_dph), 0)
  const nesparovaneSum = transakce.filter(t => t.stav === 'nesparovano').reduce((s, t) => s + Math.abs(Number(t.castka)), 0)
  const zaplacenaSum = faktury.filter(f => f.stav === 'zaplacena').reduce((s, f) => s + Number(f.castka_s_dph), 0)

  // ===== PÁROVÁNÍ =====
  const pairedFakturaIds = new Set(transakce.filter(t => t.faktura_id !== null).map(t => t.faktura_id!))
  const schvalenaUnpaired = faktury.filter(f => f.stav === 'schvalena' && !skipped.has(f.id))
  const nesparTransakce = transakce.filter(t => t.stav === 'nesparovano')

  // Sekvenční matching — každá transakce použita max jednou, faktury seřazeny dle data
  const sequentialSuggestions = (() => {
    const usedTransIds = new Set<number>()
    const sorted = [...schvalenaUnpaired].sort((a, b) =>
      new Date(a.datum_vystaveni).getTime() - new Date(b.datum_vystaveni).getTime()
    )
    const result = new Map<number, Transakce>()
    for (const f of sorted) {
      const available = transakce.filter(t => t.stav === 'nesparovano' && t.castka < 0 && !usedTransIds.has(t.id))
      const match = findMatch(f, available)
      if (match) { result.set(f.id, match); usedTransIds.add(match.id) }
    }
    return result
  })()

  const withSuggestions = schvalenaUnpaired.filter(f => sequentialSuggestions.has(f.id))
  const allPairsChecked = withSuggestions.length > 0 && withSuggestions.every(f => selectedPairs.has(f.id))
  const somePairsChecked = withSuggestions.some(f => selectedPairs.has(f.id))
  const toggleAllPairs = () => {
    if (allPairsChecked) { setSelectedPairs(new Map()); return }
    const next = new Map<number, number>()
    const usedT = new Set<number>()
    withSuggestions.forEach(f => {
      const s = sequentialSuggestions.get(f.id)
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

  const [pravidla, setPravidla] = useState<Pravidlo[]>([])
  useEffect(() => {
    fetch('/api/pravidla').then(r => r.json()).then(d => Array.isArray(d) && setPravidla(d)).catch(() => {})
  }, [])

  const [vydane, setVydane] = useState<FakturaVydana[]>([])
  const [vydaneLoading, setVydaneLoading] = useState(false)
  const [csvImporting, setCsvImporting] = useState(false)
  const [csvResult, setCsvResult] = useState<string | null>(null)

  // ABRA reconcile
  const [abraLoading, setAbraLoading] = useState(false)
  const [abraFixing, setAbraFixing] = useState<string | null>(null)
  const [abraFixResult, setAbraFixResult] = useState<string | null>(null)
  const [abraResult, setAbraResult] = useState<{
    stats: { sbTotal: number; abraTotal: number; matched: number; diffWithTransakce: number; diffWithoutTransakce: number; sbSparovaneTotal: number; abraBankaTotal: number }
    onlySB: Array<{ id: number; dodavatel: string; cislo_faktury: string; castka_s_dph: number; mena: string; stav: string }>
    onlyABRA: Array<{ id: string; kod: string; stavUhrady: string; sumCelkem: number; firma: string }>
    diff: Array<{ sb: { id: number; dodavatel: string; cislo_faktury: string; castka_s_dph: number; mena: string; stav: string }; abra: { kod: string; stavUhrady: string; id: string }; abraStav: string; transakce: { id: number; datum: string; castka: number; mena: string } | null }>
    banka?: { sbBezBanky: Array<{ sbId: number; dodavatel: string; castka: number; mena: string; datum: string }>; abraBankaBezSB: Array<{ id: string; popis: string; sumOsv: number; datVyst: string }> }
  } | null>(null)

  const [historickyImport, setHistorickyImport] = useState<null | { status: string }>(null)

  // ── PM Agent state ──────────────────────────────────────────────────────────
  const [agentRunning, setAgentRunning] = useState(false)
  const [agentLog, setAgentLog] = useState<{ type: 'action' | 'info' | 'warn'; text: string }[]>([])
  const [agentSummary, setAgentSummary] = useState<string | null>(null)
  // Orchestrator — spuštění konkrétního tasku
  const [orchRunning, setOrchRunning] = useState<string | null>(null) // key = action string
  const [orchResults, setOrchResults] = useState<Record<string, { ok: boolean; summary: string }>>({})

  // Strategic Orchestrator
  const [stratOrchRunning, setStratOrchRunning] = useState(false)
  const [stratOrchData, setStratOrchData] = useState<{
    year: number; dry_run: boolean; state: Record<string, unknown>
    goals: Array<{ id: string; label: string; target: string; current: unknown; ok: boolean; urgency: string; action: string | null; owner: string }>
    plan: Array<{ order: number; owner: string; task: string; urgency: string; why: string }>
    execution: Array<{ step: number; owner: string; task: string; result: string; ok: boolean }>
    system_health_pct: number; strategic_insight: string | null; summary: string; generated_at: string
  } | null>(null)
  const [agentQuestion, setAgentQuestion] = useState<{
    otazka: string; kontext: string; moznosti: string[]
    tool_use_id: string; messages: unknown[]
  } | null>(null)
  const [agentAnswer, setAgentAnswer] = useState('')
  const [needsInfoCount, setNeedsInfoCount] = useState(0)
  const [caseMeta, setCaseMeta] = useState<Record<number, { confidence: number; source_of_rule: string; rezim: string }>>({})

  // ── Control Tower state ────────────────────────────────────────────────────
  const [ctOpen, setCtOpen] = useState(false)
  const [ctLoading, setCtLoading] = useState(false)
  const [ctLoadingStep, setCtLoadingStep] = useState('')
  const [ctData, setCtData] = useState<{
    snapshot: Record<string, unknown>
    analysis: {
      system_health: { overall_score: number; accounting_quality: number; audit_quality: number; workflow_quality: number; data_quality: number; architecture_quality: number; learning_quality: number; summary: string }
      kpi_by_agent: Array<{ agent_name: string; strongest_area: string; weakest_area: string; risk_level: string; performance_summary: string }>
      critical_issues: Array<{ severity: string; type: string; owner_agent: string; title: string; symptom: string; root_cause: string; impact: string; recommended_fix: string }>
      patterns: Array<{ description: string; trend: string }>
      quick_wins: Array<{ action: string; effort: string; impact: string }>
      strategic_improvements: Array<{ title: string; description: string; priority: string }>
      orchestrator_tasking: {
        action_list: Array<{ action: string; priority: string; owner_agent: string; type: string; description: string; expected_impact: string }>
        system_decisions: { database: string[]; rules: string[]; prompts: string[]; workflow: string[] }
        agent_task_assignments: { accountant: string[]; auditor: string[]; pm: string[]; architect: string[] }
        learning_actions: string[]
        top3_priorities: string[]
      }
    } | null
    agent_errors: Array<{ id: number; typ: string; rezim: string; feedback_type: string | null; faktura_id: number | null; popis: string; korekce_popis: string | null; created_at: string }>
    agent_trend: Record<string, Array<{ week: string; avg_confidence: number; decisions: number; acc_errors: number; auditor_false_neg: number; fixed: number; error_rate_pct: number }>>
    agent_kpi: Record<string, { total_decisions: number; acc_errors: number; auditor_false_neg: number; fixed: number; error_rate_pct: number; fix_rate_pct: number }>
    generated_at: string
  } | null>(null)
  const [ctTab, setCtTab] = useState<'dashboard' | 'tasking' | 'agent' | 'abra'>('dashboard')

  // Orchestrator — routuje task ke správnému agentovi přes dispatcher
  const runOrchestratorTask = async (actionKey: string, taskDescription: string, actionType: string, ownerAgent = 'pm') => {
    if (orchRunning) return
    setOrchRunning(actionKey)
    try {
      const res = await fetch('/api/agent/dispatch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          owner_agent: ownerAgent,
          task: taskDescription,
          type: actionType,
          year: selectedYear,
        }),
      })
      const data = await res.json()
      const verif = data.verification
      const verdict = verif?.verdict ?? data.summary ?? 'Hotovo'
      const summary = verif
        ? `${verdict} | before: bez_kat ${verif.before.faktury_bez_kategorie}→${verif.after.faktury_bez_kategorie}, needs_info ${verif.before.needs_info}→${verif.after.needs_info}`
        : verdict
      setOrchResults(prev => ({ ...prev, [actionKey]: { ok: data.ok !== false, summary } }))
      if (data.log) setAgentLog(data.log)
    } catch (e) {
      setOrchResults(prev => ({ ...prev, [actionKey]: { ok: false, summary: String(e) } }))
    }
    setOrchRunning(null)
  }

  const runStrategicOrchestrator = async (dryRun = false) => {
    if (stratOrchRunning) return
    setStratOrchRunning(true)
    try {
      const res = await fetch('/api/agent/strategic-orchestrator', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ year: selectedYear, dry_run: dryRun }),
      })
      const data = await res.json()
      setStratOrchData(data)
    } catch { /* silent */ }
    setStratOrchRunning(false)
  }

  const loadControlTower = async () => {
    setCtLoading(true)
    setCtLoadingStep('Načítám data z Supabase…')
    try {
      setCtLoadingStep('Spouštím Claude Haiku analýzu…')
      const res = await fetch(`/api/agent/control-tower?rok=${selectedYear}`)
      setCtLoadingStep('Zpracovávám výsledky…')
      const data = await res.json()
      setCtData(data)
    } catch { /* silent */ }
    setCtLoading(false)
    setCtLoadingStep('')
  }

  useEffect(() => {
    const fetchStatus = () =>
      fetch('/api/agent/status').then(r => r.json()).then(d => setNeedsInfoCount(d.needs_info_count ?? 0)).catch(() => {})
    fetchStatus()
    const interval = setInterval(fetchStatus, 60_000)
    return () => clearInterval(interval)
  }, [])

  useEffect(() => {
    if (tab === 'nova') {
      fetch(`/api/agent/case-meta?rok=${selectedYear}`).then(r => r.json()).then(d => setCaseMeta(d ?? {})).catch(() => {})
    }
  }, [tab, selectedYear])
  const [auditFullLoading, setAuditFullLoading] = useState(false)
  const [auditFullResult, setAuditFullResult] = useState<{
    data: {
      sb: { nova: number; schvalena: number; zaplacena: number; zamitnuta: number; faktury_v_abra: number; sparovane_transakce: number }
      abra: { faktury_fp: number; banka_celkem: number }
      shoda: { faktury_ok: boolean; faktury_diff: number; banka_ok: boolean; banka_diff: number }
      rozdily: {
        chybejici_v_abra: Array<{ id: number; dodavatel: string; stav: string; castka: number; ocekavany_kod: string }>
        osirelé_v_abra: string[]
      }
    }
    audit: { ok: boolean; rozdily: Array<{ typ: string; popis: string; oprava: string }>; souhrn: string } | null
  } | null>(null)

  const nacistHistorickaData = async (year: number) => {
    setHistorickyImport({ status: 'Načítám faktury z Drive…' })
    try {
      const driveRes = await fetch('/api/google/sync-drive-faktury', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folder_id: year === 2025 ? '1s5YxkO9ILZzvF4_nAnO26ucsF_GcnAAo' : '1vCbrmWcLhDR54KVL0EHYaDLg2Qr2RCsM' }),
      })
      const driveData = await driveRes.json()
      setHistorickyImport({ status: `Faktury: ${driveData.imported ?? 0} nových. Načítám platby z Fio…` })

      const fioRes = await fetch('/api/fio-import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dateFrom: `${year}-01-01`, dateTo: `${year}-12-31` }),
      })
      const fioData = await fioRes.json()
      setHistorickyImport({ status: `Hotovo: ${driveData.imported ?? 0} faktur, ${fioData.totalSaved ?? 0} transakcí načteno.` })
      load(year)
      loadTransakce(undefined, year)
    } catch (e) {
      setHistorickyImport({ status: `Chyba: ${String(e)}` })
    }
  }

  const runAgent = async (messages?: unknown[], toolUseId?: string, answer?: string) => {
    setAgentRunning(true)
    setAgentQuestion(null)
    if (!messages) { setAgentLog([]); setAgentSummary(null) }
    try {
      const body: Record<string, unknown> = { year: selectedYear }
      if (messages) body.messages = messages
      if (toolUseId) body.tool_use_id = toolUseId
      if (answer !== undefined) body.answer = answer

      const res = await fetch('/api/agent/pm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()

      setAgentLog(prev => [...prev, ...(data.log ?? [])])

      if (data.type === 'question') {
        setAgentQuestion({
          otazka: data.otazka,
          kontext: data.kontext,
          moznosti: data.moznosti ?? [],
          tool_use_id: data.tool_use_id,
          messages: data.messages,
        })
      } else {
        setAgentSummary(data.summary)
        load(selectedYear)
        loadTransakce(undefined, selectedYear)
      }
      // Refresh NEEDS_INFO badge po doběhnutí agenta
      fetch('/api/agent/status').then(r => r.json()).then(d => setNeedsInfoCount(d.needs_info_count ?? 0)).catch(() => {})
    } catch (e) {
      setAgentLog(prev => [...prev, { type: 'warn', text: `Chyba: ${String(e)}` }])
    }
    setAgentRunning(false)
  }

  const loadAuditFull = async () => {
    setAuditFullLoading(true)
    try {
      const res = await fetch('/api/agent/audit-full')
      const data = await res.json()
      setAuditFullResult(data)
    } catch {
      setAuditFullResult(null)
    }
    setAuditFullLoading(false)
  }

  const loadAbraReconcile = async () => {
    setAbraLoading(true)
    try {
      const res = await fetch('/api/abra-reconcile')
      const data = await res.json()
      setAbraResult(data)
    } catch {
      setAbraResult(null)
    }
    setAbraLoading(false)
  }

  const abraFix = async (action: string, extraBody?: Record<string, unknown>) => {
    setAbraFixing(action)
    setAbraFixResult(null)
    const res = await fetch('/api/abra-fix', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, ...extraBody }),
    })
    const data = await res.json()
    if (data.errors?.length) setAbraFixResult(`Chyby (${data.errors.length}): ${data.errors.slice(0, 3).join(', ')}`)
    else if (data.created !== undefined) setAbraFixResult(`Zaúčtováno: ${data.created}, přeskočeno: ${data.skipped ?? 0}`)
    else if (data.fixed !== undefined) setAbraFixResult(`Opraveno: ${data.fixed}`)
    setAbraFixing(null)
    await loadAbraReconcile()
  }

  const loadVydane = async (year?: number) => {
    setVydaneLoading(true)
    const rok = year ?? selectedYear
    const res = await fetch(`/api/vydane?rok=${rok}`)
    const data = await res.json()
    if (Array.isArray(data)) setVydane(data)
    setVydaneLoading(false)
  }

  useEffect(() => {
    if (tab === 'vydane') loadVydane()
    if (tab === 'abra') loadAbraReconcile()
    if (tab === 'nova') {
      setChybejici(null)
      fetch(`/api/chybejici-faktury?rok=${selectedYear}`).then(r => r.json()).then(d => Array.isArray(d) && setChybejici(d)).catch(() => {})
    }
  }, [tab, selectedYear])

  const handleCsvImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setCsvImporting(true)
    setCsvResult(null)
    const text = await file.text()
    const res = await fetch('/api/vydane/import', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: text,
    })
    const data = await res.json()
    setCsvResult(data.error ?? `Nahráno ${data.imported ?? 0} faktur, přeskočeno ${data.skipped ?? 0}`)
    setCsvImporting(false)
    await loadVydane()
    e.target.value = ''
  }

  // Všichni dodavatelé: pravidla (deduplikovaná) + dodavatelé z faktur bez pravidla
  const allSuppliers: (Pravidlo & { _synthetic?: boolean })[] = (() => {
    const seenPatterns = new Set<string>()
    const result: (Pravidlo & { _synthetic?: boolean })[] = []
    for (const p of pravidla) {
      const key = p.dodavatel_pattern.toUpperCase()
      if (!seenPatterns.has(key)) { seenPatterns.add(key); result.push(p) }
    }
    // Přidej dodavatele z faktur, kteří nemají pravidlo
    const uniqueDodavatele = [...new Set(faktury.map(f => f.dodavatel).filter(Boolean))]
    for (const d of uniqueDodavatele) {
      const hasRule = pravidla.some(p => {
        const pattern = p.dodavatel_pattern.replace(/%/g, '').toUpperCase()
        return pattern && d.toUpperCase().includes(pattern)
      })
      if (!hasRule) {
        const ico = faktury.find(f => f.dodavatel === d)?.ico ?? null
        result.push({ id: -(result.length + 1), dodavatel_pattern: d, ico, typ_platby: null, auto_schvalit: false, auto_parovat: false, poznamka: null, kategorie_id: null, _synthetic: true })
      }
    }
    return result.sort((a, b) => {
      if (!a._synthetic && b._synthetic) return -1
      if (a._synthetic && !b._synthetic) return 1
      return a.dodavatel_pattern.localeCompare(b.dodavatel_pattern, 'cs')
    })
  })()

  const togglePravidlo = async (id: number, field: 'auto_schvalit' | 'auto_parovat', val: boolean) => {
    setPravidla(prev => prev.map(p => p.id === id ? { ...p, [field]: val } : p))
    await fetch('/api/pravidla', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, [field]: val }),
    })
  }

  const renderPravidloText = (text: string | null) => {
    if (!text) return <span className="text-gray-300">—</span>
    const LABELS: Array<{label: string; re: RegExp}> = [
      { label: 'Klíčové slovo', re: /^keyword:/i },
      { label: 'Platba',        re: /\bplatba\b/i },
      { label: 'Párování',      re: /\bpárování\b|\bpárovat\b/i },
      { label: 'DPH',           re: /\bDPH\b|\breverse\b|\bosvoboz/i },
      { label: 'Perioda',       re: /\bfakturováno\b|\bměsíčně\b|\bčtvrtletně\b|\bročně\b/i },
      { label: 'Popis',         re: /./ },
    ]
    const sentences = text.split(/\.\s+/).map(s => s.replace(/\.$/, '').trim()).filter(Boolean)
    return (
      <div className="space-y-1.5">
        {sentences.map((s, i) => {
          const label = (LABELS.find(l => l.re.test(s)) ?? LABELS[LABELS.length - 1]).label
          return (
            <div key={i} className="flex gap-2 items-baseline text-[12px] leading-snug">
              <span className="font-semibold text-gray-800 shrink-0 w-[100px]">{label}</span>
              <span className="text-gray-500">{s}</span>
            </div>
          )
        })}
      </div>
    )
  }

  return (
    <div style={{ fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Display", "Helvetica Neue", sans-serif' }}
      className="min-h-screen bg-[#f5f5f7]">

      <header className="bg-white/80 backdrop-blur-xl border-b border-black/[0.08] sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-6 h-14 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-[15px] font-semibold text-gray-900 tracking-tight">SuperAccount</span>
            <div className="flex items-center rounded-lg border border-gray-200 overflow-hidden text-[12px] font-medium">
              {AVAILABLE_YEARS.map(y => (
                <button
                  key={y}
                  onClick={() => setSelectedYear(y)}
                  className={`px-3 py-1 transition-colors ${selectedYear === y ? 'bg-[#0071e3] text-white' : 'text-gray-500 hover:bg-gray-50'}`}
                >
                  {y}
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-3">
            {historickyImport && (
              <span className="text-[12px] text-gray-500 animate-pulse">{historickyImport.status}</span>
            )}
            {classifying && (
              <span className="text-[12px] text-gray-400 animate-pulse">Klasifikuji kategorie…</span>
            )}
            <button
              onClick={() => { setCtOpen(true); if (!ctData) loadControlTower() }}
              suppressHydrationWarning
              className="relative text-[12px] px-3 py-1 rounded-lg bg-[#0071e3] text-white hover:bg-[#0077ed] font-medium"
            >
              Control Tower
              {needsInfoCount > 0 && (
                <span className="absolute -top-1.5 -right-1.5 min-w-[16px] h-[16px] px-0.5 rounded-full bg-red-500 text-white text-[9px] font-bold flex items-center justify-center">
                  {needsInfoCount}
                </span>
              )}
            </button>
            <button
              onClick={() => { load(); loadTransakce() }}
              className="text-[13px] text-[#0071e3] hover:text-[#0077ed] font-medium"
            >
              Obnovit
            </button>
          </div>
        </div>
      </header>

<main className="max-w-6xl mx-auto px-6 py-8">

        {/* ── Audit výsledek ── */}
        {auditFullResult && (
          <div className={`mb-4 rounded-xl px-4 py-3 text-[13px] ${!(auditFullResult.data.shoda.faktury_ok && auditFullResult.data.shoda.banka_ok) ? 'bg-red-50 border border-red-200' : 'bg-green-50 border border-green-200'}`}>
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1">
                <span className={`font-semibold mr-2 ${!(auditFullResult.data.shoda.faktury_ok && auditFullResult.data.shoda.banka_ok) ? 'text-red-700' : 'text-green-700'}`}>
                  Audit účetnictví {!(auditFullResult.data.shoda.faktury_ok && auditFullResult.data.shoda.banka_ok) ? '— nalezeny rozdíly' : '— vše v pořádku'}
                </span>
                <span className="text-gray-500">
                  Faktury: aplikace {auditFullResult.data.sb.faktury_v_abra} (zaplacené + čekající) · ABRA {auditFullResult.data.abra.faktury_fp} FP
                  {auditFullResult.data.shoda.faktury_diff !== 0 && (
                    <span className="text-red-600 font-medium"> ({auditFullResult.data.shoda.faktury_diff > 0 ? '+' : ''}{auditFullResult.data.shoda.faktury_diff})</span>
                  )}
                  {' · '}
                  Platby: aplikace {auditFullResult.data.sb.sparovane_transakce} spárovaných · ABRA {auditFullResult.data.abra.banka_celkem} banka
                  {auditFullResult.data.shoda.banka_diff !== 0 && (
                    <span className="font-medium text-red-600"> ({auditFullResult.data.shoda.banka_diff > 0 ? '+' : ''}{auditFullResult.data.shoda.banka_diff} — SB≠ABRA, tolerance 0)</span>
                  )}
                </span>
                {auditFullResult.audit?.souhrn && (
                  <div className="mt-1 text-gray-700">{auditFullResult.audit.souhrn}</div>
                )}
                {auditFullResult.audit?.rozdily && auditFullResult.audit.rozdily.length > 0 && (
                  <div className="mt-2 space-y-1">
                    {auditFullResult.audit.rozdily.map((r, i) => (
                      <div key={i} className={`text-[12px] ${r.typ === 'KRITICKÁ' ? 'text-red-700' : 'text-orange-700'}`}>
                        <span className="font-semibold">[{r.typ}]</span> {r.popis} → {r.oprava}
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <button onClick={() => setAuditFullResult(null)} className="text-gray-400 hover:text-gray-600 text-[16px] leading-none">×</button>
            </div>
          </div>
        )}

        {/* ── Sticky tabs ── */}
        <div className="sticky top-[52px] z-10 bg-white/90 backdrop-blur-xl border-b border-black/[0.06] -mx-6 px-6 py-2 mb-5 flex items-center justify-between">
              <div className="flex gap-0.5 bg-black/[0.05] p-1 rounded-xl overflow-x-auto max-w-full">
                {TABS.map(t => {
                  const cnt = t.key === 'sparovane' ? transakce.filter(tx => tx.stav === 'sparovano').length
                    : t.key === 'nesparovane' ? transakce.filter(tx => tx.stav === 'nesparovano').length
                    : t.key === 'vydane' ? vydane.length || null
                    : t.key === 'vse' || t.key === 'vykazy' || t.key === 'abra' ? null
                    : count(t.key)
                  const showRedBadge = (t.key === 'nova' || t.key === 'nesparovane' || (t.key === 'schvalena' && overdueSchvalena > 0)) && cnt && cnt > 0
                  return (
                    <button
                      key={t.key}
                      onClick={() => { setTab(t.key); setSelected(new Set()) }}
                      className={`relative whitespace-nowrap px-3 py-1.5 rounded-[10px] text-[12px] font-medium transition-all ${
                        tab === t.key ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
                      }`}
                    >
                      {t.label}
                      {cnt !== null && (
                        showRedBadge ? (
                          <span className="ml-1.5 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-red-500 text-white text-[10px] font-bold">
                            {t.key === 'schvalena' ? overdueSchvalena : cnt}
                          </span>
                        ) : (
                          <span className="ml-1.5 text-[11px] text-gray-400">{cnt}</span>
                        )
                      )}
                    </button>
                  )
                })}
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

        {tab !== 'vykazy' && tab !== 'vydane' && tab !== 'abra' && (<>
            {/* Vyhledávání — všechny taby s fakturami */}
            {!isTransakceTab && (
              <div className="mb-4 flex items-center gap-2">
                <input
                  type="text"
                  placeholder="Hledat dodavatele, fakturu, VS, kategorii, částku, popis…"
                  value={dodavatelSearch}
                  onChange={e => setDodavatelSearch(e.target.value)}
                  className="w-80 px-3 py-2 text-[13px] rounded-xl border border-black/[0.1] bg-white outline-none focus:border-[#0071e3] placeholder:text-gray-400"
                />
                {dodavatelSearch && (
                  <button onClick={() => setDodavatelSearch('')} className="text-[12px] text-gray-400 hover:text-gray-600">Zrušit</button>
                )}
                <span className="text-[12px] text-gray-400">{filteredSorted.length} faktur</span>
              </div>
            )}

            {/* Čekající platby summary banner */}
            {tab === 'schvalena' && schvalenaFaktury.length > 0 && (
              <div className="bg-blue-50 border border-blue-100 rounded-2xl px-5 py-3.5 mb-4 flex items-center justify-between gap-3">
                <span className="text-[13px] text-blue-800">
                  <span className="font-semibold">{schvalenaFaktury.length}</span> faktur čeká na zaplacení
                  {' · '}celkem <span className="font-semibold">{fmt(schvalenaCelkem, 'CZK')}</span>
                  {nejblizsiPlatba && nejblizsiPlatba.datum_platby && (
                    <> · nejbližší platba: <span className="font-semibold">{fmtDate(nejblizsiPlatba.datum_platby)}</span></>
                  )}
                </span>
                {(() => {
                  // Checked invoices that have a suggestion
                  const checkedWithSuggestion = withSuggestions.filter(f => selectedSchvalena.has(f.id))
                  if (checkedWithSuggestion.length === 0) return null
                  return (
                    <button
                      disabled={processing}
                      onClick={async () => {
                        setProcessing(true)
                        const usedT = new Set<number>()
                        for (const f of checkedWithSuggestion) {
                          const t = sequentialSuggestions.get(f.id)
                          if (t && !usedT.has(t.id)) {
                            usedT.add(t.id)
                            await fetch('/api/sparovat', {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({ fakturaId: f.id, transakceId: t.id }),
                            })
                          }
                        }
                        fetch('/api/abra-sync', { method: 'POST' }).catch(() => {})
                        await loadTransakce()
                        setProcessing(false)
                      }}
                      className="px-4 py-1.5 text-[12px] font-medium text-white bg-[#0071e3] rounded-[8px] hover:bg-[#0077ed] disabled:opacity-40 whitespace-nowrap"
                    >
                      Spárovat navržené ({checkedWithSuggestion.length})
                    </button>
                  )
                })()}
              </div>
            )}

            {/* Auto-párování banner */}
            {tab === 'schvalena' && pairedBanner && pairedBanner.length > 0 && (() => {
              const totalCount = pairedBanner.reduce((s, i) => s + i.count, 0)
              const totalCastka = pairedBanner.reduce((s, i) => s + i.castka, 0)
              const fmt = (v: number) => new Intl.NumberFormat('cs-CZ', { style: 'currency', currency: 'CZK', maximumFractionDigits: 0 }).format(v)
              return (
                <div className="bg-[#e8f4fd] border border-[#b3d9f5] rounded-2xl px-5 py-3 mb-4">
                  <div className="flex items-center justify-between">
                    <button onClick={() => setPairedBannerExpanded(e => !e)} className="flex items-center gap-2 text-left">
                      <span className="text-[12px] font-semibold text-[#0055a5]">Automaticky spárováno dnes</span>
                      <span className="text-[12px] text-[#3a7abf]">—</span>
                      <span className="text-[12px] text-[#3a7abf]">{totalCount} {totalCount === 1 ? 'faktura' : totalCount < 5 ? 'faktury' : 'faktur'}</span>
                      <span className="text-[12px] font-semibold text-[#0055a5]">{fmt(totalCastka)}</span>
                      <span className="text-[11px] text-[#3a7abf]">{pairedBannerExpanded ? '▲' : '▼'}</span>
                    </button>
                    <button onClick={() => setPairedBanner(null)} className="text-[11px] text-[#0055a5] hover:text-[#003d7a]">✕</button>
                  </div>
                  {pairedBannerExpanded && (
                    <div className="flex flex-col gap-0.5 mt-2">
                      {pairedBanner.map(item => (
                        <div key={item.dodavatel} className="flex items-center gap-2 text-[13px] text-[#0055a5]">
                          <span className="font-medium flex-1">{item.dodavatel}</span>
                          <span className="text-[#3a7abf]">{item.count} {item.count === 1 ? 'faktura' : item.count < 5 ? 'faktury' : 'faktur'}</span>
                          <span className="font-semibold">{fmt(item.castka)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )
            })()}

            {/* Summary + filter — only for nova tab */}
            {tab === 'nova' && !loading && (() => {
              const bezKat = faktury.filter(f => f.stav === 'nova' && !f.kategorie_id).length
              const needsInfo = faktury.filter(f => f.stav === 'nova' && f.stav_workflow === 'NEEDS_INFO').length
              const hasIssues = bezKat > 0 || needsInfo > 0
              if (!hasIssues && !onlyProblematic) return null
              return (
                <div className="flex items-center justify-between gap-3 mb-4 px-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    {bezKat > 0 && (
                      <span className="inline-flex items-center gap-1 text-[11px] font-medium px-2.5 py-1 rounded-full bg-orange-50 text-orange-700 border border-orange-200">
                        <span className="font-bold">{bezKat}</span> bez kategorie
                      </span>
                    )}
                    {needsInfo > 0 && (
                      <span className="inline-flex items-center gap-1 text-[11px] font-medium px-2.5 py-1 rounded-full bg-amber-50 text-amber-700 border border-amber-200">
                        <span className="font-bold">{needsInfo}</span> čeká na info
                      </span>
                    )}
                  </div>
                  <button
                    onClick={() => setOnlyProblematic(p => !p)}
                    className={`text-[11px] font-medium px-3 py-1.5 rounded-lg transition-colors whitespace-nowrap ${
                      onlyProblematic
                        ? 'bg-[#0071e3] text-white'
                        : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                    }`}
                  >
                    {onlyProblematic ? 'Zobrazit vše' : 'Pouze k řešení'}
                  </button>
                </div>
              )
            })()}

            {!isTransakceTab && (loading ? (
              <div className="text-center py-20 text-[13px] text-gray-400">Načítám…</div>
            ) : filteredSorted.length === 0 ? (
              <div className="text-center py-20 text-[13px] text-gray-400">Žádné faktury</div>
            ) : (
              <div className="bg-white rounded-2xl shadow-sm border border-black/[0.06] overflow-clip">
                <table className="w-full">
                  <thead className="sticky top-[105px] z-10 bg-white">
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
                      <th className="text-left px-4 py-3 text-[11px] font-semibold text-gray-400 uppercase tracking-wider">Vystavení</th>
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
                      const suggestion = f.stav === 'schvalena' ? (sequentialSuggestions.get(f.id) ?? null) : null
                      const pairedT = transakce.find(t => t.faktura_id === f.id && t.stav === 'sparovano')
                      const showPicker = activePicker === f.id
                      const isSchvalena = f.stav === 'schvalena'
                      const isOverdue = isSchvalena && f.datum_splatnosti
                        ? new Date(f.datum_splatnosti) < new Date(new Date().toDateString())
                        : false
                      return (
                        <Fragment key={f.id}>
                        <tr
                          onClick={() => f.stav === 'nova' && toggle(f.id)}
                          className={`${i < filteredSorted.length - 1 || showPicker ? 'border-b border-gray-50' : ''} transition-colors ${
                            selected.has(f.id) ? 'bg-blue-50/60' : isSchvalena ? 'bg-gray-50/40 hover:bg-gray-100/60' : 'hover:bg-[#f9f9f9]'
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
                            <div className="flex items-center gap-1.5">
                              {isOverdue && (
                                <span className="flex-shrink-0 inline-flex items-center justify-center w-[18px] h-[18px] rounded-full bg-red-500 text-white text-[9px] font-bold">!</span>
                              )}
                              {f.stav_workflow === 'NEEDS_INFO' && (
                                <span className="flex-shrink-0 inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 text-[9px] font-bold" title={f.blocker ?? 'Čeká na odpověď'}>
                                  ? čeká
                                </span>
                              )}
                              <div className={`text-[13px] font-medium ${isSchvalena ? 'text-gray-400' : 'text-gray-900'}`}>{f.dodavatel}</div>
                            </div>
                            <div className="text-[11px] text-gray-400">IČO {f.ico}</div>
                            {f.stav_workflow === 'NEEDS_INFO' && f.blocker && (
                              <div className="text-[10px] text-amber-600 mt-0.5 line-clamp-1">{f.blocker}</div>
                            )}
                          </td>
                          {/* col: Faktura / VS */}
                          <td className="px-4 py-2.5">
                            <div className={`text-[13px] ${isSchvalena ? 'text-gray-400' : 'text-gray-700'}`}>{f.cislo_faktury || '—'}</div>
                            {f.variabilni_symbol && (
                              <div className="text-[11px] font-mono text-gray-400 mt-0.5">VS {f.variabilni_symbol}</div>
                            )}
                          </td>
                          {/* col: Vystavení */}
                          <td className="px-4 py-2.5">
                            <div className={`text-[13px] ${isSchvalena ? 'text-gray-400' : 'text-gray-700'}`}>{fmtDate(f.datum_vystaveni) || '—'}</div>
                          </td>
                          {/* col: Splatnost */}
                          <td className="px-4 py-2.5">
                            {(() => {
                              // Pro zaplacené faktury: skutečné datum platby z párované transakce
                              const actualPayDate = pairedT?.datum ?? null
                              const onTime = actualPayDate && f.datum_splatnosti
                                ? new Date(actualPayDate) <= new Date(f.datum_splatnosti) : null
                              return (
                                <div>
                                  <div className={`text-[13px] ${isSchvalena ? 'text-gray-400' : 'text-gray-700'}`}>{fmtDate(f.datum_splatnosti)}</div>
                                  {actualPayDate && (
                                    <div className={`text-[11px] mt-0.5 ${onTime === false ? 'text-red-500' : 'text-gray-400'}`}>
                                      zaplaceno {fmtDate(actualPayDate)}{onTime === false ? ' !' : ''}
                                    </div>
                                  )}
                                </div>
                              )
                            })()}
                          </td>
                          {/* col: Kategorie */}
                          <td className="px-4 py-2.5" onClick={e => e.stopPropagation()}>
                            {(f.stav === 'nova' || f.stav === 'zaplacena') && kategorieList.length > 0 ? (
                              <select
                                value={effectiveKategorieId ?? ''}
                                onChange={async e => {
                                  const val = Number(e.target.value)
                                  const next = new Map(kategorieOverride)
                                  if (val) next.set(f.id, val); else next.delete(f.id)
                                  setKategorieOverride(next)
                                  if (f.stav === 'zaplacena' && val) {
                                    await fetch(`/api/faktury/${f.id}/zmenit-kategorii`, {
                                      method: 'PATCH',
                                      headers: { 'Content-Type': 'application/json' },
                                      body: JSON.stringify({ kategorie_id: val }),
                                    })
                                  }
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
                            <div className="text-[11px] text-gray-400">bez DPH {fmt(f.castka_bez_dph, f.mena)}</div>
                            {pairedT && (
                              <div className={`text-[12px] font-semibold mt-0.5 ${Math.abs(Math.abs(pairedT.castka) - Number(f.castka_s_dph)) < 1 ? 'text-green-600' : 'text-orange-500'}`}>
                                {fmt(Math.abs(pairedT.castka), pairedT.mena)} ✓
                              </div>
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
                                <div className="flex flex-col items-end gap-0.5">
                                  <button onClick={() => schvalitAZaplatit(f.id, kategorieOverride.get(f.id) ?? f.kategorie_id ?? undefined)} disabled={processing}
                                    className="px-3 py-1.5 text-[12px] font-medium text-white bg-[#0071e3] rounded-[8px] hover:bg-[#0077ed] disabled:opacity-40 whitespace-nowrap">
                                    Schválit
                                  </button>
                                  {caseMeta[f.id] && (
                                    <span className={`text-[9px] font-medium px-1.5 py-0.5 rounded ${
                                      caseMeta[f.id].confidence >= 85 ? 'bg-green-50 text-green-600' :
                                      caseMeta[f.id].confidence >= 60 ? 'bg-amber-50 text-amber-600' :
                                      'bg-red-50 text-red-500'
                                    }`} title={caseMeta[f.id].source_of_rule}>
                                      {caseMeta[f.id].confidence}% · {caseMeta[f.id].source_of_rule || caseMeta[f.id].rezim}
                                    </span>
                                  )}
                                </div>
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
                        {f.stav === 'schvalena' && suggestion && !showPicker && !rejectedSuggestions.has(f.id) && (() => {
                          const vsOk = !!f.variabilni_symbol && suggestion.variabilni_symbol === f.variabilni_symbol
                          const amtOk = Math.abs(Math.abs(suggestion.castka) - Number(f.castka_s_dph)) < 1
                          return (
                            <tr className="border-b border-blue-100/60 bg-blue-50/25">
                              <td className="pl-4 pr-0 py-2 text-blue-400 text-[11px]">↳</td>
                              {/* Dodavatel col: zpráva platby */}
                              <td className="px-4 py-2 max-w-0">
                                <div className="text-[12px] text-gray-500 truncate">{(suggestion.zprava || suggestion.protiucet || '—').substring(0, 60)}</div>
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
                              {/* Vystavení col: prázdné */}
                              <td></td>
                              {/* Splatnost col: TX datum */}
                              <td className="px-4 py-2 text-[12px] text-gray-500">{fmtDate(suggestion.datum)}</td>
                              {/* Kategorie col: prázdné */}
                              <td></td>
                              {/* Částka col: TX částka */}
                              <td className="px-4 py-2 text-right">
                                <span className={`text-[13px] font-semibold ${amtOk ? 'text-green-600' : 'text-orange-500'}`}>
                                  {fmt(Math.abs(suggestion.castka), suggestion.mena)}
                                  {amtOk && <span className="ml-1 text-[11px]">✓</span>}
                                </span>
                              </td>
                              {/* Actions col: Spárovat + Odmítnout */}
                              <td className="px-4 py-2 text-right" onClick={e => e.stopPropagation()}>
                                <div className="flex items-center justify-end gap-2">
                                  <button onClick={() => setRejectedSuggestions(prev => new Set(prev).add(f.id))}
                                    className="px-3 py-1.5 text-[12px] font-medium text-gray-500 bg-gray-100 rounded-[7px] hover:bg-gray-200 whitespace-nowrap">
                                    Odmítnout
                                  </button>
                                  <button onClick={() => sparovat(f.id, suggestion.id)} disabled={processing}
                                    className="px-3 py-1.5 text-[12px] font-medium text-white bg-[#0071e3] rounded-[7px] hover:bg-[#0077ed] disabled:opacity-40 whitespace-nowrap">
                                    Spárovat
                                  </button>
                                </div>
                              </td>
                            </tr>
                          )
                        })()}
                        {/* Sub-řádek: spárovaná transakce (zaplacena) — jen zpráva + datum */}
                        {f.stav === 'zaplacena' && pairedT && (
                          <tr className="border-b border-green-100/60 bg-green-50/20">
                            <td className="pl-4 pr-0 py-1.5 text-green-500 text-[11px]">↳</td>
                            <td className="px-4 py-1.5 max-w-0" colSpan={3}>
                              <div className="text-[11px] text-gray-400 truncate">{(pairedT.zprava || pairedT.protiucet || '—').substring(0, 80)}</div>
                            </td>
                            <td className="px-4 py-1.5 text-[11px] text-gray-400">{fmtDate(pairedT.datum)}</td>
                            <td colSpan={2}></td>
                          </tr>
                        )}
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
            ))}

            {/* ===== CHYBĚJÍCÍ FAKTURY (Ke schválení tab) ===== */}
            {tab === 'nova' && chybejici && chybejici.length > 0 && (
              <div className="mt-6">
                <div className="text-[12px] font-semibold text-red-600 uppercase tracking-wider mb-2">
                  Pravděpodobně chybějící faktury — odchozí platby bez spárované faktury
                </div>
                <div className="bg-white rounded-2xl shadow-sm border border-red-100 overflow-clip">
                  <table className="w-full text-[13px]">
                    <thead className="bg-red-50 border-b border-red-100">
                      <tr>
                        <th className="px-5 py-2.5 text-left text-[11px] font-semibold text-red-500 uppercase tracking-wide">Dodavatel</th>
                        <th className="px-5 py-2.5 text-left text-[11px] font-semibold text-red-500 uppercase tracking-wide">Chybí</th>
                        <th className="px-5 py-2.5 text-right text-[11px] font-semibold text-red-500 uppercase tracking-wide">Počet plateb</th>
                        <th className="px-5 py-2.5 text-right text-[11px] font-semibold text-red-500 uppercase tracking-wide">Hodnota plateb</th>
                      </tr>
                    </thead>
                    <tbody>
                      {chybejici.map(item => (
                        <tr key={item.dodavatel} className="border-b border-gray-50 hover:bg-red-50/30">
                          <td className="px-5 py-3 font-medium text-gray-800">{item.dodavatel}</td>
                          <td className="px-5 py-3 text-gray-700 text-[12px] font-medium">{item.chybi_mesic_nazev}</td>
                          <td className="px-5 py-3 text-right text-gray-600">{item.nesparovana_count}</td>
                          <td className="px-5 py-3 text-right font-semibold text-gray-700">
                            {new Intl.NumberFormat('cs-CZ', { style: 'currency', currency: item.nesparovana_mena || 'CZK', maximumFractionDigits: 0 }).format(item.nesparovana_castka)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* ===== TRANSAKCE ZÁLOŽKY (Spárované / Nespárované) ===== */}
            {isTransakceTab && (() => {
              const baseList = transakce.filter(t => tab === 'sparovane' ? t.stav === 'sparovano' : t.stav === 'nesparovano')
              const dirList = transakceDir === 'prijate' ? baseList.filter(t => t.castka > 0)
                : transakceDir === 'odeslane' ? baseList.filter(t => t.castka < 0)
                : baseList
              const q = transakceSearch.trim().toLowerCase()
              const tList = q ? dirList.filter(t => {
                const pairedF = t.faktura_id ? faktury.find(f => f.id === t.faktura_id) : null
                return (t.zprava || '').toLowerCase().includes(q)
                  || (pairedF?.dodavatel || '').toLowerCase().includes(q)
                  || (t.variabilni_symbol || '').toLowerCase().includes(q)
              }) : dirList
              const nesparPrijate = tab === 'nesparovane' ? baseList.filter(t => t.castka > 0) : []
              const nesparOdeslane = tab === 'nesparovane' ? baseList.filter(t => t.castka < 0) : []
              const nesparPrijateSum = nesparPrijate.reduce((s, t) => s + Math.abs(t.castka), 0)
              const nesparOdeslaneSum = nesparOdeslane.reduce((s, t) => s + Math.abs(t.castka), 0)
              return transakceLoading ? (
                <div className="text-center py-20 text-[13px] text-gray-400">Načítám…</div>
              ) : (
                <>
                  {tab === 'nesparovane' && (
                    <div className="mb-4 flex gap-3">
                      <div className="flex-1 bg-white rounded-2xl shadow-sm border border-black/[0.06] px-5 py-4">
                        <div className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-1">Přijaté platby</div>
                        <div className="text-[22px] font-semibold text-green-600 tabular-nums">{nesparPrijate.length}</div>
                        <div className="text-[13px] text-gray-500 mt-0.5">celkem <span className="font-semibold text-gray-700">{fmt(nesparPrijateSum, 'CZK')}</span></div>
                      </div>
                      <div className="flex-1 bg-white rounded-2xl shadow-sm border border-black/[0.06] px-5 py-4">
                        <div className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-1">Odeslané platby</div>
                        <div className="text-[22px] font-semibold text-red-500 tabular-nums">{nesparOdeslane.length}</div>
                        <div className="text-[13px] text-gray-500 mt-0.5">celkem <span className="font-semibold text-gray-700">{fmt(nesparOdeslaneSum, 'CZK')}</span></div>
                      </div>
                    </div>
                  )}
                  <div className="mb-3 flex items-center gap-2">
                    <input
                      type="text"
                      placeholder="Hledat dodavatele, popis, VS…"
                      value={transakceSearch}
                      onChange={e => setTransakceSearch(e.target.value)}
                      className="w-64 px-3 py-2 text-[13px] rounded-xl border border-black/[0.1] bg-white outline-none focus:border-[#0071e3] placeholder:text-gray-400"
                    />
                    {transakceSearch && (
                      <button onClick={() => setTransakceSearch('')} className="text-[12px] text-gray-400 hover:text-gray-600">Zrušit</button>
                    )}
                    {(['vse','prijate','odeslane'] as const).map(d => (
                      <button key={d} onClick={() => setTransakceDir(d)}
                        className={`px-3 py-1.5 rounded-xl text-[12px] font-medium transition-colors ${transakceDir === d ? 'bg-gray-900 text-white' : 'bg-white border border-black/[0.1] text-gray-600 hover:bg-gray-50'}`}>
                        {d === 'vse' ? 'Vše' : d === 'prijate' ? '↓ Přijaté' : '↑ Odeslané'}
                      </button>
                    ))}
                    <span className="text-[12px] text-gray-400">{tList.length} transakcí</span>
                  </div>
                  {tList.length === 0 ? (
                    <div className="text-center py-20 text-[13px] text-gray-400">Žádné transakce</div>
                  ) : (
                    <div className="bg-white rounded-2xl shadow-sm border border-black/[0.06] overflow-clip">
                      <table className="w-full">
                        <thead className="sticky top-[105px] z-10 bg-white">
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
                  )}
                </>
              )
            })()}
        </>)}

        {/* ===== PRAVIDLA DODAVATELŮ ===== */}
        {/* ===== VYDANÉ FAKTURY ===== */}
        {tab === 'vydane' && (
          <div className="space-y-4">
            {/* Upload CSV */}
            <div className="bg-white rounded-2xl shadow-sm border border-black/[0.06] px-5 py-4 flex items-center gap-4">
              <div>
                <div className="text-[13px] font-medium text-gray-900 mb-0.5">Nahrát faktury z CSV</div>
                <div className="text-[11px] text-gray-400">Sloupce: cislo_faktury, odberatel, castka_bez_dph, dph, castka_s_dph, mena, datum_vystaveni, datum_splatnosti, variabilni_symbol, popis</div>
              </div>
              <label className={`ml-auto flex-shrink-0 px-4 py-2 rounded-xl text-[13px] font-medium cursor-pointer transition-colors ${csvImporting ? 'bg-gray-100 text-gray-400' : 'bg-[#0071e3] text-white hover:bg-[#0077ed]'}`}>
                {csvImporting ? 'Nahrávám…' : 'Vybrat CSV'}
                <input type="file" accept=".csv" className="hidden" onChange={handleCsvImport} disabled={csvImporting} />
              </label>
              {csvResult && (
                <div className="text-[12px] text-gray-500 ml-3">{csvResult}</div>
              )}
            </div>

            {/* Tabulka */}
            {vydaneLoading ? (
              <div className="text-center py-20 text-[13px] text-gray-400">Načítám…</div>
            ) : vydane.length === 0 ? (
              <div className="text-center py-20 text-[13px] text-gray-400">Žádné vydané faktury</div>
            ) : (
              <div className="bg-white rounded-2xl shadow-sm border border-black/[0.06] overflow-clip">
                <table className="w-full text-sm">
                  <thead className="sticky top-[105px] z-10 bg-white border-b border-gray-100">
                    <tr>
                      <th className="px-4 py-3 text-left text-[11px] font-semibold text-gray-400 uppercase tracking-wide">Odběratel</th>
                      <th className="px-4 py-3 text-left text-[11px] font-semibold text-gray-400 uppercase tracking-wide">Faktura / VS</th>
                      <th className="px-4 py-3 text-left text-[11px] font-semibold text-gray-400 uppercase tracking-wide">Vystavení</th>
                      <th className="px-4 py-3 text-left text-[11px] font-semibold text-gray-400 uppercase tracking-wide">Splatnost</th>
                      <th className="px-4 py-3 text-right text-[11px] font-semibold text-gray-400 uppercase tracking-wide">Částka</th>
                      <th className="px-4 py-3 text-center text-[11px] font-semibold text-gray-400 uppercase tracking-wide">Stav</th>
                    </tr>
                  </thead>
                  <tbody>
                    {vydane.map((f, i) => {
                      const isOverdueV = f.stav !== 'zaplacena' && f.datum_splatnosti
                        ? new Date(f.datum_splatnosti) < new Date(new Date().toDateString())
                        : false
                      return (
                        <tr key={f.id} className={`${i < vydane.length - 1 ? 'border-b border-gray-50' : ''} hover:bg-[#f9f9f9]`}>
                          <td className="px-4 py-2.5">
                            <div className="flex items-center gap-1.5">
                              {isOverdueV && (
                                <span className="flex-shrink-0 inline-flex items-center justify-center w-[18px] h-[18px] rounded-full bg-red-500 text-white text-[9px] font-bold">!</span>
                              )}
                              <div className="text-[13px] font-medium text-gray-900">{f.odberatel}</div>
                            </div>
                            {f.popis && <div className="text-[11px] text-gray-400 mt-0.5">{f.popis}</div>}
                          </td>
                          <td className="px-4 py-2.5">
                            <div className="text-[13px] text-gray-700">{f.cislo_faktury}</div>
                            {f.variabilni_symbol && <div className="text-[11px] font-mono text-gray-400 mt-0.5">VS {f.variabilni_symbol}</div>}
                          </td>
                          <td className="px-4 py-2.5">
                            <div className="text-[13px] text-gray-700">{fmtDate(f.datum_vystaveni)}</div>
                          </td>
                          <td className="px-4 py-2.5">
                            <div className={`text-[13px] ${isOverdueV ? 'text-red-600 font-medium' : 'text-gray-700'}`}>{fmtDate(f.datum_splatnosti)}</div>
                          </td>
                          <td className="px-4 py-2.5 text-right">
                            <div className="text-[13px] font-semibold text-gray-900">{fmt(f.castka_s_dph, f.mena)}</div>
                            <div className="text-[11px] text-gray-400">bez DPH {fmt(f.castka_bez_dph, f.mena)}</div>
                          </td>
                          <td className="px-4 py-2.5 text-center">
                            <span className={`inline-flex px-2 py-0.5 rounded-full text-[11px] font-medium ${
                              f.stav === 'zaplacena' ? 'bg-green-50 text-green-700' :
                              isOverdueV ? 'bg-red-50 text-red-700' :
                              'bg-yellow-50 text-yellow-700'
                            }`}>
                              {f.stav === 'zaplacena' ? 'Zaplacena' : isOverdueV ? 'Po splatnosti' : 'Čekající'}
                            </span>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {tab === 'vykazy' && (
          <VykazVysledovka rok={selectedYear} />
        )}

        {/* ===== ABRA CHECK ===== */}
        {tab === 'abra' && (
          <div className="space-y-5">
            {abraResult && (
              <div className="flex items-center gap-3 flex-wrap">
                <span className="text-[13px] text-gray-400">
                  Faktury — SB: {abraResult.stats.sbTotal} · ABRA: {abraResult.stats.abraTotal} · Shoda: {abraResult.stats.matched}
                  {abraResult.stats.abraBankaTotal !== undefined && ` · Banka ABRA (FP-*): ${abraResult.stats.abraBankaTotal}`}
                  {' · '}
                  <button onClick={loadAbraReconcile} className="text-[#0071e3] hover:underline">Obnovit</button>
                </span>
                {abraFixResult && (
                  <span className={`text-[12px] px-2 py-0.5 rounded-lg ${abraFixResult.includes('Chyby') ? 'bg-red-50 text-red-600' : 'bg-green-50 text-green-700'}`}>
                    {abraFixResult}
                  </span>
                )}
              </div>
            )}
            <div className="space-y-5">
              {abraLoading && <div className="text-center py-10 text-[13px] text-gray-400">Načítám z ABRA…</div>}
              {!abraLoading && abraResult && (<>
                {/* Diff: rozdílný stav */}
                {abraResult.diff.length > 0 && (
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <div>
                        <div className="text-[12px] font-semibold text-orange-600 uppercase tracking-wider">Rozdílný stav ({abraResult.diff.length})</div>
                        <div className="text-[11px] text-gray-400 mt-0.5">
                          {abraResult.stats.diffWithTransakce ?? 0} s párovanou transakcí · {abraResult.stats.diffWithoutTransakce ?? 0} bez
                        </div>
                      </div>
                      <div className="flex gap-2">
                        {(abraResult.stats.diffWithTransakce ?? 0) > 0 && (
                          <button onClick={() => abraFix('create-banka-bulk')} disabled={abraFixing !== null}
                            className="px-3 py-1 text-[12px] font-medium text-white bg-green-600 rounded-lg hover:bg-green-700 disabled:opacity-40">
                            {abraFixing === 'create-banka-bulk' ? 'Zaúčtovávám…' : `Zaúčtovat banka (${abraResult.stats.diffWithTransakce})`}
                          </button>
                        )}
                        {(abraResult.stats.diffWithoutTransakce ?? 0) > 0 && (
                          <button onClick={() => abraFix('fix-stav-bulk')} disabled={abraFixing !== null}
                            className="px-3 py-1 text-[12px] font-medium text-orange-700 bg-orange-100 rounded-lg hover:bg-orange-200 disabled:opacity-40">
                            {abraFixing === 'fix-stav-bulk' ? 'Opravuji…' : `Ručně označit (${abraResult.stats.diffWithoutTransakce})`}
                          </button>
                        )}
                      </div>
                    </div>
                    <div className="space-y-1">
                      {abraResult.diff.map(d => {
                        const hasTrans = 'transakce' in d && d.transakce != null
                        return (
                          <div key={d.sb.id} className="flex items-center justify-between px-3 py-2 rounded-xl bg-orange-50 border border-orange-100">
                            <div>
                              <div className="text-[13px] font-medium text-gray-900">{d.sb.dodavatel}</div>
                              <div className="text-[11px] text-gray-400">{d.sb.cislo_faktury} · {d.abra.kod}</div>
                            </div>
                            <div className="flex items-center gap-2">
                              <div className="text-right">
                                <div className="text-[12px] font-semibold text-gray-700">{fmt(d.sb.castka_s_dph, d.sb.mena)}</div>
                                <div className="text-[11px] mt-0.5">
                                  <span className={`px-1.5 py-0.5 rounded-full font-medium ${d.sb.stav === 'zaplacena' ? 'bg-green-100 text-green-700' : 'bg-blue-100 text-blue-700'}`}>SB: {d.sb.stav}</span>
                                  {' '}
                                  <span className="px-1.5 py-0.5 rounded-full font-medium bg-red-100 text-red-700">ABRA: {d.abraStav}</span>
                                </div>
                              </div>
                              {hasTrans ? (
                                <button
                                  onClick={() => abraFix('create-banka', { sbId: d.sb.id, abraId: d.abra.id, transakceId: (d as {transakce: {id: number}}).transakce.id })}
                                  disabled={abraFixing !== null}
                                  className="px-2 py-1 text-[11px] font-medium text-green-700 bg-green-100 rounded-lg hover:bg-green-200 disabled:opacity-40 whitespace-nowrap"
                                >Zaúčtovat</button>
                              ) : (
                                <button
                                  onClick={() => abraFix('fix-stav', { abraId: d.abra.id })}
                                  disabled={abraFixing !== null}
                                  className="px-2 py-1 text-[11px] font-medium text-orange-700 bg-orange-100 rounded-lg hover:bg-orange-200 disabled:opacity-40 whitespace-nowrap"
                                >Ručně</button>
                              )}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )}

                {/* Pouze v SB */}
                {abraResult.onlySB.length > 0 && (
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <div className="text-[12px] font-semibold text-red-600 uppercase tracking-wider">Jen v aplikaci, chybí v ABRA ({abraResult.onlySB.length})</div>
                      <button
                        onClick={() => abraFix('create-in-abra-bulk')}
                        disabled={abraFixing !== null}
                        className="px-3 py-1 text-[12px] font-medium text-white bg-red-500 rounded-lg hover:bg-red-600 disabled:opacity-40"
                      >
                        {abraFixing === 'create-in-abra-bulk' ? 'Vytvářím…' : `Vytvořit vše v ABRA (${abraResult.onlySB.length})`}
                      </button>
                    </div>
                    <div className="space-y-1">
                      {abraResult.onlySB.map(f => (
                        <div key={f.id} className="flex items-center justify-between px-3 py-2 rounded-xl bg-red-50 border border-red-100">
                          <div>
                            <div className="text-[13px] font-medium text-gray-900">{f.dodavatel}</div>
                            <div className="text-[11px] text-gray-400">{f.cislo_faktury}</div>
                          </div>
                          <div className="flex items-center gap-2">
                            <div className="text-right">
                              <div className="text-[12px] font-semibold text-gray-700">{fmt(f.castka_s_dph, f.mena)}</div>
                              <div className={`text-[11px] px-1.5 py-0.5 rounded-full font-medium mt-0.5 inline-block ${f.stav === 'zaplacena' ? 'bg-green-100 text-green-700' : 'bg-blue-100 text-blue-700'}`}>
                                {f.stav}
                              </div>
                            </div>
                            <button
                              onClick={() => abraFix('create-in-abra', { sbId: f.id })}
                              disabled={abraFixing !== null}
                              className="px-2 py-1 text-[11px] font-medium text-red-700 bg-red-100 rounded-lg hover:bg-red-200 disabled:opacity-40 whitespace-nowrap"
                            >
                              Vytvořit
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Pouze v ABRA */}
                {abraResult.onlyABRA.length > 0 && (
                  <div>
                    <div className="text-[12px] font-semibold text-gray-500 uppercase tracking-wider mb-2">Jen v ABRA, chybí v aplikaci ({abraResult.onlyABRA.length})</div>
                    <div className="space-y-1">
                      {abraResult.onlyABRA.map(f => (
                        <div key={f.id} className="flex items-center justify-between px-3 py-2 rounded-xl bg-gray-50 border border-gray-100">
                          <div>
                            <div className="text-[13px] font-medium text-gray-700">{f.firma}</div>
                            <div className="text-[11px] text-gray-400">{f.kod}</div>
                          </div>
                          <div className="flex items-center gap-2">
                            <div className="text-[12px] font-semibold text-gray-600">{fmt(f.sumCelkem, 'CZK')}</div>
                            <button
                              onClick={() => abraFix('delete-abra', { abraId: f.id })}
                              disabled={abraFixing !== null}
                              className="px-2 py-1 text-[11px] font-medium text-red-600 bg-red-50 rounded-lg hover:bg-red-100 disabled:opacity-40 whitespace-nowrap"
                            >
                              Smazat z ABRA
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Banka porovnání */}
                {abraResult.banka && (abraResult.banka.sbBezBanky.length > 0 || abraResult.banka.abraBankaBezSB.length > 0) && (
                  <div>
                    <div className="text-[12px] font-semibold text-gray-500 uppercase tracking-wider mb-1">
                      Banka doklady · SB spárované: {abraResult.stats.sbSparovaneTotal} · ABRA banka (FP-*): {abraResult.stats.abraBankaTotal}
                    </div>
                    <div className="space-y-3 mt-2">
                      {abraResult.banka.sbBezBanky.length > 0 && (
                        <div>
                          <div className="text-[11px] font-semibold text-orange-600 uppercase tracking-wider mb-1">Spárováno v aplikaci, chybí banka doklad v ABRA ({abraResult.banka.sbBezBanky.length})</div>
                          <div className="space-y-1">
                            {abraResult.banka.sbBezBanky.map(b => (
                              <div key={b.sbId} className="flex items-center justify-between px-3 py-2 rounded-xl bg-orange-50 border border-orange-100">
                                <div>
                                  <div className="text-[13px] font-medium text-gray-900">{b.dodavatel}</div>
                                  <div className="text-[11px] text-gray-400">FP-{b.sbId} · {fmtDate(b.datum)}</div>
                                </div>
                                <div className="flex items-center gap-2">
                                  <span className="text-[12px] font-semibold text-gray-700">{fmt(b.castka, b.mena)}</span>
                                  <button
                                    onClick={() => abraFix('create-banka', { sbId: b.sbId, abraId: abraResult!.diff.find(d => d.sb.id === b.sbId)?.abra.id ?? '', transakceId: 0 })}
                                    disabled={abraFixing !== null}
                                    className="px-2 py-1 text-[11px] font-medium text-orange-700 bg-orange-100 rounded-lg hover:bg-orange-200 disabled:opacity-40 whitespace-nowrap"
                                  >Zaúčtovat</button>
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                      {abraResult.banka.abraBankaBezSB.length > 0 && (
                        <div>
                          <div className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-1">Banka doklad v ABRA bez SB transakce ({abraResult.banka.abraBankaBezSB.length})</div>
                          <div className="space-y-1">
                            {abraResult.banka.abraBankaBezSB.map(b => (
                              <div key={b.id} className="flex items-center justify-between px-3 py-2 rounded-xl bg-gray-50 border border-gray-100">
                                <div className="text-[13px] text-gray-700">{b.popis}</div>
                                <div className="text-[12px] font-semibold text-gray-600">{fmt(b.sumOsv, 'CZK')} · {fmtDate(b.datVyst)}</div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {abraResult.diff.length === 0 && abraResult.onlySB.length === 0 && abraResult.onlyABRA.length === 0 &&
                 (!abraResult.banka || (abraResult.banka.sbBezBanky.length === 0 && abraResult.banka.abraBankaBezSB.length === 0)) && (
                  <div className="text-center py-10 text-[13px] text-gray-400">Vše sedí, žádné rozdíly</div>
                )}
              </>)}
              {!abraLoading && !abraResult && (
                <div className="text-center py-10 text-[13px] text-red-500">Chyba při načítání z ABRA</div>
              )}
            </div>

            {/* Audit — AUDITOR spouští, ACCOUNTANT opravuje, ARCHITECT verifikuje */}
            <div className="border-t border-gray-100 pt-4 space-y-4">
              <div className="flex items-center gap-3">
                <button
                  onClick={loadAuditFull}
                  disabled={auditFullLoading}
                  className="px-3 py-1.5 rounded-lg bg-[#0071e3] text-white text-[12px] font-medium hover:bg-[#0077ed] disabled:opacity-50"
                >
                  {auditFullLoading ? 'Audituji…' : 'Spustit audit'}
                </button>
                {auditFullResult && (
                  <span className={`text-[12px] px-2 py-0.5 rounded-lg font-medium ${!(auditFullResult.data.shoda.faktury_ok && auditFullResult.data.shoda.banka_ok) ? 'bg-red-50 text-red-600' : 'bg-green-50 text-green-700'}`}>
                    {!(auditFullResult.data.shoda.faktury_ok && auditFullResult.data.shoda.banka_ok)
                      ? `AUDITOR: rozdíly nalezeny (banka ${auditFullResult.data.shoda.banka_diff > 0 ? '+' : ''}${auditFullResult.data.shoda.banka_diff}, faktury ${auditFullResult.data.shoda.faktury_diff > 0 ? '+' : ''}${auditFullResult.data.shoda.faktury_diff})`
                      : 'AUDITOR: vše v pořádku'}
                  </span>
                )}
              </div>

              {auditFullResult && (
                <div className="space-y-3">
                  {/* Counts */}
                  <div className="text-[12px] text-gray-500 bg-gray-50 rounded-lg px-3 py-2 flex flex-wrap gap-x-4 gap-y-1">
                    <span>SB: nova <b>{auditFullResult.data.sb.nova}</b> · schvalena <b>{auditFullResult.data.sb.schvalena}</b> · zaplacena <b>{auditFullResult.data.sb.zaplacena}</b></span>
                    <span>ABRA: FP faktury <b>{auditFullResult.data.abra.faktury_fp}</b> · banka doklady <b>{auditFullResult.data.abra.banka_celkem}</b></span>
                    {/* duplicity_smazany shown if present */}
                  </div>

                  {/* Chybějící v ABRA — ACCOUNTANT opravuje */}
                  {auditFullResult.data.rozdily.chybejici_v_abra.length > 0 && (
                    <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3">
                      <div className="flex items-center justify-between mb-2">
                        <div>
                          <div className="text-[11px] font-bold text-red-700 uppercase tracking-wider">
                            ACCOUNTANT — chybí v ABRA ({auditFullResult.data.rozdily.chybejici_v_abra.length})
                          </div>
                          <div className="text-[11px] text-red-500 mt-0.5">Faktury zaplacené/schválené v aplikaci, ale nejsou jako FP záznamy v ABRA</div>
                        </div>
                        <button
                          onClick={() => abraFix('create-in-abra-bulk')}
                          disabled={abraFixing !== null}
                          className="px-3 py-1.5 text-[12px] font-medium text-white bg-red-600 rounded-lg hover:bg-red-700 disabled:opacity-40 whitespace-nowrap"
                        >
                          {abraFixing === 'create-in-abra-bulk' ? 'Vytvářím…' : `Vytvořit vše v ABRA (${auditFullResult.data.rozdily.chybejici_v_abra.length})`}
                        </button>
                      </div>
                      <div className="space-y-1">
                        {auditFullResult.data.rozdily.chybejici_v_abra.map(f => (
                          <div key={f.id} className="flex items-center justify-between text-[12px]">
                            <span className="text-red-800 font-medium">{f.dodavatel}</span>
                            <span className="text-gray-600">{f.castka.toLocaleString('cs-CZ')} Kč · {f.ocekavany_kod} · <span className="text-gray-400">{f.stav}</span></span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Osiřelé v ABRA — ACCOUNTANT opravuje */}
                  {auditFullResult.data.rozdily['osirelé_v_abra'].length > 0 && (
                    <div className="rounded-xl border border-orange-200 bg-orange-50 px-4 py-3">
                      <div className="text-[11px] font-bold text-orange-700 uppercase tracking-wider mb-1">
                        ACCOUNTANT — osiřelé v ABRA ({auditFullResult.data.rozdily['osirelé_v_abra'].length})
                      </div>
                      <div className="text-[11px] text-orange-500 mb-2">FP záznamy v ABRA bez odpovídající faktury v aplikaci — pravděpodobné duplicity</div>
                      <div className="space-y-0.5">
                        {auditFullResult.data.rozdily['osirelé_v_abra'].map(kod => (
                          <div key={kod} className="text-[12px] text-orange-800">{kod}</div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Banka diff — pokud existuje */}
                  {!auditFullResult.data.shoda.banka_ok && (
                    <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
                      <div className="text-[11px] font-bold text-amber-700 uppercase tracking-wider mb-1">
                        ARCHITECT — datový rozdíl banka ({auditFullResult.data.shoda.banka_diff > 0 ? '+' : ''}{auditFullResult.data.shoda.banka_diff})
                      </div>
                      <div className="text-[11px] text-amber-600 mb-2">
                        SB spárováno: {auditFullResult.data.sb.sparovane_transakce} · ABRA banka doklady: {auditFullResult.data.abra.banka_celkem}
                        {' '}· Rozdíl přesahuje toleranci ±2 — nutná datová kontrola
                      </div>
                      <button
                        onClick={() => { setCtOpen(true); if (!ctData) loadControlTower() }}
                        className="text-[11px] px-3 py-1 rounded-lg bg-amber-100 border border-amber-300 text-amber-800 hover:bg-amber-200 font-medium"
                      >
                        Otevřít ARCHITECT v Control Tower →
                      </button>
                    </div>
                  )}

                  {/* Claude souhrn */}
                  {auditFullResult.audit?.souhrn && (
                    <div className="text-[11px] text-gray-500 px-3 py-2 bg-gray-50 rounded-lg">
                      <span className="font-medium text-gray-600">AI souhrn:</span> {auditFullResult.audit.souhrn}
                    </div>
                  )}

                  {/* All ok */}
                  {auditFullResult.data.shoda.faktury_ok && auditFullResult.data.shoda.banka_ok &&
                   auditFullResult.data.rozdily.chybejici_v_abra.length === 0 &&
                   auditFullResult.data.rozdily['osirelé_v_abra'].length === 0 && (
                    <div className="text-center py-3 text-[13px] text-green-600 font-medium">Vše sedí — žádné rozdíly</div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

      </main>

      {/* ── Control Tower panel ─────────────────────────────────────────── */}
      {ctOpen && (
        <div className="fixed inset-0 z-50 flex justify-end">
          <div className="absolute inset-0 bg-black/20" onClick={() => !agentRunning && setCtOpen(false)} />
          <div className="relative w-full max-w-2xl bg-white shadow-2xl flex flex-col h-full">

            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 bg-white">
              <div>
                <div className="text-[14px] font-semibold text-gray-900">Control Tower</div>
                <div className="text-[11px] text-gray-400">Agent Control Tower — SuperAccount {selectedYear}</div>
              </div>
              <div className="flex items-center gap-3">
                <button onClick={() => { loadControlTower(); loadAbraReconcile() }} disabled={ctLoading}
                  className="text-[11px] px-2.5 py-1 rounded-lg border border-gray-200 text-gray-500 hover:bg-gray-50 disabled:opacity-40">
                  {ctLoading ? 'Analyzuji…' : 'Obnovit'}
                </button>
                <button onClick={() => setCtOpen(false)} className="text-gray-400 hover:text-gray-600 text-[18px]">✕</button>
              </div>
            </div>

            {/* Tab switcher */}
            <div className="flex border-b border-gray-100 bg-gray-50/50 overflow-x-auto">
              {(['dashboard', 'tasking', 'abra', 'agent'] as const).map(t => {
                const label = t === 'dashboard' ? 'Dashboard' : t === 'tasking' ? 'Orchestrátor' : t === 'abra' ? 'ABRA sync' : 'PM Agent'
                const hasAbra = t === 'abra' && abraResult && (!abraResult.diff?.length === false || abraResult.onlySB?.length > 0)
                const abraBad = t === 'abra' && abraResult && (abraResult.diff?.length > 0 || abraResult.onlySB?.length > 0 || abraResult.onlyABRA?.length > 0)
                return (
                  <button key={t}
                    onClick={() => { setCtTab(t); if (t === 'abra' && !abraResult) loadAbraReconcile() }}
                    className={`px-4 py-2.5 text-[12px] font-medium border-b-2 transition-colors whitespace-nowrap ${
                      ctTab === t ? 'border-[#0071e3] text-[#0071e3]' : 'border-transparent text-gray-500 hover:text-gray-700'
                    }`}>
                    {label}
                    {t === 'agent' && needsInfoCount > 0 && (
                      <span className="ml-1.5 inline-flex items-center justify-center min-w-[14px] h-[14px] px-0.5 rounded-full bg-red-500 text-white text-[9px] font-bold">{needsInfoCount}</span>
                    )}
                    {abraBad && (
                      <span className="ml-1.5 inline-flex items-center justify-center min-w-[14px] h-[14px] px-0.5 rounded-full bg-orange-500 text-white text-[9px] font-bold">!</span>
                    )}
                    {t === 'abra' && abraResult && !abraBad && (
                      <span className="ml-1 text-green-500 text-[10px]">✓</span>
                    )}
                  </button>
                )
              })}
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto">

              {/* Loading */}
              {ctLoading && (
                <div className="flex flex-col items-center justify-center h-full gap-3">
                  <div className="w-8 h-8 border-2 border-[#0071e3] border-t-transparent rounded-full animate-spin" />
                  <div className="text-[13px] text-gray-500 animate-pulse">{ctLoadingStep || 'Analyzuji…'}</div>
                  <div className="text-[11px] text-gray-300">Claude Haiku · ~5–10s</div>
                </div>
              )}

              {/* ── DASHBOARD TAB ── */}
              {!ctLoading && ctTab === 'dashboard' && ctData?.analysis && (() => {
                const { system_health: sh, kpi_by_agent, critical_issues, patterns, quick_wins, strategic_improvements } = ctData.analysis
                const scoreColor = (s: number) => s >= 80 ? 'text-green-600' : s >= 60 ? 'text-amber-600' : 'text-red-600'
                const scoreBg = (s: number) => s >= 80 ? 'bg-green-50' : s >= 60 ? 'bg-amber-50' : 'bg-red-50'
                const riskColor = (r: string) => r === 'critical' ? 'bg-red-100 text-red-700' : r === 'high' ? 'bg-orange-100 text-orange-700' : r === 'medium' ? 'bg-amber-100 text-amber-700' : 'bg-green-100 text-green-700'
                const sevColor = (s: string) => s === 'critical' ? 'text-red-600 bg-red-50 border-red-200' : s === 'high' ? 'text-orange-600 bg-orange-50 border-orange-200' : s === 'medium' ? 'text-amber-600 bg-amber-50 border-amber-200' : 'text-gray-500 bg-gray-50 border-gray-200'
                return (
                  <div className="px-5 py-5 space-y-6">

                    {/* Overall score */}
                    <div className={`rounded-2xl p-5 ${scoreBg(sh.overall_score)}`}>
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider">System Health</span>
                        <span className={`text-[32px] font-bold ${scoreColor(sh.overall_score)}`}>{sh.overall_score}</span>
                      </div>
                      <p className="text-[13px] text-gray-600">{sh.summary}</p>
                      <div className="mt-3 grid grid-cols-3 gap-2">
                        {[
                          ['Accounting', sh.accounting_quality],
                          ['Audit', sh.audit_quality],
                          ['Workflow', sh.workflow_quality],
                          ['Data', sh.data_quality],
                          ['Architecture', sh.architecture_quality],
                          ['Learning', sh.learning_quality],
                        ].map(([label, val]) => (
                          <div key={String(label)} className="bg-white/60 rounded-xl px-3 py-2">
                            <div className="text-[10px] text-gray-400 font-medium">{label}</div>
                            <div className={`text-[16px] font-bold ${scoreColor(Number(val))}`}>{val}</div>
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* Agent KPI — chybovost, opravovost, vývoj v čase */}
                    {ctData?.agent_kpi && ctData?.agent_trend && (() => {
                      type AgentCfg = { key: string; label: string; color: string; bg: string; bar: string; errLabel: string }
                      const agents: AgentCfg[] = [
                        { key: 'accountant', label: 'ACCOUNTANT', color: 'text-blue-700', bg: 'bg-blue-50', bar: 'bg-blue-400', errLabel: 'chyb ACC' },
                        { key: 'auditor', label: 'AUDITOR', color: 'text-purple-700', bg: 'bg-purple-50', bar: 'bg-purple-400', errLabel: 'propuštěno' },
                        { key: 'pm', label: 'PM', color: 'text-green-700', bg: 'bg-green-50', bar: 'bg-green-400', errLabel: 'chyb PM' },
                        { key: 'architect', label: 'ARCHITECT', color: 'text-amber-700', bg: 'bg-amber-50', bar: 'bg-amber-400', errLabel: 'chyb ARCH' },
                      ]
                      return (
                        <div>
                          <div className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-3">Výkonnost agentů</div>
                          <div className="space-y-3">
                            {agents.map(ag => {
                              const kpi = ctData.agent_kpi?.[ag.key]
                              const trend = ctData.agent_trend?.[ag.key] ?? []
                              if (!kpi && trend.length === 0) return null
                              const last = trend[trend.length - 1]
                              const prev = trend[trend.length - 2]
                              const confDelta = prev && prev.avg_confidence > 0 ? last?.avg_confidence - prev.avg_confidence : 0
                              const maxConf = Math.max(...trend.map(w => w.avg_confidence), 1)
                              const errRate = kpi?.error_rate_pct ?? 0
                              const fixRate = ag.key === 'accountant' ? (kpi?.fix_rate_pct ?? 100) : null
                              const totalErr = ag.key === 'auditor' ? (kpi?.auditor_false_neg ?? 0) : (kpi?.acc_errors ?? 0)
                              return (
                                <div key={ag.key} className={`rounded-xl px-4 py-3 ${ag.bg}`}>
                                  {/* Header řádek */}
                                  <div className="flex items-center justify-between mb-2">
                                    <span className={`text-[11px] font-bold uppercase tracking-wide ${ag.color}`}>{ag.label}</span>
                                    <div className="flex items-center gap-3">
                                      {/* Chybovost */}
                                      <div className="text-right">
                                        <div className={`text-[15px] font-bold leading-none ${errRate > 10 ? 'text-red-600' : errRate > 5 ? 'text-amber-600' : 'text-green-600'}`}>
                                          {errRate}%
                                        </div>
                                        <div className="text-[9px] text-gray-400">chybovost</div>
                                      </div>
                                      {/* Fix rate — jen pro ACC */}
                                      {fixRate !== null && (
                                        <div className="text-right">
                                          <div className={`text-[15px] font-bold leading-none ${fixRate >= 80 ? 'text-green-600' : fixRate >= 50 ? 'text-amber-600' : 'text-red-600'}`}>
                                            {fixRate}%
                                          </div>
                                          <div className="text-[9px] text-gray-400">opravovost</div>
                                        </div>
                                      )}
                                    </div>
                                  </div>

                                  {/* Souhrnný řádek */}
                                  <div className="flex items-center gap-3 mb-2 text-[11px] text-gray-500">
                                    <span>{kpi?.total_decisions ?? 0} rozhodnutí</span>
                                    {totalErr > 0 && (
                                      <span className="text-red-500 font-medium">{totalErr}× {ag.errLabel}</span>
                                    )}
                                    {ag.key === 'accountant' && (kpi?.fixed ?? 0) > 0 && (
                                      <span className="text-green-600 font-medium">{kpi?.fixed}× opraveno</span>
                                    )}
                                    {last?.avg_confidence > 0 && (
                                      <span className={`ml-auto font-medium ${scoreColor(last.avg_confidence)}`}>
                                        conf {last.avg_confidence}%
                                        {confDelta !== 0 && <span className={confDelta > 0 ? 'text-green-500' : 'text-red-500'}> {confDelta > 0 ? '↑' : '↓'}{Math.abs(confDelta)}</span>}
                                      </span>
                                    )}
                                  </div>

                                  {/* Sparkline — confidence (modrá) + chybovost (červená) po týdnech */}
                                  {trend.length > 0 && (
                                    <div className="flex items-end gap-0.5 h-10">
                                      {trend.map((w, wi) => {
                                        const errors = ag.key === 'auditor' ? w.auditor_false_neg : w.acc_errors
                                        const errH = w.decisions > 0 ? Math.round((errors / w.decisions) * 28) : 0
                                        const confH = w.avg_confidence > 0 ? Math.round((w.avg_confidence / maxConf) * 28) : 2
                                        return (
                                          <div key={wi} className="flex-1 flex flex-col items-stretch justify-end h-full gap-0.5"
                                            title={`${w.week}: conf ${w.avg_confidence}% · ${w.decisions} rozh. · ${errors}× chyba · ${w.fixed}× opraveno`}>
                                            {/* Error bar (červená, nahoře) */}
                                            {errH > 0 && (
                                              <div className="w-full bg-red-400 rounded-t opacity-90" style={{ height: `${errH}px` }} />
                                            )}
                                            {/* Confidence bar (barevná, dole) */}
                                            <div className={`w-full ${ag.bar} rounded-b opacity-70`} style={{ height: `${confH}px` }} />
                                          </div>
                                        )
                                      })}
                                    </div>
                                  )}
                                  <div className="flex items-center justify-between mt-1">
                                    <div className="text-[8px] text-gray-400">{trend[0]?.week}</div>
                                    <div className="flex items-center gap-2 text-[8px] text-gray-400">
                                      <span className="flex items-center gap-1"><span className="inline-block w-2 h-2 rounded bg-red-400" />chyba</span>
                                      <span className={`flex items-center gap-1`}><span className={`inline-block w-2 h-2 rounded ${ag.bar}`} />conf</span>
                                    </div>
                                    <div className="text-[8px] text-gray-400">{last?.week}</div>
                                  </div>
                                </div>
                              )
                            })}
                          </div>
                        </div>
                      )
                    })()}

                    {/* KPI by agent */}
                    {kpi_by_agent?.length > 0 && (
                      <div>
                        <div className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-2">KPI by Agent</div>
                        <div className="space-y-2">
                          {kpi_by_agent.map((a, i) => (
                            <div key={i} className="flex items-start gap-3 bg-gray-50 rounded-xl px-4 py-3">
                              <div className="flex-1">
                                <div className="flex items-center gap-2 mb-1">
                                  <span className="text-[12px] font-semibold text-gray-800 uppercase">{a.agent_name}</span>
                                  <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full ${riskColor(a.risk_level)}`}>{a.risk_level}</span>
                                </div>
                                <div className="text-[11px] text-gray-500">{a.performance_summary}</div>
                                <div className="flex gap-3 mt-1">
                                  <span className="text-[10px] text-green-600">+ {a.strongest_area}</span>
                                  <span className="text-[10px] text-red-500">− {a.weakest_area}</span>
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Critical issues */}
                    {critical_issues?.length > 0 && (
                      <div>
                        <div className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-2">Critical Issues</div>
                        <div className="space-y-2">
                          {critical_issues.map((issue, i) => (
                            <div key={i} className={`rounded-xl border px-4 py-3 ${sevColor(issue.severity)}`}>
                              <div className="flex items-center gap-2 mb-1">
                                <span className="text-[9px] font-bold uppercase">{issue.severity}</span>
                                <span className="text-[9px] text-gray-400">{issue.type} · {issue.owner_agent}</span>
                              </div>
                              <div className="text-[12px] font-semibold mb-0.5">{issue.title}</div>
                              <div className="text-[11px] opacity-80 mb-1">{issue.symptom}</div>
                              <div className="text-[11px] font-medium">Fix: {issue.recommended_fix}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Patterns */}
                    {patterns?.length > 0 && (
                      <div>
                        <div className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-2">Patterns</div>
                        <div className="space-y-1.5">
                          {patterns.map((p, i) => (
                            <div key={i} className="flex items-center gap-2 text-[12px] text-gray-600">
                              <span className={p.trend === 'worsening' ? 'text-red-400' : p.trend === 'improving' ? 'text-green-500' : 'text-gray-400'}>
                                {p.trend === 'worsening' ? '↓' : p.trend === 'improving' ? '↑' : '→'}
                              </span>
                              {p.description}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Quick wins */}
                    {quick_wins?.length > 0 && (
                      <div>
                        <div className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-2">Quick Wins</div>
                        <div className="space-y-1.5">
                          {quick_wins.map((w, i) => (
                            <div key={i} className="flex items-start gap-2 text-[12px] text-gray-700 bg-green-50 rounded-lg px-3 py-2">
                              <span className="text-green-500 shrink-0">✓</span>
                              <span className="flex-1">{w.action}</span>
                              <span className="text-[10px] text-gray-400 shrink-0">{w.effort}/{w.impact}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* ABRA sync status — rychlý přehled SB vs ABRA */}
                    <div>
                      <div className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-2">ABRA sync (SB = zdroj pravdy)</div>
                      {abraResult ? (() => {
                        const allOk = abraResult.diff?.length === 0 && abraResult.onlySB?.length === 0 && abraResult.onlyABRA?.length === 0
                        const criticalCount = (abraResult.onlySB?.length ?? 0) + (abraResult.onlyABRA?.length ?? 0)
                        const warnCount = abraResult.diff?.length ?? 0
                        return (
                          <div className={`rounded-xl border px-4 py-3 ${allOk ? 'bg-green-50 border-green-200' : criticalCount > 0 ? 'bg-red-50 border-red-200' : 'bg-amber-50 border-amber-200'}`}>
                            <div className="flex items-center justify-between mb-2">
                              <span className={`text-[13px] font-bold ${allOk ? 'text-green-700' : criticalCount > 0 ? 'text-red-700' : 'text-amber-700'}`}>
                                {allOk ? '✓ Sync OK — SB a ABRA sedí' : criticalCount > 0 ? `✗ Kritické rozdíly (${criticalCount})` : `⚠ Rozdílný stav (${warnCount})`}
                              </span>
                              <button onClick={() => setCtTab('abra')} className="text-[11px] px-2.5 py-1 rounded-lg bg-white border border-gray-200 text-gray-600 hover:bg-gray-50">
                                Otevřít ABRA sync →
                              </button>
                            </div>
                            <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-gray-600">
                              <span>SB faktury: <b>{abraResult.stats.sbTotal}</b></span>
                              <span>ABRA FP: <b>{abraResult.stats.abraTotal}</b></span>
                              {abraResult.stats.sbTotal !== abraResult.stats.abraTotal && (
                                <span className="text-red-600 font-medium">diff {abraResult.stats.abraTotal - abraResult.stats.sbTotal > 0 ? '+' : ''}{abraResult.stats.abraTotal - abraResult.stats.sbTotal}</span>
                              )}
                              {abraResult.stats.abraBankaTotal !== undefined && (
                                <span>ABRA banka: <b>{abraResult.stats.abraBankaTotal}</b></span>
                              )}
                            </div>
                            {!allOk && (
                              <div className="mt-2 space-y-0.5">
                                {abraResult.onlySB?.length > 0 && <div className="text-[11px] text-red-700 font-medium">→ {abraResult.onlySB.length}× v SB, chybí v ABRA (zákonné riziko)</div>}
                                {abraResult.onlyABRA?.length > 0 && <div className="text-[11px] text-red-700 font-medium">→ {abraResult.onlyABRA.length}× v ABRA bez SB záznamu (fantomový)</div>}
                                {abraResult.diff?.length > 0 && <div className="text-[11px] text-amber-700">→ {abraResult.diff.length}× rozdílný stav (SB zaplaceno, ABRA jinak)</div>}
                              </div>
                            )}
                          </div>
                        )
                      })() : (
                        <button onClick={() => { setCtTab('abra'); loadAbraReconcile() }}
                          className="w-full text-[12px] px-4 py-3 rounded-xl border border-dashed border-gray-200 text-gray-400 hover:bg-gray-50 hover:text-gray-600">
                          Načíst ABRA sync →
                        </button>
                      )}
                    </div>

                    {/* Chyby agentů — korekce z agent_log */}
                    {ctData?.agent_errors && ctData.agent_errors.length > 0 && (
                      <div>
                        <div className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-2">
                          Chyby agentů ({ctData.agent_errors.length})
                        </div>
                        <div className="space-y-2">
                          {ctData.agent_errors.map((e, i) => (
                            <div key={i} className="rounded-xl border border-red-200 bg-red-50 px-4 py-3">
                              <div className="flex items-start justify-between gap-2">
                                <div className="flex-1">
                                  <div className="flex items-center gap-2 mb-1">
                                    <span className="text-[10px] font-bold uppercase text-red-700 bg-red-100 px-1.5 py-0.5 rounded">{e.typ}</span>
                                    <span className="text-[10px] text-gray-500 uppercase">{e.rezim}</span>
                                    {e.feedback_type && <span className="text-[9px] text-gray-400">{e.feedback_type}</span>}
                                    {e.faktura_id && <span className="text-[9px] text-blue-500">FKT #{e.faktura_id}</span>}
                                  </div>
                                  <div className="text-[12px] text-red-800 font-medium mb-1">{e.popis}</div>
                                  {e.korekce_popis && (
                                    <div className="text-[11px] text-gray-600 italic mb-2">Doporučená korekce: {e.korekce_popis}</div>
                                  )}
                                </div>
                                <div className="text-[10px] text-gray-400 shrink-0">
                                  {new Date(e.created_at).toLocaleDateString('cs-CZ')}
                                </div>
                              </div>
                              {e.feedback_type && e.feedback_type !== 'architecture_finding' && (
                                <button
                                  onClick={async () => {
                                    await fetch('/api/agent/learn', {
                                      method: 'POST',
                                      headers: { 'Content-Type': 'application/json' },
                                      body: JSON.stringify({
                                        feedback_type: e.feedback_type,
                                        poznamka: e.korekce_popis ?? e.popis,
                                        zdroj: 'agent',
                                        confidence: 75,
                                      }),
                                    })
                                    alert('Korekce odeslána do učícího systému.')
                                  }}
                                  className="mt-2 text-[11px] px-3 py-1 rounded-lg bg-white border border-red-300 text-red-700 hover:bg-red-100 font-medium"
                                >
                                  Potvrdit → učení
                                </button>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Strategic improvements */}
                    {strategic_improvements?.length > 0 && (
                      <div>
                        <div className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-2">Strategic Improvements</div>
                        <div className="space-y-2">
                          {strategic_improvements.map((s, i) => (
                            <div key={i} className="bg-blue-50 rounded-xl px-4 py-3">
                              <div className="flex items-center gap-2 mb-1">
                                <span className="text-[12px] font-semibold text-blue-800">{s.title}</span>
                                <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full ${s.priority === 'high' ? 'bg-red-100 text-red-700' : 'bg-gray-100 text-gray-500'}`}>{s.priority}</span>
                              </div>
                              <div className="text-[11px] text-blue-600">{s.description}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )
              })()}

              {/* ── ORCHESTRÁTOR TAB — Strategic Orchestrator ── */}
              {!ctLoading && ctTab === 'tasking' && (() => {
                const urgencyColor = (u: string) => u === 'critical' ? 'text-red-600 bg-red-50 border-red-200' : u === 'high' ? 'text-orange-600 bg-orange-50 border-orange-200' : u === 'medium' ? 'text-amber-600 bg-amber-50 border-amber-200' : 'text-green-600 bg-green-50 border-green-200'
                const urgencyDot = (u: string) => u === 'critical' ? 'bg-red-500' : u === 'high' ? 'bg-orange-500' : u === 'medium' ? 'bg-amber-400' : 'bg-green-500'
                const d = stratOrchData
                return (
                  <div className="px-5 py-5 space-y-4">
                    {/* Spustit panel */}
                    <div className="bg-gray-900 rounded-2xl px-5 py-4 flex items-center justify-between gap-4">
                      <div>
                        <div className="text-[13px] font-semibold text-white">Strategic Orchestrator</div>
                        <div className="text-[11px] text-gray-400 mt-0.5">Vyhodnotí stav systému, sestaví plán a spustí agenty</div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          onClick={() => runStrategicOrchestrator(true)}
                          disabled={stratOrchRunning}
                          className="text-[11px] px-3 py-1.5 rounded-lg border border-gray-600 text-gray-300 hover:bg-gray-800 disabled:opacity-40"
                        >
                          {stratOrchRunning ? '…' : 'Dry run'}
                        </button>
                        <button
                          onClick={() => runStrategicOrchestrator(false)}
                          disabled={stratOrchRunning}
                          className="text-[11px] px-4 py-1.5 rounded-lg bg-[#0071e3] hover:bg-[#0077ed] text-white font-medium disabled:opacity-40"
                        >
                          {stratOrchRunning ? 'Běží…' : 'Spustit'}
                        </button>
                      </div>
                    </div>

                    {stratOrchRunning && (
                      <div className="text-center py-8 text-[13px] text-gray-400 animate-pulse">Analyzuji systém a spouštím agenty…</div>
                    )}

                    {d && !stratOrchRunning && (
                      <>
                        {/* System health */}
                        <div className="flex items-center gap-3">
                          <div className={`text-[28px] font-bold leading-none ${d.system_health_pct >= 80 ? 'text-green-600' : d.system_health_pct >= 50 ? 'text-amber-600' : 'text-red-600'}`}>
                            {d.system_health_pct}%
                          </div>
                          <div>
                            <div className="text-[12px] font-medium text-gray-700">Zdraví systému</div>
                            <div className="text-[11px] text-gray-400">{d.summary}</div>
                          </div>
                          {d.dry_run && <span className="ml-auto text-[10px] px-2 py-0.5 rounded-full bg-gray-100 text-gray-500 font-medium">DRY RUN</span>}
                        </div>

                        {/* Strategic insight */}
                        {d.strategic_insight && (
                          <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-[12px] text-amber-800">
                            {d.strategic_insight}
                          </div>
                        )}

                        {/* Cíle */}
                        <div>
                          <div className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-2">Cíle systému</div>
                          <div className="space-y-1.5">
                            {d.goals.map(g => (
                              <div key={g.id} className={`flex items-center gap-3 rounded-xl px-3 py-2 border ${g.ok ? 'bg-green-50 border-green-200' : urgencyColor(g.urgency)}`}>
                                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${g.ok ? 'bg-green-500' : urgencyDot(g.urgency)}`} />
                                <span className={`flex-1 text-[11px] font-medium ${g.ok ? 'text-green-700' : ''}`}>{g.label}</span>
                                <span className="text-[10px] text-gray-500">{String(g.current)} → {g.target}</span>
                                {!g.ok && <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded ${urgencyColor(g.urgency)}`}>{g.urgency}</span>}
                                {g.ok && <span className="text-green-500 text-[12px]">✓</span>}
                              </div>
                            ))}
                          </div>
                        </div>

                        {/* Plán */}
                        {d.plan.length > 0 && (
                          <div>
                            <div className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-2">Plán ({d.plan.length} kroků)</div>
                            <div className="space-y-1.5">
                              {d.plan.map(step => {
                                const exec = d.execution.find(e => e.step === step.order)
                                return (
                                  <div key={step.order} className="flex items-start gap-3 bg-gray-50 rounded-xl px-3 py-2.5">
                                    <span className="text-[10px] font-bold text-gray-400 w-4 shrink-0 mt-0.5">{step.order}.</span>
                                    <div className="flex-1 min-w-0">
                                      <div className="text-[11px] font-medium text-gray-800">{step.task}</div>
                                      <div className="text-[10px] text-gray-400 mt-0.5">{step.why}</div>
                                    </div>
                                    <div className="shrink-0 text-right">
                                      <span className="text-[9px] uppercase font-bold text-gray-400">{step.owner}</span>
                                      {exec && (
                                        <div className={`text-[10px] mt-0.5 ${exec.ok ? 'text-green-600' : 'text-red-500'}`}>
                                          {exec.ok ? '✓' : '✗'} {exec.result}
                                        </div>
                                      )}
                                    </div>
                                  </div>
                                )
                              })}
                            </div>
                          </div>
                        )}

                        {d.plan.length === 0 && (
                          <div className="text-center py-6 text-[12px] text-green-600 bg-green-50 rounded-xl">
                            Všechny cíle splněny — systém funguje autonomně.
                          </div>
                        )}
                      </>
                    )}

                    {!d && !stratOrchRunning && (
                      <div className="text-center py-10 text-[12px] text-gray-400">
                        Spusť orchestrátor pro analýzu systému a automatické provedení plánovaných kroků.
                      </div>
                    )}
                  </div>
                )
              })()}

              {/* ── ABRA SYNC TAB ── */}
              {!ctLoading && ctTab === 'abra' && (
                <div className="px-5 py-5 space-y-5">

                  {/* Header + obnovit */}
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-[13px] font-semibold text-gray-800">ABRA sync</div>
                      <div className="text-[11px] text-gray-400 mt-0.5">Supabase = zdroj pravdy · ABRA = zákonný výstup · tolerance 0</div>
                    </div>
                    <div className="flex items-center gap-2">
                      {abraFixResult && (
                        <span className={`text-[11px] px-2 py-0.5 rounded-lg ${abraFixResult.includes('Chyby') ? 'bg-red-50 text-red-600' : 'bg-green-50 text-green-700'}`}>
                          {abraFixResult}
                        </span>
                      )}
                    </div>
                  </div>

                  {abraLoading && <div className="text-center py-10 text-[13px] text-gray-400 animate-pulse">Načítám z ABRA…</div>}

                  {!abraLoading && abraResult && (() => {
                    const allOk = abraResult.diff?.length === 0 && abraResult.onlySB?.length === 0 && abraResult.onlyABRA?.length === 0 &&
                      (!abraResult.banka || (abraResult.banka.sbBezBanky.length === 0 && abraResult.banka.abraBankaBezSB.length === 0))
                    return (
                      <div className="space-y-4">

                        {/* Stav přehled */}
                        <div className={`rounded-2xl px-4 py-3 text-[12px] flex flex-wrap gap-x-5 gap-y-1 ${allOk ? 'bg-green-50' : 'bg-red-50'}`}>
                          <span className={`font-bold ${allOk ? 'text-green-700' : 'text-red-700'}`}>
                            {allOk ? '✓ SB a ABRA jsou synchronizovány' : '✗ Nalezeny rozdíly — ABRA není synchronizována'}
                          </span>
                          <span className="text-gray-500">SB: <b>{abraResult.stats.sbTotal}</b> faktur</span>
                          <span className="text-gray-500">ABRA FP: <b>{abraResult.stats.abraTotal}</b></span>
                          <span className="text-gray-500">Spárováno: <b>{abraResult.stats.matched}</b></span>
                          {abraResult.stats.abraBankaTotal !== undefined && <span className="text-gray-500">Banka ABRA: <b>{abraResult.stats.abraBankaTotal}</b></span>}
                        </div>

                        {/* V SB, chybí v ABRA — KRITICKÉ */}
                        {abraResult.onlySB?.length > 0 && (
                          <div className="rounded-xl border border-red-300 bg-red-50 px-4 py-3">
                            <div className="flex items-center justify-between mb-2">
                              <div>
                                <div className="text-[11px] font-bold text-red-700 uppercase tracking-wider">Chybí v ABRA — zákonné riziko ({abraResult.onlySB.length})</div>
                                <div className="text-[10px] text-red-500 mt-0.5">Záznamy existují v SB, ale nejsou v ABRA → daňový a zákonný problém</div>
                              </div>
                              <button onClick={() => abraFix('create-in-abra-bulk')} disabled={abraFixing !== null}
                                className="text-[11px] px-3 py-1.5 rounded-lg bg-red-600 text-white font-medium hover:bg-red-700 disabled:opacity-40 whitespace-nowrap">
                                {abraFixing === 'create-in-abra-bulk' ? 'Vytvářím…' : `Synchronizovat vše (${abraResult.onlySB.length})`}
                              </button>
                            </div>
                            <div className="space-y-1">
                              {abraResult.onlySB.map(f => (
                                <div key={f.id} className="flex items-center justify-between bg-white/60 rounded-lg px-3 py-1.5">
                                  <div>
                                    <span className="text-[12px] font-medium text-gray-900">{f.dodavatel}</span>
                                    <span className="text-[11px] text-gray-400 ml-2">{f.cislo_faktury}</span>
                                  </div>
                                  <div className="flex items-center gap-2">
                                    <span className="text-[12px] font-medium text-gray-700">{fmt(f.castka_s_dph, f.mena)}</span>
                                    <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${f.stav === 'zaplacena' ? 'bg-green-100 text-green-700' : 'bg-blue-100 text-blue-700'}`}>{f.stav}</span>
                                    <button onClick={() => abraFix('create-in-abra', { sbId: f.id })} disabled={abraFixing !== null}
                                      className="text-[10px] px-2 py-0.5 rounded bg-red-100 text-red-700 hover:bg-red-200 disabled:opacity-40">Sync</button>
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Jen v ABRA — fantomové záznamy */}
                        {abraResult.onlyABRA?.length > 0 && (
                          <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3">
                            <div className="text-[11px] font-bold text-red-700 uppercase tracking-wider mb-1">Fantomové záznamy v ABRA ({abraResult.onlyABRA.length})</div>
                            <div className="text-[10px] text-red-500 mb-2">V ABRA existují FP záznamy bez odpovídajícího záznamu v SB → přebytek v účetnictví</div>
                            <div className="space-y-1">
                              {abraResult.onlyABRA.map(f => (
                                <div key={f.id} className="flex items-center justify-between bg-white/60 rounded-lg px-3 py-1.5">
                                  <div>
                                    <span className="text-[12px] text-gray-700">{f.firma}</span>
                                    <span className="text-[11px] text-gray-400 ml-2">{f.kod}</span>
                                  </div>
                                  <div className="flex items-center gap-2">
                                    <span className="text-[12px] font-medium text-gray-600">{fmt(f.sumCelkem, 'CZK')}</span>
                                    <button onClick={() => abraFix('delete-abra', { abraId: f.id })} disabled={abraFixing !== null}
                                      className="text-[10px] px-2 py-0.5 rounded bg-red-100 text-red-700 hover:bg-red-200 disabled:opacity-40">Smazat</button>
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Rozdílný stav */}
                        {abraResult.diff?.length > 0 && (
                          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
                            <div className="flex items-center justify-between mb-2">
                              <div>
                                <div className="text-[11px] font-bold text-amber-700 uppercase tracking-wider">Rozdílný stav SB vs ABRA ({abraResult.diff.length})</div>
                                <div className="text-[10px] text-amber-600 mt-0.5">
                                  {abraResult.stats.diffWithTransakce ?? 0} s transakcí · {abraResult.stats.diffWithoutTransakce ?? 0} bez transakce
                                </div>
                              </div>
                              <div className="flex gap-2">
                                {(abraResult.stats.diffWithTransakce ?? 0) > 0 && (
                                  <button onClick={() => abraFix('create-banka-bulk')} disabled={abraFixing !== null}
                                    className="text-[11px] px-3 py-1 rounded-lg bg-green-600 text-white font-medium hover:bg-green-700 disabled:opacity-40">
                                    {abraFixing === 'create-banka-bulk' ? 'Zaúčtovávám…' : `Zaúčtovat (${abraResult.stats.diffWithTransakce})`}
                                  </button>
                                )}
                                {(abraResult.stats.diffWithoutTransakce ?? 0) > 0 && (
                                  <button onClick={() => abraFix('fix-stav-bulk')} disabled={abraFixing !== null}
                                    className="text-[11px] px-3 py-1 rounded-lg bg-amber-600 text-white font-medium hover:bg-amber-700 disabled:opacity-40">
                                    {abraFixing === 'fix-stav-bulk' ? 'Opravuji…' : `Ručně (${abraResult.stats.diffWithoutTransakce})`}
                                  </button>
                                )}
                              </div>
                            </div>
                            <div className="space-y-1">
                              {abraResult.diff.map(d => {
                                const hasTrans = 'transakce' in d && d.transakce != null
                                return (
                                  <div key={d.sb.id} className="flex items-center justify-between bg-white/60 rounded-lg px-3 py-1.5">
                                    <div>
                                      <span className="text-[12px] font-medium text-gray-900">{d.sb.dodavatel}</span>
                                      <span className="text-[10px] text-gray-400 ml-2">{d.sb.cislo_faktury} · {d.abra.kod}</span>
                                    </div>
                                    <div className="flex items-center gap-2">
                                      <span className="text-[11px] px-1.5 py-0.5 rounded-full bg-green-100 text-green-700">SB: {d.sb.stav}</span>
                                      <span className="text-[11px] px-1.5 py-0.5 rounded-full bg-red-100 text-red-700">ABRA: {d.abraStav}</span>
                                      {hasTrans
                                        ? <button onClick={() => abraFix('create-banka', { sbId: d.sb.id, abraId: d.abra.id, transakceId: (d as {transakce: {id: number}}).transakce.id })} disabled={abraFixing !== null}
                                            className="text-[10px] px-2 py-0.5 rounded bg-green-100 text-green-700 hover:bg-green-200 disabled:opacity-40">Zaúčtovat</button>
                                        : <button onClick={() => abraFix('fix-stav', { abraId: d.abra.id })} disabled={abraFixing !== null}
                                            className="text-[10px] px-2 py-0.5 rounded bg-amber-100 text-amber-700 hover:bg-amber-200 disabled:opacity-40">Ručně</button>
                                      }
                                    </div>
                                  </div>
                                )
                              })}
                            </div>
                          </div>
                        )}

                        {/* Banka diff */}
                        {abraResult.banka && (abraResult.banka.sbBezBanky.length > 0 || abraResult.banka.abraBankaBezSB.length > 0) && (
                          <div className="rounded-xl border border-gray-200 bg-gray-50 px-4 py-3">
                            <div className="text-[11px] font-bold text-gray-600 uppercase tracking-wider mb-2">
                              Banka doklady · SB spárované: {abraResult.stats.sbSparovaneTotal} · ABRA: {abraResult.stats.abraBankaTotal}
                            </div>
                            {abraResult.banka.sbBezBanky.length > 0 && (
                              <div className="mb-3">
                                <div className="text-[10px] font-semibold text-amber-700 uppercase mb-1">Spárováno v SB, chybí banka doklad v ABRA ({abraResult.banka.sbBezBanky.length})</div>
                                {abraResult.banka.sbBezBanky.map(b => (
                                  <div key={b.sbId} className="flex items-center justify-between bg-white/70 rounded-lg px-3 py-1.5 mb-1">
                                    <span className="text-[12px] text-gray-800">{b.dodavatel}</span>
                                    <div className="flex items-center gap-2">
                                      <span className="text-[11px] text-gray-600">{fmt(b.castka, b.mena)}</span>
                                      <button onClick={() => abraFix('create-banka', { sbId: b.sbId, abraId: abraResult!.diff.find(d => d.sb.id === b.sbId)?.abra.id ?? '', transakceId: 0 })} disabled={abraFixing !== null}
                                        className="text-[10px] px-2 py-0.5 rounded bg-amber-100 text-amber-700 hover:bg-amber-200 disabled:opacity-40">Sync</button>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            )}
                            {abraResult.banka.abraBankaBezSB.length > 0 && (
                              <div>
                                <div className="text-[10px] font-semibold text-gray-500 uppercase mb-1">V ABRA bez SB transakce ({abraResult.banka.abraBankaBezSB.length})</div>
                                {abraResult.banka.abraBankaBezSB.map(b => (
                                  <div key={b.id} className="flex items-center justify-between bg-white/70 rounded-lg px-3 py-1.5 mb-1">
                                    <span className="text-[12px] text-gray-600">{b.popis}</span>
                                    <span className="text-[11px] text-gray-500">{fmt(b.sumOsv, 'CZK')} · {fmtDate(b.datVyst)}</span>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        )}

                        {/* Audit Model B */}
                        <div className="border-t border-gray-100 pt-4">
                          <div className="flex items-center gap-3 mb-3">
                            <button onClick={loadAuditFull} disabled={auditFullLoading}
                              className="text-[11px] px-3 py-1.5 rounded-lg bg-[#0071e3] text-white font-medium hover:bg-[#0077ed] disabled:opacity-50">
                              {auditFullLoading ? 'Audituji…' : 'Spustit hloubkový audit'}
                            </button>
                            {auditFullResult && (
                              <span className={`text-[11px] px-2 py-0.5 rounded-lg font-medium ${!(auditFullResult.data.shoda.faktury_ok && auditFullResult.data.shoda.banka_ok) ? 'bg-red-50 text-red-600' : 'bg-green-50 text-green-700'}`}>
                                {!(auditFullResult.data.shoda.faktury_ok && auditFullResult.data.shoda.banka_ok)
                                  ? `rozdíl banka ${auditFullResult.data.shoda.banka_diff}, faktury ${auditFullResult.data.shoda.faktury_diff}`
                                  : '✓ Hloubkový audit OK'}
                              </span>
                            )}
                          </div>
                          {auditFullResult && !auditFullResult.data.shoda.faktury_ok || auditFullResult && !auditFullResult.data.shoda.banka_ok ? (
                            <div className="space-y-2">
                              {auditFullResult!.data.rozdily.chybejici_v_abra.length > 0 && (
                                <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2">
                                  <div className="text-[10px] font-bold text-red-700 uppercase mb-1">Chybí v ABRA ({auditFullResult!.data.rozdily.chybejici_v_abra.length})</div>
                                  {auditFullResult!.data.rozdily.chybejici_v_abra.map(f => (
                                    <div key={f.id} className="text-[11px] text-red-800">{f.dodavatel} · {f.castka.toLocaleString('cs-CZ')} Kč · {f.ocekavany_kod}</div>
                                  ))}
                                  <button onClick={() => abraFix('create-in-abra-bulk')} disabled={abraFixing !== null}
                                    className="mt-2 text-[10px] px-2.5 py-1 rounded bg-red-600 text-white hover:bg-red-700 disabled:opacity-40">
                                    Synchronizovat do ABRA
                                  </button>
                                </div>
                              )}
                              {auditFullResult!.data.rozdily['osirelé_v_abra'].length > 0 && (
                                <div className="rounded-lg bg-orange-50 border border-orange-200 px-3 py-2">
                                  <div className="text-[10px] font-bold text-orange-700 uppercase mb-1">Osiřelé v ABRA ({auditFullResult!.data.rozdily['osirelé_v_abra'].length})</div>
                                  {auditFullResult!.data.rozdily['osirelé_v_abra'].map(kod => (
                                    <div key={kod} className="text-[11px] text-orange-800">{kod}</div>
                                  ))}
                                </div>
                              )}
                            </div>
                          ) : auditFullResult ? (
                            <div className="text-[12px] text-green-600">✓ Hloubkový audit: SB a ABRA jsou synchronizovány</div>
                          ) : null}
                        </div>

                        {allOk && (
                          <div className="text-center py-6 text-[13px] text-green-600 font-medium">✓ Supabase a ABRA jsou plně synchronizovány</div>
                        )}
                      </div>
                    )
                  })()}

                  {!abraLoading && !abraResult && (
                    <div className="text-center py-10">
                      <button onClick={loadAbraReconcile} className="text-[13px] px-4 py-2 rounded-xl bg-[#0071e3] text-white hover:bg-[#0077ed]">
                        Načíst ABRA sync
                      </button>
                    </div>
                  )}
                </div>
              )}

              {/* ── PM AGENT TAB ── */}
              {!ctLoading && ctTab === 'agent' && (
                <div className="flex flex-col h-full">
                  <div className="flex-1 overflow-y-auto px-5 py-4 space-y-2">
                    {agentLog.length === 0 && !agentRunning && (
                      <div className="text-[13px] text-gray-400 text-center py-8">Agent ještě nebyl spuštěn.</div>
                    )}
                    {agentLog.length === 0 && agentRunning && (
                      <div className="text-[13px] text-gray-400 animate-pulse">Analyzuji backlog…</div>
                    )}
                    {agentLog.map((entry, i) => (
                      <div key={i} className={`flex gap-2 text-[13px] ${
                        entry.type === 'action' ? 'text-green-700' :
                        entry.type === 'warn' ? 'text-orange-600' : 'text-gray-500'
                      }`}>
                        <span className="shrink-0 mt-0.5">{entry.type === 'action' ? '✓' : entry.type === 'warn' ? '⚠' : '·'}</span>
                        <span>{entry.text}</span>
                      </div>
                    ))}
                    {agentQuestion && (
                      <div className="mt-4 bg-blue-50 border border-blue-200 rounded-xl p-4">
                        <div className="text-[11px] font-semibold text-blue-500 uppercase tracking-wider mb-1">Potřebuji vaši odpověď</div>
                        <div className="text-[13px] font-medium text-gray-800 mb-1">{agentQuestion.otazka}</div>
                        <div className="text-[12px] text-gray-500 mb-3">{agentQuestion.kontext}</div>
                        {agentQuestion.moznosti.length > 0 ? (
                          <div className="flex flex-wrap gap-2 mb-3">
                            {agentQuestion.moznosti.map((m, i) => (
                              <button key={i} onClick={() => setAgentAnswer(m)}
                                className={`px-3 py-1 rounded-lg text-[12px] font-medium border transition-colors ${agentAnswer === m ? 'bg-blue-600 text-white border-blue-600' : 'border-gray-200 text-gray-700 hover:bg-gray-50'}`}>
                                {m}
                              </button>
                            ))}
                          </div>
                        ) : (
                          <textarea value={agentAnswer} onChange={e => setAgentAnswer(e.target.value)}
                            placeholder="Vaše odpověď…" rows={2}
                            className="w-full text-[13px] border border-gray-200 rounded-lg px-3 py-2 mb-3 focus:outline-none focus:border-blue-300 resize-none" />
                        )}
                        <button onClick={() => { if (!agentAnswer.trim()) return; const ans = agentAnswer; setAgentAnswer(''); runAgent(agentQuestion!.messages, agentQuestion!.tool_use_id, ans) }}
                          disabled={!agentAnswer.trim() || agentRunning}
                          className="w-full py-2 bg-blue-600 text-white rounded-lg text-[13px] font-medium hover:bg-blue-700 disabled:opacity-50">
                          Odpovědět
                        </button>
                      </div>
                    )}
                    {agentSummary && (
                      <div className="mt-4 bg-green-50 border border-green-200 rounded-xl p-4">
                        <div className="text-[11px] font-semibold text-green-600 uppercase tracking-wider mb-1">Hotovo</div>
                        <div className="text-[13px] text-gray-700">{agentSummary}</div>
                      </div>
                    )}
                    {agentRunning && agentLog.length > 0 && (
                      <div className="text-[12px] text-gray-400 animate-pulse">Zpracovávám…</div>
                    )}
                  </div>
                  <div className="px-5 py-4 border-t border-gray-100 shrink-0">
                    <button onClick={() => runAgent()} disabled={agentRunning}
                      className="w-full py-2.5 bg-[#0071e3] text-white rounded-xl text-[13px] font-medium hover:bg-[#0077ed] disabled:opacity-50">
                      {agentRunning ? 'Agent pracuje…' : agentSummary ? 'Spustit znovu' : 'Spustit PM Agenta'}
                    </button>
                  </div>
                </div>
              )}

              {/* Empty state */}
              {!ctLoading && ctTab !== 'agent' && !ctData && (
                <div className="flex flex-col items-center justify-center h-full gap-3 px-6">
                  <div className="text-[13px] text-gray-400 text-center">Dashboard ještě nebyl načten.</div>
                  <button onClick={loadControlTower} className="px-4 py-2 bg-[#0071e3] text-white rounded-xl text-[12px] font-medium">
                    Analyzovat systém
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
