'use client'

export default function Error({ error }: { error: Error }) {
  return (
    <div style={{ padding: 40, fontFamily: 'monospace' }}>
      <h2>Chyba při načítání stránky</h2>
      <p style={{ color: 'red' }}>{error.message}</p>
      <pre style={{ fontSize: 12, whiteSpace: 'pre-wrap' }}>{error.stack}</pre>
    </div>
  )
}
