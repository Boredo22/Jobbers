import { describe, expect, it } from "vitest";
import { coverLetterFilename } from "./filename";

describe("coverLetterFilename", () => {
	it("joins name and company with safe underscores", () => {
		expect(coverLetterFilename("Michael Brown", "Acme Corp")).toBe(
			"Michael_Brown_Cover_Letter_Acme_Corp.pdf",
		);
	});

	it("strips accents and punctuation", () => {
		expect(coverLetterFilename("Michael Brown", "Café & Räv, Inc.")).toBe(
			"Michael_Brown_Cover_Letter_Cafe_Rav_Inc.pdf",
		);
	});

	it("omits the company when the model returned 'Unknown'", () => {
		expect(coverLetterFilename("Michael Brown", "Unknown")).toBe(
			"Michael_Brown_Cover_Letter.pdf",
		);
	});

	it("never produces an empty name fragment", () => {
		expect(coverLetterFilename("???", "!!!")).toBe(
			"Candidate_Cover_Letter.pdf",
		);
	});
});
