// ---------------------------------------------------------------------------
// filename.ts — "Michael_Brown_Cover_Letter_Acme_Corp.pdf" from free text.
// Pure function, unit-tested: filenames end up on disk and inside ATS uploads,
// so garbage characters here surface as real-world breakage.
// ---------------------------------------------------------------------------

/** Collapse arbitrary text to a safe filename fragment (underscores only). */
function slug(text: string): string {
	return text
		.normalize("NFKD") // é → e + combining accent…
		.replace(/[̀-ͯ]/g, "") // …then drop the accents
		.replace(/[^A-Za-z0-9]+/g, "_") // anything else → _
		.replace(/^_+|_+$/g, "") // no leading/trailing _
		.replace(/_{2,}/g, "_"); // no runs of _
}

export function coverLetterFilename(
	candidateName: string,
	company: string,
): string {
	const name = slug(candidateName) || "Candidate";
	// "Unknown" is the model's explicit can't-tell marker — don't put it in a
	// filename you might upload.
	const co = company.trim().toLowerCase() === "unknown" ? "" : slug(company);
	return co ? `${name}_Cover_Letter_${co}.pdf` : `${name}_Cover_Letter.pdf`;
}
