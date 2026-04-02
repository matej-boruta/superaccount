'use client'

import { useEffect, useState } from 'react'

export default function CeoWorkspace() {
  const [data, setData] = useState<Record<string, unknown> | null>(null)
  const [loading, setLoading] = useState(true)
  const year = new Date().getFullYear()

  useEffect(() => {
    fetch(`/api/vykazy/vysledovka?rok=${year}`)
      .then(r => r.json())
      .then(setData)
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [year])

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="sticky top-0 z-10 bg-white border-b border-gray-100 px-6 py-3">
        <div className="text-[15px] font-semibold text-gray-900">CEO pohled</div>
        <div className="text-[11px] text-gray-400 mt-0.5">Přehled financí · {year}</div>
      </div>
      <div className="p-6 max-w-4xl">
        {loading && <div className="text-center py-16 text-[13px] text-gray-400 animate-pulse">Načítám data…</div>}
        {!loading && (
          <div className="bg-white rounded-2xl border border-gray-100 px-6 py-5 text-center text-[13px] text-gray-400">
            CEO dashboard — v přípravě.<br />Bude zobrazovat: TOP spend, anomálie, cash flow přehled.
          </div>
        )}
      </div>
    </div>
  )
}
