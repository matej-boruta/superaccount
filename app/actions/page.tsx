'use client'

import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'

// ── Types ─────────────────────────────────────────────────────────────────────

type Category = 'blocking' | 'needs_decision' | 'system'
type Owner = 'ACCOUNTANT' | 'PM' | 'ARCHITECT' | 'SYSTEM'

type ActionDef = {
  label: string
  primary?: boolean
  href?: string
  api?: { url: string; method?: string; body?: Record<string, unknown> }
  dismiss?: boolean
}

type ActionItem = {
  id: string
  category: Category
  severity: 'high' | 'medium' | 'low'
  type: string
  owner: Owner
  title: string
  subtitle: string
  amount: string
  detail: string   // one-line detail shown on expand
  status: 'pending' | 'running' | 'done'
  actions: ActionDef[]
}

type DismissEntry = { id: string; reason: string; ts: string }

// ── Constants ─────────────────────────────────────────────────────────────────

const CATEGORY_CFG: Record<Category, { label: string; color: string; dot: string; border: string }> = {
  blocking:       { label: 'Blokuje systém',  color: 'text-red-600',   dot: 'bg-red-500',   border: 'border-red-100'   },
  needs_decision: { label: 'Needs decision',  color: 'text-amber-600', dot: 'bg-amber-400', border: 'border-amber-100' },
  system:         { label: 'System',          color: 'text-blue-600',  dot: 'bg-blue-400',  border: 'border-blue-100'  },
}

const OWNER_COLOR: Record<Owner, string> = {
  ACCOUNTANT: 'bg-blue-50 text-blue-700',
  PM:         'bg-green-50 text-green-700',
  ARCHITECT:  'bg-amber-50 text-amber-700',
  SYSTEM:     'bg-gray-100 text-gray-500',
}

const DISMISS_REASONS = ['Vyřešeno ručně', 'Faktura neexistuje', 'Jiný rok / period', 'Ignorovat']

const DISMISSED_KEY = 'action_center_dismissed_v3'

function getDismissed(): Map<string, DismissEntry> {
  if (typeof window === 'undefined') return new Map()
  try {
    const arr: DismissEntry[] = JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? '[]')
    return new Map(arr.map(e => [e.id, e]))
  } catch { return new Map() }
}

function saveDismissEntry(entry: DismissEntry) {
  const map = getDismissed()
  map.set(entry.id, entry)
  localStorage.setItem(DISMISSED_KEY, JSON.stringify([...map.values()]))
}

// ── Main ──────────────────────────────────────────────────────────────────────

