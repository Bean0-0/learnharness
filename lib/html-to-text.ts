/**
 * HTML notes → readable Markdown-ish text for graph extraction (#190).
 *
 * Exported course notes are overwhelmingly non-text: base64 images and
 * MathJax SVG glyph paths made up ~99% of a real 24.6 MB folder, which made
 * raw-HTML extraction cost millions of tokens. Strip all of that, keep the
 * document structure, and keep math by linearizing the MathML that MathJax
 * ships alongside its SVG (mjx-assistive-mml) or that pages embed directly.
 */
import { parseHTML } from "linkedom";
import TurndownService from "turndown";

const DROP = "script, style, noscript, template, svg, img, picture, video, audio, canvas, iframe, object, embed, link, meta";

type El = Element;

/** MathML → compact linear text: (a)/(b), x^(2), x_(i), sqrt(n). */
function linearizeMath(node: El): string {
	const kids = Array.from(node.children);
	const sub = (i: number) => (kids[i] ? linearizeMath(kids[i]) : "");
	const group = (s: string) => `(${s})`;
	switch (node.localName) {
		case "mi": case "mn": case "mtext": case "ms":
			return (node.textContent ?? "").trim();
		case "mo": {
			const op = (node.textContent ?? "").trim();
			if (op === ",") return ", ";
			return /^[=<>≤≥≠≈±∓+−\-×·÷→←↔∈∉⊂⊆∪∩]$/.test(op) ? ` ${op} ` : op;
		}
		case "mspace": return " ";
		case "mfrac": return `${group(sub(0))}/${group(sub(1))}`;
		case "msqrt": return `sqrt(${kids.map(linearizeMath).join("")})`;
		case "mroot": return `root(${sub(1)})(${sub(0)})`;
		case "msup": return `${sub(0)}^${group(sub(1))}`;
		case "msub": return `${sub(0)}_${group(sub(1))}`;
		case "msubsup": return `${sub(0)}_${group(sub(1))}^${group(sub(2))}`;
		case "munder": return `${sub(0)}_${group(sub(1))}`;
		case "mover": return `${sub(0)}^${group(sub(1))}`;
		case "munderover": return `${sub(0)}_${group(sub(1))}^${group(sub(2))}`;
		case "annotation": case "annotation-xml": return "";
		case "semantics": return sub(0);
		case "mtable":
			return kids.map((row) => Array.from(row.children).map(linearizeMath).join(" & ")).join(" \\\\ ");
		default:
			return kids.length ? kids.map(linearizeMath).join("") : (node.textContent ?? "").trim();
	}
}

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
// Math placeholders carry pre-linearized text; emit verbatim (no escaping).
turndown.addRule("lhMath", {
	filter: (node) => node.nodeName.toLowerCase() === "lh-math",
	replacement: (_content, node) => `$${(node.textContent ?? "").trim()}$`,
});
turndown.addRule("tableCell", {
	filter: ["th", "td"],
	replacement: (content) => ` ${content.replace(/\s+/g, " ").trim()} |`,
});
turndown.addRule("tableRow", {
	filter: "tr",
	replacement: (content) => `\n|${content}`,
});
turndown.addRule("table", {
	filter: "table",
	replacement: (content) => `\n\n${content.trim()}\n\n`,
});
turndown.addRule("tableSection", {
	filter: ["thead", "tbody", "tfoot"],
	replacement: (content) => content,
});

export function htmlToNotesText(html: string): string {
	// linkedom yields no body for bare fragments; wrap them.
	const { document } = parseHTML(/<html[\s>]/i.test(html) ? html : `<!doctype html><html><body>${html}</body></html>`);
	const root = (document.body ?? document.documentElement) as El | null;
	if (!root) return "";
	// Replace every <math> with a text placeholder BEFORE dropping SVG, then
	// drop the SVG renderings (their glyph paths duplicate the MathML).
	for (const math of Array.from(root.querySelectorAll("math"))) {
		const text = linearizeMath(math).replace(/\s+/g, " ").trim();
		const holder = document.createElement("lh-math");
		// Text content (not an attribute): turndown drops blank elements.
		holder.textContent = text;
		const container = math.closest("mjx-container") ?? math;
		// One placeholder per MathJax container (SVG + assistive MathML).
		if (container !== math && container.querySelector("lh-math")) { math.remove(); continue; }
		if (container !== math) { container.replaceChildren(holder); } else { math.replaceWith(holder); }
		if (!text) holder.remove();
	}
	for (const el of Array.from(root.querySelectorAll(DROP))) el.remove();
	return turndown
		.turndown(root.innerHTML)
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}
