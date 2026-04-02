'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

const nav = [
  {
    group: null,
    items: [
      { href: '/control-tower', label: 'Control Tower', icon: '⬡' },
      { href: '/actions', label: 'Actions', icon: '⚡' },
    ],
  },
  {
    group: 'Workspaces',
    items: [
      { href: '/workspaces/accountant', label: 'Faktury', icon: '📒' },
      { href: '/workspaces/auditor', label: 'Auditor', icon: '🔍' },
      { href: '/workspaces/ceo', label: 'CEO', icon: '📈' },
      { href: '/workspaces/assistant', label: 'Asistentka', icon: '📋' },
    ],
  },
  {
    group: null,
    items: [
      { href: '/explorer', label: 'Explorer', icon: '🗂' },
      { href: '/settings', label: 'Settings', icon: '⚙' },
    ],
  },
]

export default function AppNav() {
  const pathname = usePathname()

  return (
    <nav className="w-[200px] shrink-0 bg-white border-r border-gray-100 min-h-screen flex flex-col py-5 px-3 gap-1">
      {/* Logo */}
      <div className="px-3 mb-5">
        <div className="text-[13px] font-bold text-gray-900 tracking-tight">SuperAccount</div>
        <div className="text-[10px] text-gray-400 mt-0.5">Velín</div>
      </div>

      {nav.map((section, si) => (
        <div key={si} className="mb-2">
          {section.group && (
            <div className="text-[9px] font-bold text-gray-400 uppercase tracking-widest px-3 mb-1 mt-2">
              {section.group}
            </div>
          )}
          {section.items.map(item => {
            const active = pathname === item.href || pathname.startsWith(item.href + '/')
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-[12px] font-medium transition-colors ${
                  active
                    ? 'bg-[#0071e3] text-white'
                    : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'
                }`}
              >
                <span className="text-[14px] leading-none">{item.icon}</span>
                {item.label}
              </Link>
            )
          })}
        </div>
      ))}

      <div className="mt-auto px-3">
        <div className="text-[9px] text-gray-300 uppercase tracking-wider">v2.1</div>
      </div>
    </nav>
  )
}
