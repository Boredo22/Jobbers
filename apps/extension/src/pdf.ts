import { jsPDF } from "jspdf";

// ---------------------------------------------------------------------------
// pdf.ts — the edited letter text → a one-page US-letter PDF, entirely in the
// browser. No server round-trip: the text in the sidebar textarea IS the
// document, so what you read is exactly what lands in the PDF.
// ---------------------------------------------------------------------------

const PAGE_W = 612; // US letter, in points (72/inch)
const PAGE_H = 792;
const MARGIN = 72; // 1 inch
const FONT_SIZE = 12;
const LINE_HEIGHT = FONT_SIZE * 1.4;

/** Render plain letter text (blank lines = paragraph breaks) to a PDF Blob. */
export function letterPdf(letterText: string): Blob {
	const doc = new jsPDF({ unit: "pt", format: "letter" });
	doc.setFont("times", "normal");
	doc.setFontSize(FONT_SIZE);

	const maxWidth = PAGE_W - MARGIN * 2;
	let y = MARGIN + FONT_SIZE; // text() positions the BASELINE, so start one line down

	for (const line of letterText.replace(/\r\n/g, "\n").split("\n")) {
		if (line.trim() === "") {
			y += LINE_HEIGHT; // blank source line → vertical gap
			continue;
		}
		// splitTextToSize does the word-wrapping measurement for us.
		for (const wrapped of doc.splitTextToSize(line, maxWidth) as string[]) {
			if (y > PAGE_H - MARGIN) {
				doc.addPage();
				y = MARGIN + FONT_SIZE;
			}
			doc.text(wrapped, MARGIN, y);
			y += LINE_HEIGHT;
		}
	}

	return doc.output("blob");
}
