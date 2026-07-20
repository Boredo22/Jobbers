// ---------------------------------------------------------------------------
// settings.ts — the two things the sidebar lets you configure, persisted in
// chrome.storage.sync (Chrome's tiny key-value store that roams with your
// Google profile — think localStorage, but shared across your machines and
// readable from both the content script and the background worker).
// ---------------------------------------------------------------------------

export interface Settings {
	/** Base URL of the Jobber API, e.g. "http://localhost:3001". */
	apiBase: string;
	/** Who signs the letter. */
	candidateName: string;
}

export const DEFAULT_SETTINGS: Settings = {
	apiBase: "http://localhost:3001",
	candidateName: "Michael Brown",
};

/** Read settings, falling back to defaults for anything unset or blanked. */
export async function getSettings(): Promise<Settings> {
	// .get(defaults) merges: stored values win, defaults fill the gaps. Spread
	// into a fresh literal: chrome's typings want an index-signature object, and
	// TS gives interfaces (unlike literals) no implicit index signature.
	const stored = await chrome.storage.sync.get({ ...DEFAULT_SETTINGS });
	return {
		apiBase: String(stored.apiBase ?? "").trim() || DEFAULT_SETTINGS.apiBase,
		candidateName:
			String(stored.candidateName ?? "").trim() ||
			DEFAULT_SETTINGS.candidateName,
	};
}

export async function saveSettings(settings: Settings): Promise<void> {
	await chrome.storage.sync.set(settings);
}
