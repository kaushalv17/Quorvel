import "./globals.css"
import Link from "next/link"
import type { ReactNode } from "react"

export const metadata = {
	title: "Belay — Approvals",
	description: "Live approval queue and per-agent action timeline for Belay.",
}

export default function RootLayout({ children }: { children: ReactNode }) {
	return (
		<html lang="en">
			<body>
				<header className="topbar">
					<Link href="/" className="brand">
						<span className="brand-mark">belay</span>
						<span className="brand-sub">control plane</span>
					</Link>
					<nav className="nav">
						<Link href="/">Approvals</Link>
						<Link href="/agents">Agents</Link>
					</nav>
				</header>
				<main className="main">{children}</main>
			</body>
		</html>
	)
}
