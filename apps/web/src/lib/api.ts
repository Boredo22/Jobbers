import type { z } from "zod";

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
	if (!res.ok) throw new Error(`${res.status} ${path}`);
	return schema.parse(await res.json());
}
