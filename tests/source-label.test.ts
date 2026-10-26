import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tidySourceLabel } from "../src/core/source-label.ts";

describe("tidySourceLabel: a category name from an imported file path", () => {
	it("drops folders, the extension and the order-number prefix, splits words", () => {
		const cases: [string, string][] = [
			["markdown/notes/09_chapter3normal.md", "Chapter 3 normal"],
			["markdown/notes/02_chapter1StatisticalConcepts.md", "Chapter 1 Statistical Concepts"],
			["markdown/notes/18_chapter7confIntInterpretationAndSampleSize.md", "Chapter 7 conf Int Interpretation And Sample Size"],
			["markdown/notes/14_chapter5samplingDistributionCLT.md", "Chapter 5 sampling Distribution CLT"],
			["markdown/notes/32_RR.md", "RR"],
			["markdown/index.md", "Index"],
			["STAT 211 notes/notes/23_chapter8hypTestingProportion.html", "Chapter 8 hyp Testing Proportion"],
			["/vault/learn vim.md", "Learn vim"],
			["my-notes_v2.txt", "My notes v2"],
			["XMLParserNotes.markdown", "XML Parser Notes"],
			["C:\\notes\\week 3.md", "Week 3"],
		];
		for (const [path, label] of cases) assert.equal(tidySourceLabel(path), label, path);
	});

	it("never returns an empty label", () => {
		assert.equal(tidySourceLabel("notes/2024.md"), "2024", "an all-number name keeps its number");
		assert.equal(tidySourceLabel("notes/.md"), ".md");
		assert.equal(tidySourceLabel("___.txt"), "___.txt");
	});
});
