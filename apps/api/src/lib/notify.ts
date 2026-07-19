import { env } from "./config";

// ---------------------------------------------------------------------------
// notify.ts — push notifications via ntfy (step 1.5).
//
// ntfy (https://ntfy.sh) is dead-simple: HTTP POST to a topic URL, the body IS
// the message, and a few optional headers control the title, priority, and
// emoji tags. Subscribe to the same topic in the phone app and every POST
// becomes a push notification. No SDK, no auth for a public topic.
//
// Two rules this module enforces:
//   • If NTFY_URL is unset, notify() is a silent no-op — the poller must run on
//     a headless box with no phone attached.
//   • A notification failure can NEVER break the caller. ntfy being down is not
//     a reason to fail a poll, so every send is wrapped and returns a boolean
//     instead of throwing.
// ---------------------------------------------------------------------------

// ntfy's five priority levels (1–5). Names read better at call sites than the
// numbers the API also accepts.
export type NtfyPriority = "min" | "low" | "default" | "high" | "urgent";

export type Notification = {
	/** The notification body. May contain newlines. */
	message: string;
	/** Bold headline shown above the body. Single line only. */
	title?: string;
	/** Louder = more prominent; "urgent" bypasses Do Not Disturb on the phone. */
	priority?: NtfyPriority;
	/** Emoji shortcodes ("tada", "warning") shown next to the title. */
	tags?: string[];
	/** URL opened when the notification is tapped. */
	click?: string;
};

/**
 * ntfy header values must be Latin-1 / single-line: newlines terminate the
 * header and non-ASCII bytes get mangled in transit. Titles are user-ish text
 * (company names), so strip anything that would corrupt the request.
 */
function sanitizeHeader(value: string): string {
	return value.replace(/[\r\n]+/g, " ").replace(/[^\x20-\x7E]/g, "");
}

/**
 * Send one ntfy notification. Returns true if ntfy accepted it, false if it was
 * skipped (no URL configured) or the request failed. Never throws.
 */
export async function notify(n: Notification): Promise<boolean> {
	if (!env.NTFY_URL) return false; // unconfigured → no-op

	const headers: Record<string, string> = {};
	if (n.title) headers.Title = sanitizeHeader(n.title);
	if (n.priority) headers.Priority = n.priority;
	if (n.tags?.length) headers.Tags = n.tags.map(sanitizeHeader).join(",");
	if (n.click) headers.Click = n.click;

	try {
		const res = await fetch(env.NTFY_URL, {
			method: "POST",
			body: n.message,
			headers,
		});
		return res.ok;
	} catch {
		// Swallow: the caller (a poll run) must survive a flaky notifier.
		return false;
	}
}
