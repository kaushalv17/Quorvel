import Link from 'next/link'
import type { CSSProperties, ReactNode } from 'react'

const page: CSSProperties = {
  minHeight: '100vh',
  background: '#06070a',
  color: '#cdd6e3',
  fontFamily: 'Inter, system-ui, -apple-system, sans-serif',
  lineHeight: 1.75,
}
const headerBar: CSSProperties = {
  borderBottom: '1px solid rgba(255,255,255,0.08)',
  position: 'sticky',
  top: 0,
  background: 'rgba(6,7,10,0.85)',
  backdropFilter: 'blur(10px)',
  WebkitBackdropFilter: 'blur(10px)',
  zIndex: 10,
}
const wrap: CSSProperties = { maxWidth: 820, margin: '0 auto', padding: '0 22px' }
const headerInner: CSSProperties = {
  maxWidth: 820,
  margin: '0 auto',
  padding: '0 22px',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  height: 64,
}
const brand: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 10,
  color: '#fff',
  textDecoration: 'none',
  fontWeight: 600,
  fontFamily: '"Space Grotesk", Inter, sans-serif',
  fontSize: 18,
}
const brandDot: CSSProperties = {
  width: 22,
  height: 22,
  borderRadius: '50%',
  background: 'linear-gradient(110deg,#2fe6c6,#67d3ff,#9a8bff)',
}
const backLink: CSSProperties = { color: '#97a2b0', textDecoration: 'none', fontSize: 14 }
const main: CSSProperties = {
  maxWidth: 820,
  margin: '0 auto',
  padding: '56px 22px',
}
const eyebrow: CSSProperties = {
  textTransform: 'uppercase',
  letterSpacing: '0.14em',
  fontSize: 12,
  color: '#2fe6c6',
  margin: '0 0 12px',
  fontWeight: 600,
}
const h1: CSSProperties = {
  fontFamily: '"Space Grotesk", Inter, sans-serif',
  fontSize: 36,
  lineHeight: 1.12,
  color: '#fff',
  margin: '0 0 12px',
}
const updated: CSSProperties = { color: '#6f7a89', fontSize: 13.5, margin: 0 }
const introStyle: CSSProperties = { color: '#aeb8c6', fontSize: 16.5, margin: '20px 0 0' }
const bodyWrap: CSSProperties = { margin: '36px 0 0' }
const rule: CSSProperties = {
  border: 0,
  borderTop: '1px solid rgba(255,255,255,0.08)',
  margin: '48px 0 22px',
}
const footNote: CSSProperties = { fontSize: 14, color: '#97a2b0', margin: '0 0 8px' }
const footDim: CSSProperties = { fontSize: 12.5, color: '#5a636f', margin: '14px 0 0' }
const link: CSSProperties = { color: '#67d3ff', textDecoration: 'none' }

const h2Style: CSSProperties = {
  fontFamily: '"Space Grotesk", Inter, sans-serif',
  color: '#fff',
  fontSize: 21,
  margin: '34px 0 10px',
}
const pStyle: CSSProperties = { color: '#bcc6d3', fontSize: 15.5, margin: '0 0 14px' }
const ulStyle: CSSProperties = {
  color: '#bcc6d3',
  fontSize: 15.5,
  margin: '0 0 14px',
  paddingLeft: 22,
}
const liStyle: CSSProperties = { margin: '0 0 8px' }

export function H2({ children }: { children: ReactNode }) {
  return <h2 style={h2Style}>{children}</h2>
}

export function P({ children }: { children: ReactNode }) {
  return <p style={pStyle}>{children}</p>
}

export function Ul({ children }: { children: ReactNode }) {
  return <ul style={ulStyle}>{children}</ul>
}

export function Li({ children }: { children: ReactNode }) {
  return <li style={liStyle}>{children}</li>
}

export function A({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} style={link}>
      {children}
    </a>
  )
}

export default function LegalPage({
  title,
  lastUpdated,
  intro,
  children,
}: {
  title: string
  lastUpdated: string
  intro?: ReactNode
  children: ReactNode
}) {
  return (
    <div style={page}>
      <header style={headerBar}>
        <div style={headerInner}>
          <Link href="/" style={brand}>
            <span style={brandDot} />
            Quorvel
          </Link>
          <Link href="/" style={backLink}>
            ← Back to site
          </Link>
        </div>
      </header>
      <main style={main}>
        <p style={eyebrow}>Legal</p>
        <h1 style={h1}>{title}</h1>
        <p style={updated}>Last updated: {lastUpdated}</p>
        {intro ? <div style={introStyle}>{intro}</div> : null}
        <div style={bodyWrap}>{children}</div>
        <hr style={rule} />
        <p style={footNote}>
          Other policies: <Link href="/terms" style={link}>Terms of Service</Link> &middot;{' '}
          <Link href="/privacy" style={link}>Privacy Policy</Link> &middot;{' '}
          <Link href="/refunds" style={link}>Refund &amp; Cancellation</Link>
        </p>
        <p style={footNote}>
          Questions? Email{' '}
          <a href="mailto:hello@quorvel.tech" style={link}>hello@quorvel.tech</a>.
        </p>
        <p style={footDim}>© 2026 Quorvel · Operated as an independent business.</p>
      </main>
    </div>
  )
}