export default function ActionsPage() {
  const year = 2026
  const [items, setItems]         = useState<ActionItem[]>([])
  const [loading, setLoading]     = useState(true)
  const [runningIds, setRunning]  = useState<Set<string>>(new Set())
  const [doneIds, setDone]        = useState<Set<string>>(new Set())
  const [expanded, setExpanded]   = useState<string | null>(null)
  const [dismissingId, setDismissingId] = useState<string | null>(null)
  const [category, setCategory]   = useState<'all' | Category>('all')

  const load = useCallback(async () => {
    setLoading(true)
    const dismissed = getDismissed()

    try {
      const [fRes, txRes] = await Promise.all([
        fetch(`/api/faktury?rok=${year}`),
        fetch(`/api/transakce?rok=${year}`),
      ])
      const fAll: Record<string, unknown>[] = await fRes.json().catch(() => [])
      const txAll: Record<string, unknown>[] = await txRes.json().catch(() => [])

      const faktury   = Array.isArray(fAll) ? fAll : []
      const transakce = Array.isArray(txAll) ? txAll : []

      const result: ActionItem[] = []

      // ── 1. Nespárované transakce > 50k → BLOCKING ──────────────────────────
      const nespar = transakce.filter(t => t.stav === 'nesparovano' && Number(t.castka) < 0)
      const bigTx  = nespar.filter(t => Math.abs(Number(t.castka)) > 50000)
      const smallTx = nespar.filter(t => Math.abs(Number(t.castka)) <= 50000)

      bigTx.slice(0, 8).forEach(t => {
        const id = `unmatched_${t.id}`
        if (dismissed.has(id)) return
        const castka = Math.abs(Number(t.castka))
        result.push({
          id,
          category: 'blocking',
          severity: 'high',
          type: 'Nespárovaná platba',
          owner: 'PM',
          title: String(t.zprava ?? t.popis ?? '').slice(0, 55) || String(t.datum ?? ''),
          subtitle: String(t.datum ?? '').slice(0, 10),
          amount: castka.toLocaleString('cs-CZ') + ' Kč',
          detail: 'Peníze odešly bez odpovídající faktury → chybí v účetnictví. Pravděpodobná příčina: jiný VS nebo faktura nebyla importována.',
          status: 'pending',
          actions: [
            { label: 'Auto-párování', primary: true, api: { url: '/api/auto-parovani', method: 'POST', body: { year } } },
            { label: 'Ručně', href: '/workspaces/parovani' },
          ],
        })
      })

      // ── 2. NEEDS_INFO faktury → BLOCKING ────────────────────────────────────
      const needsInfo = faktury.filter(f => f.stav_workflow === 'NEEDS_INFO')
      needsInfo.slice(0, 8).forEach(f => {
        const id = `needs_info_${f.id}`
        if (dismissed.has(id)) return
        result.push({
          id,
          category: 'blocking',
          severity: 'high',
          type: 'Blokovaná faktura',
          owner: 'ACCOUNTANT',
          title: String(f.dodavatel ?? ''),
          subtitle: String(f.cislo_faktury ?? f.variabilni_symbol ?? ''),
          amount: Number(f.castka_s_dph ?? 0).toLocaleString('cs-CZ') + ' ' + String(f.mena ?? 'CZK'),
          detail: String(f.blocker ?? 'Chybí informace — nelze zaúčtovat. Přiřaď kategorii nebo vyřeš blocker.'),
          status: 'pending',
          actions: [
            { label: 'Přiřadit kategorii', primary: true, href: '/workspaces/accountant' },
          ],
        })
      })

      // ── 3. Bez kategorie — seskupit po dodavateli → NEEDS DECISION ──────────
      const bezKat = faktury.filter(f => f.stav === 'nova' && !f.kategorie_id && f.stav_workflow !== 'NEEDS_INFO')
      const byDodavatel: Record<string, Record<string, unknown>[]> = {}
      for (const f of bezKat) {
        const key = String(f.dodavatel ?? 'Neznámý')
        if (!byDodavatel[key]) byDodavatel[key] = []
        byDodavatel[key].push(f)
      }

      Object.entries(byDodavatel)
        .sort(([, a], [, b]) => b.length - a.length)
        .slice(0, 12)
        .forEach(([dodavatel, fkts]) => {
          const id = `bez_kat_${dodavatel.replace(/\s+/g, '_').toLowerCase()}`
          if (dismissed.has(id)) return
          const total = fkts.reduce((s, f) => s + Math.abs(Number(f.castka_s_dph ?? 0)), 0)
          const mena  = String(fkts[0]?.mena ?? 'CZK')
          const count = fkts.length
          result.push({
            id,
            category: 'needs_decision',
            severity: count > 2 ? 'high' : 'medium',
            type: 'Bez kategorie',
            owner: 'ACCOUNTANT',
            title: dodavatel,
            subtitle: `${count} ${count === 1 ? 'faktura' : count < 5 ? 'faktury' : 'faktur'}`,
            amount: total.toLocaleString('cs-CZ') + ' ' + mena,
            detail: 'Chybí pravidlo pro tohoto dodavatele. Accountant se pokusí přiřadit kategorii automaticky, jinak ručně.',
            status: 'pending',
            actions: [
              { label: 'Spustit Accountanta', primary: true, api: { url: '/api/agent/accountant', method: 'POST', body: { year } } },
              { label: 'Ručně', href: '/workspaces/accountant' },
            ],
          })
        })

      // ── 4. Menší nespárované TX → NEEDS DECISION ───────────────────────────
      if (smallTx.length > 0) {
        const id = 'unmatched_small_group'
        if (!dismissed.has(id)) {
          const totalSmall = smallTx.reduce((s, t) => s + Math.abs(Number(t.castka)), 0)
          result.push({
            id,
            category: 'needs_decision',
            severity: 'medium',
            type: 'Nespárované platby',
            owner: 'PM',
            title: `${smallTx.length} plateb bez faktury`,
            subtitle: 'do 50 000 Kč',
            amount: totalSmall.toLocaleString('cs-CZ') + ' Kč',
            detail: 'Menší platby bez párování — neúplný cash flow report. Auto-párování může najít shody.',
            status: 'pending',
            actions: [
              { label: 'Auto-párování', primary: true, api: { url: '/api/auto-parovani', method: 'POST', body: { year } } },
              { label: 'Ručně', href: '/workspaces/parovani' },
            ],
          })
        }
      }

      // ── 5. Chybějící pravidla dodavatelů → SYSTEM ──────────────────────────
      const uniqueSuppliers = Object.keys(byDodavatel)
      if (uniqueSuppliers.length > 3) {
        const id = 'missing_rules_group'
        if (!dismissed.has(id)) {
          result.push({
            id,
            category: 'system',
            severity: 'low',
            type: 'Chybějící pravidla',
            owner: 'ARCHITECT',
            title: `${uniqueSuppliers.length} dodavatelů bez pravidla`,
            subtitle: 'Zlepší automatizaci',
            amount: '',
            detail: 'Nové faktury od těchto dodavatelů budou opakovaně bez kategorie. Accountant vytvoří pravidla ze vzorů.',
            status: 'pending',
            actions: [
              { label: 'Vytvořit pravidla', primary: true, api: { url: '/api/agent/accountant', method: 'POST', body: { year } } },
            ],
          })
        }
      }

      const catOrder: Record<Category, number> = { blocking: 0, needs_decision: 1, system: 2 }
      const sevOrder = { high: 0, medium: 1, low: 2 }
      result.sort((a, b) => catOrder[a.category] - catOrder[b.category] || sevOrder[a.severity] - sevOrder[b.severity])

      setItems(result)
    } catch { /* silent */ }
    setLoading(false)
  }, [year])

  useEffect(() => { load() }, [load])

  // ── Action handler ──────────────────────────────────────────────────────────

  const runAction = async (item: ActionItem, action: ActionDef) => {
    if (action.href) return

    if (action.api) {
      setRunning(prev => new Set(prev).add(item.id))
      try {
        await fetch(action.api.url, {
          method: action.api.method ?? 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(action.api.body ?? {}),
        })
        setDone(prev => new Set(prev).add(item.id))
        setTimeout(() => {
          setDone(prev => { const s = new Set(prev); s.delete(item.id); return s })
          load()
        }, 2000)
      } catch { /* silent */ }
      setRunning(prev => { const s = new Set(prev); s.delete(item.id); return s })
    }
  }

  const dismiss = (id: string, reason: string) => {
    saveDismissEntry({ id, reason, ts: new Date().toISOString() })
    setItems(prev => prev.filter(i => i.id !== id))
    setDismissingId(null)
  }

  // ── Counts & filters ────────────────────────────────────────────────────────

  const counts: Record<Category, number> = {
    blocking:       items.filter(i => i.category === 'blocking').length,
    needs_decision: items.filter(i => i.category === 'needs_decision').length,
    system:         items.filter(i => i.category === 'system').length,
  }

  const filtered = category === 'all' ? items : items.filter(i => i.category === category)
  const grouped: Partial<Record<Category, ActionItem[]>> = {
    blocking:       filtered.filter(i => i.category === 'blocking'),
    needs_decision: filtered.filter(i => i.category === 'needs_decision'),
    system:         filtered.filter(i => i.category === 'system'),
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="sticky top-0 z-20 bg-white border-b border-gray-100 px-6 py-3 flex items-center justify-between">
        <div>
          <span className="text-[14px] font-semibold text-gray-900">Action Center</span>
          <span className="ml-2 text-[11px] text-gray-400">{items.length} otevřených</span>
        </div>
        <div className="flex items-center gap-1.5">
          <button onClick={() => setCategory('all')}
            className={`text-[11px] px-2.5 py-1 rounded-lg font-medium transition-colors ${category === 'all' ? 'bg-gray-800 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
            Vše ({items.length})
          </button>
          <button onClick={() => setCategory('blocking')}
            className={`text-[11px] px-2.5 py-1 rounded-lg transition-colors ${category === 'blocking' ? 'bg-red-100 text-red-700' : 'text-gray-500 hover:bg-gray-100'}`}>
            ● {counts.blocking}
          </button>
          <button onClick={() => setCategory('needs_decision')}
            className={`text-[11px] px-2.5 py-1 rounded-lg transition-colors ${category === 'needs_decision' ? 'bg-amber-100 text-amber-700' : 'text-gray-500 hover:bg-gray-100'}`}>
            ● {counts.needs_decision}
          </button>
          <button onClick={() => setCategory('system')}
            className={`text-[11px] px-2.5 py-1 rounded-lg transition-colors ${category === 'system' ? 'bg-blue-100 text-blue-700' : 'text-gray-500 hover:bg-gray-100'}`}>
            ● {counts.system}
          </button>
          <button onClick={load}
            className="ml-1 text-[11px] px-3 py-1 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50">
            Obnovit
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="max-w-5xl px-6 py-4">
        {loading && (
          <div className="py-12 text-center text-[12px] text-gray-400 animate-pulse">Načítám…</div>
        )}

        {!loading && items.length === 0 && (
          <div className="py-12 text-center text-[12px] text-green-600 bg-green-50 rounded-xl border border-green-200">
            ✓ Žádné akce k řešení
          </div>
        )}

        {!loading && (
          <div className="space-y-5">
            {(Object.entries(grouped) as [Category, ActionItem[]][])
              .filter(([, grp]) => grp.length > 0)
              .map(([cat, grp]) => {
                const cfg = CATEGORY_CFG[cat]
                return (
                  <div key={cat}>
                    {/* Section label */}
                    <div className="flex items-center gap-2 mb-1.5 px-1">
                      <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot}`} />
                      <span className={`text-[10px] font-semibold uppercase tracking-wider ${cfg.color}`}>
                        {cfg.label} · {grp.length}
                      </span>
                    </div>

                    {/* Table */}
                    <div className={`rounded-xl border bg-white overflow-hidden ${cfg.border}`}>
                      {grp.map((item, idx) => {
                        const isRunning  = runningIds.has(item.id)
                        const isDone     = doneIds.has(item.id)
                        const isExpanded = expanded === item.id
                        const isDismissing = dismissingId === item.id

                        return (
                          <div key={item.id} className={`${idx > 0 ? 'border-t border-gray-50' : ''}`}>
                            {/* Main row */}
                            <div
                              className={`flex items-center gap-3 px-4 py-2.5 cursor-pointer hover:bg-gray-50 transition-colors ${isDone ? 'opacity-50' : ''}`}
                              onClick={() => setExpanded(isExpanded ? null : item.id)}
                            >
                              {/* Severity dot */}
                              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                                item.severity === 'high' ? 'bg-red-500' :
                                item.severity === 'medium' ? 'bg-amber-400' : 'bg-gray-300'
                              }`} />

                              {/* Type */}
                              <span className="text-[10px] text-gray-400 w-28 shrink-0 truncate">{item.type}</span>

                              {/* Title */}
                              <span className="text-[13px] font-medium text-gray-900 flex-1 truncate">{item.title}</span>

                              {/* Subtitle */}
                              <span className="text-[11px] text-gray-400 w-24 text-right shrink-0 truncate">{item.subtitle}</span>

                              {/* Amount */}
                              {item.amount && (
                                <span className="text-[12px] font-semibold text-gray-700 w-28 text-right shrink-0">{item.amount}</span>
                              )}

                              {/* Owner */}
                              <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded-md shrink-0 ${OWNER_COLOR[item.owner]}`}>
                                {item.owner === 'ACCOUNTANT' ? 'ACCT' : item.owner}
                              </span>

                              {/* Actions — stop propagation so row click doesn't toggle expand */}
                              <div className="flex items-center gap-1.5 shrink-0 ml-1" onClick={e => e.stopPropagation()}>
                                {isDone ? (
                                  <span className="text-[10px] text-green-600">✓ Spuštěno</span>
                                ) : isRunning ? (
                                  <span className="text-[10px] text-gray-400 animate-pulse">Běží…</span>
                                ) : isDismissing ? (
                                  /* Dismiss reason picker */
                                  <div className="flex items-center gap-1 bg-white border border-gray-200 rounded-lg px-2 py-1 shadow-sm">
                                    <span className="text-[10px] text-gray-500 mr-0.5">Důvod:</span>
                                    {DISMISS_REASONS.map(r => (
                                      <button key={r}
                                        onClick={() => dismiss(item.id, r)}
                                        className="text-[10px] px-1.5 py-0.5 rounded hover:bg-gray-100 text-gray-600 whitespace-nowrap">
                                        {r}
                                      </button>
                                    ))}
                                    <button onClick={() => setDismissingId(null)} className="text-[10px] text-gray-300 hover:text-gray-500 ml-1">✕</button>
                                  </div>
                                ) : (
                                  <>
                                    {item.actions.map((action, i) => {
                                      if (action.href) {
                                        return (
                                          <Link key={i} href={action.href}
                                            className={`text-[11px] px-2.5 py-1 rounded-lg font-medium transition-colors whitespace-nowrap ${
                                              action.primary
                                                ? 'bg-[#0071e3] hover:bg-[#0077ed] text-white'
                                                : 'border border-gray-200 text-gray-600 hover:bg-gray-50'
                                            }`}>
                                            {action.label}
                                          </Link>
                                        )
                                      }
                                      return (
                                        <button key={i}
                                          onClick={() => runAction(item, action)}
                                          disabled={isRunning}
                                          className={`text-[11px] px-2.5 py-1 rounded-lg font-medium transition-colors whitespace-nowrap disabled:opacity-40 ${
                                            action.primary
                                              ? 'bg-[#0071e3] hover:bg-[#0077ed] text-white'
                                              : 'border border-gray-200 text-gray-600 hover:bg-gray-50'
                                          }`}>
                                          {action.label}
                                        </button>
                                      )
                                    })}
                                    {/* Dismiss button */}
                                    <button
                                      onClick={() => setDismissingId(item.id)}
                                      className="text-[11px] w-6 h-6 flex items-center justify-center rounded-lg text-gray-300 hover:text-gray-500 hover:bg-gray-100 transition-colors"
                                      title="Přeskočit / Vyřešeno">
                                      ✕
                                    </button>
                                  </>
                                )}
                              </div>

                              {/* Expand arrow */}
                              <span className="text-[10px] text-gray-300 ml-1 shrink-0">{isExpanded ? '▲' : '▼'}</span>
                            </div>

                            {/* Expanded detail */}
                            {isExpanded && (
                              <div className="px-4 pb-3 pt-1 bg-gray-50 border-t border-gray-100">
                                <p className="text-[11px] text-gray-500 leading-relaxed">{item.detail}</p>
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )
              })}
          </div>
        )}
      </div>
    </div>
  )
}
