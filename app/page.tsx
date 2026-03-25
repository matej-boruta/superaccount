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

type Tab = 'nova' | 'schvalena' | 'zaplacena' | 'zamitnuta' | 'vse' | 'sparovane' | 'nesparovane' | 'vydane' | 'pravidla' | 'abra'

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
  { key: 'pravidla' as Tab, label: 'Pravidla dodavatelů' },
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
      const res2 = await fetch('/api/transakce')
      setTransakce(await res2.json())
    }
  }

  useEffect(() => {
    load()
    // Background ABRA sync — fire and forget, catches any gaps from previous sessions
    fetch('/api/abra-sync', { method: 'POST' }).catch(() => {})
  }, [])

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
  const filtered = (() => {
    const base = tab === 'vse' ? faktury : isTransakceTab ? [] : faktury.filter(f => f.stav === tab)
    if (tab === 'zaplacena' && dodavatelSearch.trim()) {
      const q = dodavatelSearch.trim().toLowerCase()
      return base.filter(f => {
        const kat = kategorieList.find(k => k.id === (kategorieOverride.get(f.id) ?? f.kategorie_id))
        const katStr = kat ? `${kat.l1} ${kat.l2}`.toLowerCase() : ''
        const castkaStr = String(f.castka_s_dph)
        return (
          f.dodavatel.toLowerCase().includes(q) ||
          (f.cislo_faktury || '').toLowerCase().includes(q) ||
          (f.variabilni_symbol || '').toLowerCase().includes(q) ||
          katStr.includes(q) ||
          castkaStr.includes(q)
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

  const loadVydane = async () => {
    setVydaneLoading(true)
    const res = await fetch('/api/vydane')
    const data = await res.json()
    if (Array.isArray(data)) setVydane(data)
    setVydaneLoading(false)
  }

  useEffect(() => {
    if (tab === 'vydane') loadVydane()
    if (tab === 'abra') loadAbraReconcile()
  }, [tab])

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
          <span className="text-[15px] font-semibold text-gray-900 tracking-tight">SuperAccount</span>
          <div className="flex items-center gap-3">
            {classifying && (
              <span className="text-[12px] text-gray-400 animate-pulse">Klasifikuji kategorie…</span>
            )}
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

        {/* ── Sticky tabs ── */}
        <div className="sticky top-[52px] z-10 bg-white/90 backdrop-blur-xl border-b border-black/[0.06] -mx-6 px-6 py-2 mb-5 flex items-center justify-between">
              <div className="flex gap-0.5 bg-black/[0.05] p-1 rounded-xl overflow-x-auto max-w-full">
                {TABS.map(t => {
                  const cnt = t.key === 'sparovane' ? transakce.filter(tx => tx.stav === 'sparovano').length
                    : t.key === 'nesparovane' ? transakce.filter(tx => tx.stav === 'nesparovano').length
                    : t.key === 'vydane' ? vydane.length || null
                    : t.key === 'vse' || t.key === 'pravidla' || t.key === 'abra' ? null
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

        {tab !== 'pravidla' && tab !== 'vydane' && tab !== 'abra' && (<>
            {/* Filtr dodavatele pro zaplacené */}
            {tab === 'zaplacena' && (
              <div className="mb-4 flex items-center gap-2">
                <input
                  type="text"
                  placeholder="Hledat dodavatele, fakturu, VS, kategorii, částku…"
                  value={dodavatelSearch}
                  onChange={e => setDodavatelSearch(e.target.value)}
                  className="w-64 px-3 py-2 text-[13px] rounded-xl border border-black/[0.1] bg-white outline-none focus:border-[#0071e3] placeholder:text-gray-400"
                />
                {dodavatelSearch && (
                  <button onClick={() => setDodavatelSearch('')} className="text-[12px] text-gray-400 hover:text-gray-600">Zrušit</button>
                )}
                <span className="text-[12px] text-gray-400">{filteredSorted.length} faktur</span>
              </div>
            )}

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
                      const suggestion = f.stav === 'schvalena' ? findMatch(f, transakce) : null
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
                              <div className={`text-[13px] font-medium ${isSchvalena ? 'text-gray-400' : 'text-gray-900'}`}>{f.dodavatel}</div>
                            </div>
                            <div className="text-[11px] text-gray-400">IČO {f.ico}</div>
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

        {tab === 'pravidla' && (
          <div className="bg-white rounded-2xl shadow-sm border border-black/[0.06] overflow-clip">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-100">
                <tr>
                  <th className="px-5 py-3 text-left text-[11px] font-semibold text-gray-400 uppercase tracking-wide">Dodavatel</th>
                  <th className="px-5 py-3 text-left text-[11px] font-semibold text-gray-400 uppercase tracking-wide">Typ platby</th>
                  <th className="px-5 py-3 text-center text-[11px] font-semibold text-gray-400 uppercase tracking-wide">Auto párovat</th>
                  <th className="px-5 py-3 text-left text-[11px] font-semibold text-gray-400 uppercase tracking-wide w-1/2">Pravidla zaúčtování</th>
                </tr>
              </thead>
              <tbody>
                {allSuppliers.map((p, i) => (
                    <tr key={p.id} className={`border-b border-gray-50 hover:bg-gray-50/50 ${p._synthetic ? 'opacity-60' : ''}`}>
                      <td className="px-5 py-3">
                        <div className={`text-[13px] font-medium text-gray-900 ${p._synthetic ? '' : 'font-mono'}`}>{p.dodavatel_pattern}</div>
                        {p.ico && <div className="text-[11px] text-gray-400 mt-0.5">IČO {p.ico}</div>}
                        {p._synthetic && <div className="text-[10px] text-orange-500 mt-0.5">bez pravidla</div>}
                      </td>
                      <td className="px-5 py-3">
                        {p.typ_platby ? (
                          <span className={`inline-flex px-2 py-0.5 rounded-full text-[11px] font-medium ${
                            p.typ_platby === 'karta' ? 'bg-blue-50 text-blue-700' :
                            p.typ_platby === 'prevod' ? 'bg-purple-50 text-purple-700' :
                            'bg-gray-100 text-gray-500'
                          }`}>{p.typ_platby}</span>
                        ) : <span className="text-gray-300">—</span>}
                      </td>
                      <td className="px-5 py-3 text-center">
                        {!p._synthetic ? (
                          <button
                            onClick={() => togglePravidlo(p.id, 'auto_parovat', !p.auto_parovat)}
                            className={`w-10 h-5 rounded-full transition-colors relative ${p.auto_parovat ? 'bg-green-500' : 'bg-gray-200'}`}
                          >
                            <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${p.auto_parovat ? 'translate-x-5' : 'translate-x-0.5'}`} />
                          </button>
                        ) : <span className="text-gray-300">—</span>}
                      </td>
                      <td className="px-5 py-3">{renderPravidloText(p.poznamka ?? null)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
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
          </div>
        )}

      </main>
    </div>
  )
}
