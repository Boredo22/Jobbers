import { describe, expect, it } from "vitest";
import { isCandidate, isUsLocation } from "./prefilter";

// isCandidate is pure, so tests are just (input → verdict) tables. A helper
// keeps each case to one line: title + location, remote defaults to null
// because the prefilter deliberately ignores the flag (see prefilter.ts).
function candidate(title: string, location: string | null = "Remote"): boolean {
	return isCandidate({ title, location, remote: null });
}

describe("isCandidate — title gate", () => {
	it("accepts the AI-enablement job family", () => {
		expect(candidate("AI Enablement Lead")).toBe(true);
		expect(candidate("Solutions Engineer")).toBe(true);
		expect(candidate("Forward Deployed Engineer")).toBe(true);
		expect(candidate("Technical Product Manager")).toBe(true);
	});

	it("accepts the analyst cluster", () => {
		expect(candidate("Business Analyst")).toBe(true);
		expect(candidate("Senior Business Analyst, Payments")).toBe(true);
		expect(candidate("Business Systems Analyst")).toBe(true);
		expect(candidate("Product Analyst")).toBe(true);
		expect(candidate("Operations Analyst")).toBe(true);
	});

	it("rejects analyst titles outside the cluster (no bare 'analyst' match)", () => {
		expect(candidate("Data Analyst")).toBe(false);
		expect(candidate("Financial Analyst")).toBe(false);
		expect(candidate("Security Analyst")).toBe(false);
	});

	it("rejects titles with no include keyword", () => {
		expect(candidate("Barista")).toBe(false);
		expect(candidate("Backend Engineer")).toBe(false);
	});

	it("exclude keywords override an include match", () => {
		expect(candidate("Senior Software Engineer, AI Solutions")).toBe(false);
		expect(candidate("AI Product Design Intern")).toBe(false);
	});
});

describe("isCandidate — custom keyword settings", () => {
	const settings = {
		includeTitleKeywords: ["data analyst"],
		excludeTitleKeywords: ["intern"],
	};
	const posting = (title: string) => ({
		title,
		location: "Remote",
		remote: null,
	});

	it("caller-supplied lists replace the defaults entirely", () => {
		// In the custom list, so a candidate now (the default list rejects it)…
		expect(isCandidate(posting("Data Analyst"), settings)).toBe(true);
		// …and a default keyword no longer matches once the list is replaced.
		expect(isCandidate(posting("Business Analyst"), settings)).toBe(false);
	});

	it("custom exclude keywords still override an include match", () => {
		expect(isCandidate(posting("Data Analyst Intern"), settings)).toBe(false);
	});
});

describe("isCandidate — location gate", () => {
	it("keeps remote, nationwide, commutable, and unknown locations", () => {
		expect(candidate("Business Analyst", "Remote")).toBe(true);
		expect(candidate("Business Analyst", "United States")).toBe(true);
		expect(candidate("Business Analyst", "Albany, NY")).toBe(true);
		expect(candidate("Business Analyst", null)).toBe(true);
	});

	it("drops specific-city onsite/hybrid roles", () => {
		expect(candidate("Business Analyst", "San Francisco, CA")).toBe(false);
		expect(candidate("Business Analyst", "London")).toBe(false);
	});
});

describe("isUsLocation", () => {
	it("US signals win, even in mixed strings", () => {
		expect(isUsLocation("Remote, US")).toBe(true);
		expect(isUsLocation("Remote, Canada; Remote, US")).toBe(true);
		expect(isUsLocation("Albany, NY")).toBe(true);
	});

	it("known non-US locations are dropped", () => {
		expect(isUsLocation("London, UK")).toBe(false);
		expect(isUsLocation("Toronto")).toBe(false);
	});

	it("ambiguous or missing locations are kept", () => {
		expect(isUsLocation("Remote")).toBe(true);
		expect(isUsLocation(null)).toBe(true);
	});
});
