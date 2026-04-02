'use client'

export default function ExplorerPage() {
  return (
    <div className="min-h-screen bg-gray-50">
      <div className="sticky top-0 z-10 bg-white border-b border-gray-100 px-6 py-3">
        <div className="text-[15px] font-semibold text-gray-900">Explorer</div>
        <div className="text-[11px] text-gray-400 mt-0.5">Audit trail · CASE detail · historie rozhodnutí</div>
      </div>
      <div className="p-6 max-w-4xl">
        <div className="bg-white rounded-2xl border border-gray-100 px-6 py-5 text-center text-[13px] text-gray-400">
          Explorer — v přípravě.<br />Bude zobrazovat: detail CASEu, dokument, transakce, návrh, audit trail, historia.
        </div>
      </div>
    </div>
  )
}
