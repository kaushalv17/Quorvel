import { BelayClient } from "./belay"

// Builds a server-side BelayClient from env. Only ever imported by server
// components / server actions / route handlers — never shipped to the browser,
// so the API key stays on the server.
export function serverClient(): BelayClient {
	const baseUrl = process.env.BELAY_API_URL
	const apiKey = process.env.BELAY_API_KEY
	if (!baseUrl || !apiKey) {
		throw new Error("BELAY_API_URL and BELAY_API_KEY must be set")
	}
	return new BelayClient({ baseUrl, apiKey })
}
