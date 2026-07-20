import { CoverLetterResponseSchema } from "@jobber/shared";
import {
	type DraftRequestMessage,
	type DraftResponseMessage,
	isDraftRequest,
} from "./messages";
import { getSettings } from "./settings";

// ---------------------------------------------------------------------------
// background.ts — the MV3 service worker. Two jobs:
//
//   1. Toolbar click → inject the sidebar content script into the active tab.
//      Using activeTab + scripting (instead of a content_scripts manifest
//      entry with <all_urls>) means the extension can touch a page ONLY after
//      you click its button on that page — minimal standing permissions.
//
//   2. Relay draft requests from the content script to the Jobber API. The
//      fetch happens here because extension-origin requests with matching
//      host_permissions are exempt from CORS; a content script would inherit
//      the job site's origin and be blocked. The response crosses a Zod
//      boundary before it's forwarded — same rule as every other wire.
// ---------------------------------------------------------------------------

chrome.action.onClicked.addListener((tab) => {
	if (tab.id === undefined) return;
	// Re-running content.js on a tab that already has the sidebar just toggles
	// it — the script guards itself with a window flag.
	chrome.scripting
		.executeScript({ target: { tabId: tab.id }, files: ["content.js"] })
		.catch((err) => {
			// chrome:// pages, the Web Store, etc. refuse injection.
			console.warn("Jobber: cannot inject sidebar here:", err);
		});
});

chrome.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse) => {
	if (!isDraftRequest(msg)) return false;
	// sendResponse is callback-style (pre-Promise Chrome API); returning true
	// tells Chrome "the response comes later — keep the channel open".
	draftViaApi(msg).then(sendResponse);
	return true;
});

async function draftViaApi(
	msg: DraftRequestMessage,
): Promise<DraftResponseMessage> {
	try {
		const { apiBase, candidateName } = await getSettings();
		const url = new URL("/api/cover-letter", apiBase);

		const res = await fetch(url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				jobText: msg.jobText,
				candidateName,
				pageUrl: msg.pageUrl || undefined,
				pageTitle: msg.pageTitle || undefined,
			}),
		});

		if (!res.ok) {
			// The API sends { message } on 4xx/5xx — surface it if parseable.
			let message = `API error ${res.status}`;
			try {
				const body: unknown = await res.json();
				const m = (body as { message?: unknown })?.message;
				if (typeof m === "string") message = m;
			} catch {
				// non-JSON error body — keep the status-code message
			}
			return { ok: false, message };
		}

		const parsed = CoverLetterResponseSchema.safeParse(await res.json());
		if (!parsed.success) {
			return {
				ok: false,
				message: "API response didn't match the expected shape (version skew?)",
			};
		}
		return { ok: true, data: parsed.data };
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		return {
			ok: false,
			message: `Could not reach the Jobber API — is it running? (${detail})`,
		};
	}
}
