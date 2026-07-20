import { Document, HeadingLevel, Packer, Paragraph, TextRun } from "docx";

// ---------------------------------------------------------------------------
// docx.ts — turn the assembled tailored resume (markdown-ish text) into a real
// Word .docx, entirely in the browser. No server round-trip: the `docx` package
// builds the OOXML zip in memory and hands back a Blob.
//
// Also exports saveBlobAs(): a "where do you want to save this?" flow using the
// File System Access API (Chrome/Edge show a native save dialog); browsers
// without it (Firefox/Safari) fall back to a normal download.
// ---------------------------------------------------------------------------

// Inline markdown → styled runs. Only **bold** is handled — resumes rarely need
// more, and anything unrecognized passes through as plain text.
function runsFrom(text: string): TextRun[] {
	const runs: TextRun[] = [];
	for (const part of text.split(/(\*\*[^*]+\*\*)/g)) {
		if (part === "") continue;
		if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
			runs.push(new TextRun({ text: part.slice(2, -2), bold: true }));
		} else {
			runs.push(new TextRun(part));
		}
	}
	return runs;
}

const HEADINGS = [
	HeadingLevel.HEADING_1,
	HeadingLevel.HEADING_2,
	HeadingLevel.HEADING_3,
] as const;

// One markdown line → one Word paragraph (or null for blank lines — vertical
// rhythm comes from per-paragraph spacing instead, which is how Word thinks).
function lineToParagraph(line: string): Paragraph | null {
	const heading = /^(#{1,3})\s+(.*)$/.exec(line);
	if (heading) {
		return new Paragraph({
			children: runsFrom(heading[2] ?? ""),
			heading: HEADINGS[heading[1].length - 1],
			spacing: { before: 240, after: 120 },
		});
	}
	const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
	if (bullet) {
		return new Paragraph({
			children: runsFrom(bullet[1] ?? ""),
			bullet: { level: 0 },
			spacing: { after: 60 },
		});
	}
	if (line.trim() === "") return null;
	return new Paragraph({ children: runsFrom(line), spacing: { after: 120 } });
}

// The full document: line-by-line conversion of the resume text.
export function markdownToDocxBlob(markdown: string): Promise<Blob> {
	const children = markdown
		.split(/\r?\n/)
		.map(lineToParagraph)
		.filter((p): p is Paragraph => p !== null);
	const doc = new Document({ sections: [{ children }] });
	return Packer.toBlob(doc);
}

// A single PascalCase filename token: "Acme Corp!" → "AcmeCorp".
export function fileToken(s: string): string {
	const token = s
		.split(/[^A-Za-z0-9]+/)
		.filter(Boolean)
		.map((w) => w[0].toUpperCase() + w.slice(1))
		.join("")
		.slice(0, 60);
	return token || "Untitled";
}

// showSaveFilePicker is a WICG API not yet in TypeScript's DOM lib — declare
// just the slice we use, as optional (Firefox/Safari don't implement it).
type SaveFilePicker = (options: {
	suggestedName: string;
	types: { description: string; accept: Record<string, string[]> }[];
}) => Promise<FileSystemFileHandle>;

declare global {
	interface Window {
		showSaveFilePicker?: SaveFilePicker;
	}
}

const DOCX_MIME =
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document";

// Save a blob with a "choose where" dialog when the browser has one.
// "cancelled" = the user closed the picker (not an error — just do nothing).
export async function saveBlobAs(
	blob: Blob,
	suggestedName: string,
): Promise<"saved" | "cancelled"> {
	if (window.showSaveFilePicker) {
		try {
			const handle = await window.showSaveFilePicker({
				suggestedName,
				types: [
					{ description: "Word document", accept: { [DOCX_MIME]: [".docx"] } },
				],
			});
			const writable = await handle.createWritable();
			await writable.write(blob);
			await writable.close();
			return "saved";
		} catch (err) {
			if (err instanceof DOMException && err.name === "AbortError") {
				return "cancelled";
			}
			throw err;
		}
	}
	// Fallback: classic download (lands in the browser's Downloads folder, or
	// prompts if the browser is set to "ask where to save each file").
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = suggestedName;
	a.click();
	URL.revokeObjectURL(url);
	return "saved";
}
