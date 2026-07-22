// ---------------------------------------------------------------------------
// http.ts — the one HTTP helper every ATS client shares.
//
// Node 18+ ships a global `fetch` (WHATWG/undici), so no axios needed. This
// wrapper does the three things every client would otherwise repeat: set polite
// headers, enforce a timeout, and turn a non-2xx / network failure into a typed
// error the caller can branch on (e.g. "was it a 404 = dead token?").
// ---------------------------------------------------------------------------

/**
 * A fetch failure we can inspect. `status` is the HTTP code when we got a
 * response (404 → the board/token is gone); it's undefined for a network-level
 * failure or timeout (no response at all).
 */
export class AtsFetchError extends Error {
	readonly status: number | undefined;
	constructor(message: string, status?: number, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "AtsFetchError";
		this.status = status;
	}
}

async function requestJson(url: string, init?: RequestInit): Promise<unknown> {
	let res: Response;
	try {
		res = await fetch(url, {
			...init,
			headers: {
				accept: "application/json",
				// Be a polite citizen: identify the client. Some ATS CDNs reject
				// requests with no User-Agent.
				"user-agent": "jobber-poller/0.1 (+http://jobber.local)",
				...init?.headers,
			},
			// Native per-request timeout — no response within 15s aborts the fetch.
			signal: AbortSignal.timeout(15_000),
		});
	} catch (err) {
		// DNS failure, connection refused, or the 15s timeout firing.
		throw new AtsFetchError(`network error fetching ${url}`, undefined, {
			cause: err,
		});
	}

	if (!res.ok) {
		throw new AtsFetchError(`HTTP ${res.status} fetching ${url}`, res.status);
	}

	return res.json();
}

export async function fetchJson(url: string): Promise<unknown> {
	return requestJson(url);
}

/**
 * POST a JSON body, get JSON back. Some boards (Workday's CXS API) take their
 * query — pagination, search text — as a POST body rather than URL params.
 */
export async function postJson(url: string, body: unknown): Promise<unknown> {
	return requestJson(url, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}
