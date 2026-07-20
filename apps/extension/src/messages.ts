import type { CoverLetterResponse } from "@jobber/shared";

// ---------------------------------------------------------------------------
// messages.ts — the contract between the content script and the background
// service worker (chrome.runtime.sendMessage is the only way they can talk).
//
// Why the content script doesn't just fetch() the API itself: content scripts
// make requests AS the host page, so the job site's origin + CORS rules apply
// and the call dies. The background worker makes requests as the *extension*,
// and the manifest's host_permissions exempt it from CORS for the API host.
// ---------------------------------------------------------------------------

export const DRAFT_MESSAGE_TYPE = "jobber:draft-cover-letter";

export interface DraftRequestMessage {
	type: typeof DRAFT_MESSAGE_TYPE;
	jobText: string;
	pageUrl: string;
	pageTitle: string;
}

/** Discriminate unknown incoming messages down to ours. */
export function isDraftRequest(msg: unknown): msg is DraftRequestMessage {
	return (
		typeof msg === "object" &&
		msg !== null &&
		(msg as { type?: unknown }).type === DRAFT_MESSAGE_TYPE
	);
}

// A result-or-error union instead of throwing: exceptions can't cross the
// sendMessage boundary, so failure has to travel as data.
export type DraftResponseMessage =
	| { ok: true; data: CoverLetterResponse }
	| { ok: false; message: string };
