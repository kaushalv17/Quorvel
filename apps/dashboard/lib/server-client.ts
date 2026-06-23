import { QuorvelClient } from "./quorvel"

// Builds a server-side QuorvelClient from env. Only ever imported by server
// components / server actions / route handlers — never shipped to the browser,
// so the API key stays on the server.
export function serverClient(): QuorvelClient {
	const baseUrl = process.env.QUORVEL_API_URL
	const apiKey = process.env.QUORVEL_API_KEY
	if (!baseUrl || !apiKey) {
		throw new Error("QUORVEL_API_URL and QUORVEL_API_KEY must be set")
	}
	return new QuorvelClient({ baseUrl, apiKey })
}
