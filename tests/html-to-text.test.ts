import assert from "node:assert/strict";
import { it } from "node:test";
import { htmlToNotesText } from "../lib/html-to-text.ts";

// Synthetic fixture shaped like exported course notes: MathJax SVG output with
// hidden assistive MathML, embedded base64 images, styles and scripts.
const IMAGE = `data:image/png;base64,${"iVBORw0KGgo".repeat(2000)}`;
const fixture = `<!doctype html><html><head><title>Normal distribution</title>
<style>.x { color: red } ${"p{}".repeat(500)}</style><script>window.tracking = 1</script></head>
<body>
<h1>Chapter 3: The normal distribution</h1>
<p>The <b>standard normal</b> has mean
<mjx-container class="MathJax" jax="SVG"><svg viewBox="0 0 10 10"><path d="${"M0 0L1 1".repeat(300)}"/></svg>
<mjx-assistive-mml><math><mi>μ</mi><mo>=</mo><mn>0</mn></math></mjx-assistive-mml></mjx-container>.</p>
<p>Standardize with <math><mi>Z</mi><mo>=</mo><mfrac><mrow><mi>X</mi><mo>−</mo><mi>μ</mi></mrow><mi>σ</mi></mfrac></math>
and variance <math><msup><mi>σ</mi><mn>2</mn></msup></math>, sample <math><msub><mi>x</mi><mi>i</mi></msub></math>,
error <math><msqrt><mi>n</mi></msqrt></math>.</p>
<img src="${IMAGE}" alt="">
<ul><li>Symmetric about the mean</li><li>68–95–99.7 rule</li></ul>
<table><tr><th>z</th><th>P(Z ≤ z)</th></tr><tr><td>1.96</td><td>0.975</td></tr></table>
<noscript>Enable JavaScript</noscript>
</body></html>`;

it("keeps readable structure and linearized math while dropping images, SVG, styles and scripts", () => {
	const text = htmlToNotesText(fixture);
	assert.match(text, /^# Chapter 3: The normal distribution$/m);
	assert.match(text, /\*\*standard normal\*\*/);
	assert.match(text, /\$μ = 0\$/);
	assert.match(text, /\$Z = \(X − μ\)\/\(σ\)\$/);
	assert.match(text, /\$σ\^\(2\)\$/);
	assert.match(text, /\$x_\(i\)\$/);
	assert.match(text, /\$sqrt\(n\)\$/);
	assert.match(text, /^-\s+Symmetric about the mean$/m);
	assert.match(text, /^\| z \| P\(Z ≤ z\) \|$/m);
	assert.match(text, /^\| 1\.96 \| 0\.975 \|$/m);
	for (const gone of ["base64", "<svg", "M0 0L1 1", "color: red", "tracking", "Enable JavaScript", "<"]) {
		assert.ok(!text.includes(gone), `unexpected ${gone}`);
	}
	assert.ok(text.length * 20 < fixture.length, `expected large reduction, got ${text.length}/${fixture.length}`);
});

it("does not duplicate math rendered both as SVG text and assistive MathML", () => {
	const text = htmlToNotesText(`<p><mjx-container><svg><text>μ</text></svg><mjx-assistive-mml><math><mi>μ</mi></math></mjx-assistive-mml></mjx-container></p>`);
	assert.equal(text, "$μ$");
});

it("returns empty text for markup with no readable content", () => {
	assert.equal(htmlToNotesText(`<html><head><style>p{}</style></head><body><img src="${IMAGE}"><svg></svg></body></html>`), "");
});
