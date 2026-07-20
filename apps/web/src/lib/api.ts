import type { z } from "zod";

/**
 * Build the Error for a non-2xx response. The api's error routes send
 * `{ message }` bodies (400 validation, 502 upstream) — surface that text so a
 * toast can say WHY, not just "400". Falls back to status + path when the body
 * isn't JSON or has no message.
 */
async function httpError(res: Response, path: string): Promise<Error> {
	let detail = "";
	try {
		const body = (await res.json()) as { message?: unknown };
		if (typeof body.message === "string") detail = `: ${body.message}`;
	} catch {
		// Non-JSON body — the status line will have to do.
	}
	return new Error(`${res.status} ${path}${detail}`);
}

/**
 * Typed GET helper. Fetches `path`, then validates the JSON against a Zod
 * schema before returning it. If the backend ever returns a shape that
 * doesn't match, this throws loudly here — instead of a silent bug surfacing
 * three components deep. The `<T>` flows from the schema, so callers get a
 * fully-typed result with zero manual annotation.
 */
export async function apiGet<T>(
	path: string,
	schema: z.ZodType<T>,
): Promise<T> {
	const res = await fetch(path);
	if (!res.ok) throw await httpError(res, path);
	return schema.parse(await res.json());
}

/**
 * Typed helper for mutations (POST/PATCH/…). Sends `body` as JSON and validates
 * the response against `schema`, same as apiGet. Used by TanStack Query's
 * useMutation. Keeping request + response validation in one place means every
 * network call in the app crosses a Zod boundary (CLAUDE.md §4).
 */
export async function apiSend<T>(
	path: string,
	method: "POST" | "PATCH" | "PUT" | "DELETE",
	body: unknown,
	schema: z.ZodType<T>,
): Promise<T> {
	const res = await fetch(path, {
		method,
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!res.ok) throw await httpError(res, path);
	return schema.parse(await res.json());
}
