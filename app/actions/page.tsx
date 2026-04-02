'use client'

import { useEffect, useState } from 'react'

type ActionItem = {
  id: string
  priority: 'high' | 'medium' | 'low'
  type: 'missing_document' | 'unmatched_transaction' | 'low_confidence' | 'new_supplier'
  title: string
  impact: string
  suggestion: string
  data: Record<string, unknown>
}

const PRIORITY_COLOR = {
  high: 'bg-red-50 border-red-200',
  medium: 'bg-amber-50 border-amber-200',
  low: 'bg-gray-50 border-gray-200',
}

const PRIORITY_BADGE = {
  high: 'bg-red-100 text-red-700',
  medium: 'bg-amber-100 text-amber-700',
  low: 'bg-gray-100 text-gray-600',
}

const TYPE_LABEL: Record<string, string> = {
  missing_document: 'Chybí doklad',
  unmatched_transaction: 'Nespárovaná platba',
  low_confidence: 'Nízká confidence',
  new_supplier: 'Nový dodavatel',
}

export default function ActionsPage() {
  const [items, setItems] = useState<ActionItem[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<'all' | 'high' | 'medium'>('all')

  useEffect(() => {
    const year = new Date().getFullYear()
    const SB_URL = process.env.NEXT_PUBLIC_SUPABASE_URL

    async function load() {
      setLoading(true)
      try {
        const actions: ActionItem[] = []

        // Faktury bez kategorie
        const bezKatRes = await fetch(`/api/faktury?stav=nova&bez_kategorie=1&year=${year}`)
        const bezKat = await bezKatRes.json().catch(() => [])
        if (Array.isArray(bezKat)) {
          bezKat.slice(0, 10).forEach((f: Record<string, unknown>) => {
            actions.push({
              id: `bez_kat_${f.id}`,
              priority: 'high',
              type: 'new_supplier',
              title: `${f.dodavatel} — bez kategorie`,
              impact: `Faktura ${f.castka_s_dph} ${f.mena} nelze zaúčtovat`,
              suggestion: 'Přiřadit kategorii nebo vytvořit pravidlo',
              data: f,
            })
          })
        }

        // Nespárované transakce (odchozí)
        const txRes = await fetch(`/api/transakce?stav=nesparovano&year=${year}`)
        const tx = await txRes.json().catch(() => [])
        if (Array.isArray(tx)) {
          tx.filter((t: Record<string, unknown>) => Number(t.castka) < 0).slice(0, 10).forEach((t: Record<string, unknown>) => {
            actions.push({
              id: `unmatched_${t.id}`,
              priority: Math.abs(Number(t.castka)) > 50000 ? 'high' : 'medium',
              type: 'unmatched_transaction',
              title: `Nespárovaná platba ${Math.abs(Number(t.castka)).toLocaleString('cs')} Kč`,
              impact: `${t.zprava ?? 'bez zprávy'} · ${t.datum}`,
              suggestion: 'Najít fakturu nebo vysvětlit platbu',
              data: t,
            })
          })
        }

        // Seřadit: high → medium → low
        actions.sort((a, b) => {
          const order = { high: 0, medium: 1, low: 2 }
          return order[a.priority] - order[b.priority]
        })

        setItems(actions)
      } catch { /* silent */ }
      setLoading(false)
    }

    load()
  }, [])

  const filtered = filter === 'all' ? items : items.filter(i => i.priority === filter)
  const highCount = items.filter(i => i.priority === 'high').length
  const medCount = items.filter(i => i.priority === 'medium').length

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="sticky top-0 z-10 bg-white border-b border-gray-100 px-6 py-3 flex items-center justify-between">
        <div>
          <div className="text-[15px] font-semibold text-gray-900">Action Center</div>
          <div className="text-[11px] text-gray-400 mt-0.5">Vyžaduje tvoji pozornost</div>
        </div>
        <div className="flex items-center gap-2">
          {(['all', 'high', 'medium'] as const).map(f => (
            <button key={f} onClick={() => setFilter(f)}
              className={`text-[11px] px-3 py-1 rounded-lg font-medium transition-colors ${filter === f ? 'bg-[#0071e3] text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
              {f === 'all' ? `Vše (${items.length})` : f === 'high' ? `Urgentní (${highCount})` : `Zvážit (${medCount})`}
            </button>
          ))}
        </div>
      </div>

      <div className="p-6 max-w-3xl space-y-3">
        {loading && <div className="text-center py-16 text-[13px] text-gray-400 animate-pulse">Načítám akce…</div>}

        {!loading && filtered.length === 0 && (
          <div className="text-center py-16 text-[13px] text-green-600 bg-green-50 rounded-2xl border border-green-200">
            Žádné akce k řešení
          </div>
        )}

        {!loading && filtered.map(item => (
          <div key={item.id} className={`rounded-2xl border px-5 py-4 ${PRIORITY_COLOR[item.priority]}`}>
            <div className="flex items-start justify-between gap-3 mb-2">
              <div className="flex items-center gap-2">
                <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded ${PRIORITY_BADGE[item.priority]}`}>{item.priority}</span>
                <span className="text-[10px] text-gray-500 font-medium">{TYPE_LABEL[item.type]}</span>
              </div>
            </div>
            <div className="text-[13px] font-semibold text-gray-900 mb-1">{item.title}</div>
            <div className="text-[11px] text-gray-500 mb-1">
              <span className="font-medium text-gray-600">Dopad:</span> {item.impact}
            </div>
            <div className="text-[11px] text-gray-500">
              <span className="font-medium text-gray-600">AI navrhuje:</span> {item.suggestion}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
