'use client'

import { useState } from 'react'

export default function AuditorWorkspace() {
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<{ log: Array<{ type: string; text: string }>; summary: string; flagged: number; approved: number } | null>(null)
  const year = new Date().getFullYear()

  const run = async () => {
    setRunning(true)
    try {
      const res = await fetch('/api/agent/auditor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ year }),
      })
      setResult(await res.json())
    } catch { /* silent */ }
    setRunning(false)
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="sticky top-0 z-10 bg-white border-b border-gray-100 px-6 py-3 flex items-center justify-between">
        <div>
          <div className="text-[15px] font-semibold text-gray-900">Auditor</div>
          <div className="text-[11px] text-gray-400 mt-0.5">Kontrola rozhodnutí · nízká confidence · ACCOUNTING_PROPOSED sweep</div>
        </div>
        <button onClick={run} disabled={running} className="text-[11px] px-4 py-1.5 rounded-lg bg-purple-600 hover:bg-purple-700 text-white font-medium disabled:opacity-40">
          {running ? 'Audituji…' : 'Spustit audit'}
        </button>
      </div>

      <div className="p-6 max-w-3xl space-y-4">
        {result && (
          <>
            <div className="grid grid-cols-2 gap-3">
              <div className="bg-white rounded-2xl border border-gray-100 px-5 py-4 text-center">
                <div className={`text-[28px] font-bold ${result.approved > 0 ? 'text-green-600' : 'text-gray-400'}`}>{result.approved}</div>
                <div className="text-[11px] text-gray-500 mt-1">schváleno → AUDIT_CHECKED</div>
              </div>
              <div className="bg-white rounded-2xl border border-gray-100 px-5 py-4 text-center">
                <div className={`text-[28px] font-bold ${result.flagged > 0 ? 'text-red-600' : 'text-gray-400'}`}>{result.flagged}</div>
                <div className="text-[11px] text-gray-500 mt-1">označeno / vráceno</div>
              </div>
            </div>

            <div className="space-y-1">
              {result.log.map((l, i) => (
                <div key={i} className={`flex items-start gap-2 text-[11px] px-3 py-1.5 rounded-lg ${l.type === 'warn' ? 'bg-orange-50 text-orange-700' : l.type === 'action' ? 'bg-green-50 text-green-700' : 'text-gray-500'}`}>
                  <span className="shrink-0 font-bold">{l.type === 'warn' ? '⚠' : l.type === 'action' ? '✓' : '·'}</span>
                  <span>{l.text}</span>
                </div>
              ))}
            </div>
          </>
        )}

        {!running && !result && (
          <div className="text-center py-16 text-[12px] text-gray-400 bg-white rounded-2xl border border-gray-100">
            Spusť audit pro kontrolu rozhodnutí agentů.
          </div>
        )}

        {running && <div className="text-center py-16 text-[13px] text-gray-400 animate-pulse">Audituji…</div>}
      </div>
    </div>
  )
}
