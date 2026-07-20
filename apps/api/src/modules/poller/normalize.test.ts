import { describe, expect, it } from "vitest";
import {
	normalizeBamboo,
	normalizeBreezy,
	normalizeRecruitee,
	normalizeSmartRecruiters,
	normalizeWorkable,
} from "./normalize";

// The normalizers are pure (raw platform objects in, NormalizedPosting out),
// so each test is a small fixture — shaped like the real API response after
// the client's Zod parse — and assertions on the mapping decisions that
// matter: external-id stringification, URL fallbacks, HTML stripping,
// remote-flag precedence, and the drop-postings-without-URL rule.

describe("normalizeSmartRecruiters", () => {
	it("maps a full posting, stitching jobAd sections into one description", () => {
		const [p] = normalizeSmartRecruiters([
			{
				id: "744000012345",
				name: "AI Solutions Engineer",
				location: {
					city: "Albany",
					region: "NY",
					country: "us",
					remote: false,
				},
				applyUrl: "https://jobs.smartrecruiters.com/Acme/744000012345",
				sectionsHtml: [
					"<p>About&nbsp;Acme</p>",
					"<p>You will build things</p>",
				],
				fallbackUrl: "https://jobs.smartrecruiters.com/Acme/744000012345",
			},
		]);
		expect(p).toMatchObject({
			externalId: "744000012345",
			title: "AI Solutions Engineer",
			url: "https://jobs.smartrecruiters.com/Acme/744000012345",
			location: "Albany, NY, us",
			remote: false,
			description: "About Acme\n\nYou will build things",
		});
	});

	it("survives a failed detail fetch (null sections) and infers remote from location", () => {
		const [p] = normalizeSmartRecruiters([
			{
				id: "1",
				name: "Implementation Specialist",
				location: { city: "Remote", region: null, country: null, remote: null },
				applyUrl: null,
				sectionsHtml: null,
				fallbackUrl: "https://jobs.smartrecruiters.com/Acme/1",
			},
		]);
		expect(p).toMatchObject({
			url: "https://jobs.smartrecruiters.com/Acme/1", // fallback when no applyUrl
			description: null,
			remote: true, // detectRemote("Remote")
		});
	});
});

describe("normalizeWorkable", () => {
	it("maps shortcode → externalId and telecommuting → remote", () => {
		const [p] = normalizeWorkable([
			{
				shortcode: "ABC123",
				title: "Solutions Consultant",
				url: "https://apply.workable.com/acme/j/ABC123/",
				application_url: "https://apply.workable.com/acme/j/ABC123/apply/",
				telecommuting: true,
				city: "Saratoga Springs",
				state: "NY",
				country: "United States",
				description: "<p>Do <b>great</b> work</p>",
			},
		]);
		expect(p).toMatchObject({
			externalId: "ABC123",
			url: "https://apply.workable.com/acme/j/ABC123/",
			location: "Saratoga Springs, NY, United States",
			remote: true, // telecommuting wins over location text
			description: "Do great work",
		});
	});

	it("falls back to application_url and drops postings with no URL at all", () => {
		const posts = normalizeWorkable([
			{
				shortcode: "A",
				title: "PM",
				url: null,
				application_url: "https://apply.workable.com/acme/j/A/apply/",
				telecommuting: null,
				city: null,
				state: null,
				country: null,
				description: null,
			},
			{
				shortcode: "B",
				title: "PM",
				url: null,
				application_url: null,
				telecommuting: null,
				city: null,
				state: null,
				country: null,
				description: null,
			},
		]);
		expect(posts).toHaveLength(1);
		expect(posts[0]?.url).toBe("https://apply.workable.com/acme/j/A/apply/");
	});
});

describe("normalizeRecruitee", () => {
	it("stringifies the numeric id and joins description + requirements", () => {
		const [p] = normalizeRecruitee([
			{
				id: 98765,
				title: "Automation Engineer",
				slug: "automation-engineer",
				careers_url: "https://acme.recruitee.com/o/automation-engineer",
				location: "Amsterdam, Netherlands",
				city: null,
				country: null,
				remote: true,
				description: "<p>The role</p>",
				requirements: "<p>The must-haves</p>",
			},
		]);
		expect(p).toMatchObject({
			externalId: "98765",
			url: "https://acme.recruitee.com/o/automation-engineer",
			location: "Amsterdam, Netherlands",
			remote: true,
			description: "The role\n\nThe must-haves",
		});
	});
});

describe("normalizeBreezy", () => {
	it("maps name → title and location.is_remote → remote", () => {
		const [p] = normalizeBreezy([
			{
				id: "pos-1",
				name: "Technical Product Manager",
				friendly_id: "technical-product-manager",
				url: "https://acme.breezy.hr/p/technical-product-manager",
				location: { name: "Remote — US", is_remote: true },
				description: "<h2>Role</h2><p>Ship things</p>",
			},
		]);
		expect(p).toMatchObject({
			externalId: "pos-1",
			title: "Technical Product Manager",
			location: "Remote — US",
			remote: true,
			description: "Role Ship things",
		});
	});
});

describe("normalizeBamboo", () => {
	it("stringifies numeric ids and joins city/state into a location", () => {
		const [p] = normalizeBamboo([
			{
				id: 42,
				jobOpeningName: "AI Program Manager",
				location: { city: "Boise", state: "ID" },
				isRemote: null,
				descriptionHtml: "<p>Run the AI program</p>",
				url: "https://acme.bamboohr.com/careers/42",
			},
		]);
		expect(p).toMatchObject({
			externalId: "42",
			title: "AI Program Manager",
			url: "https://acme.bamboohr.com/careers/42",
			location: "Boise, ID",
			remote: false, // no flag, and "Boise, ID" doesn't read as remote
			description: "Run the AI program",
		});
	});

	it("keeps a posting whose detail fetch failed (null description)", () => {
		const [p] = normalizeBamboo([
			{
				id: "7",
				jobOpeningName: "Ops Analyst",
				location: null,
				isRemote: true,
				descriptionHtml: null,
				url: "https://acme.bamboohr.com/careers/7",
			},
		]);
		expect(p).toMatchObject({
			externalId: "7",
			location: null,
			remote: true,
			description: null,
		});
	});
});
