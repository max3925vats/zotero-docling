import { expect } from "chai";
import * as fc from "fast-check";
import {
  stripImagesFromMarkdown,
  IMAGE_PLACEHOLDER,
} from "../src/utils/stripImages";

// Style notes for this file (Goldberg testing best practices):
//   #1.1 — 3-part test names (what / when / expected).
//   #1.2 — AAA structure with explicit Arrange / Act / Assert comments.
//   #1.3 — BDD-style `expect(...).to...` assertions.
//   #1.7 — Property-based tests with fast-check for invariants.
//   #1.11 — Tagged `#cold` (fast, no IO).

describe("stripImagesFromMarkdown #cold", function () {
  // --------- Example-based tests ---------

  it("When the markdown contains an embedded base64 image, then it is replaced with the placeholder", function () {
    // Arrange — the shape docling emits in image_export_mode=embedded.
    const md = [
      "## 3 Results",
      "",
      "![Image](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB)",
      "",
      "Figure 2 shows the pipeline.",
    ].join("\n");

    // Act
    const { markdown, replaced } = stripImagesFromMarkdown(md);

    // Assert
    expect(replaced).to.equal(1);
    expect(markdown).to.not.include("data:image");
    expect(markdown).to.include(IMAGE_PLACEHOLDER);
    expect(markdown).to.include("Figure 2 shows the pipeline.");
  });

  it("When an image sits inside a table cell, then the placeholder lands inline and the table structure survives", function () {
    // Arrange
    const md =
      "| Model | Fig |\n|---|---|\n| BERT | ![Image](data:image/png;base64,AAAA) |";

    // Act
    const { markdown, replaced } = stripImagesFromMarkdown(md);

    // Assert
    expect(replaced).to.equal(1);
    expect(markdown).to.include(`| BERT | ${IMAGE_PLACEHOLDER} |`);
  });

  it("When a line contains several images, then each is replaced and counted individually", function () {
    // Arrange
    const md = '![a](x.png) text ![b](y.png "title") more ![](z.png)';

    // Act
    const { markdown, replaced } = stripImagesFromMarkdown(md);

    // Assert
    expect(replaced).to.equal(3);
    expect(markdown).to.equal(
      `${IMAGE_PLACEHOLDER} text ${IMAGE_PLACEHOLDER} more ${IMAGE_PLACEHOLDER}`,
    );
  });

  it("When the markdown contains raw HTML <img> tags, then they are replaced too", function () {
    // Arrange — self-closing, attribute-laden, and pointlessly-closed forms.
    const md = [
      '<img src="data:image/png;base64,AAAA"/>',
      '<IMG src="fig1.png" alt="Figure 1" width="400">',
      '<img src="fig2.png"></img>',
    ].join("\n");

    // Act
    const { markdown, replaced } = stripImagesFromMarkdown(md);

    // Assert
    expect(replaced).to.equal(3);
    expect(markdown).to.equal(
      [IMAGE_PLACEHOLDER, IMAGE_PLACEHOLDER, IMAGE_PLACEHOLDER].join("\n"),
    );
  });

  it("When image syntax appears inside a fenced code block, then it is left untouched", function () {
    // Arrange — a paper ABOUT markdown: the sample in the code block is
    // content, not an image. Backtick and tilde fences both count.
    const md = [
      "Before",
      "```markdown",
      "![Image](data:image/png;base64,AAAA)",
      "```",
      "~~~",
      '<img src="x.png">',
      "~~~",
      "![real](data:image/png;base64,BBBB)",
    ].join("\n");

    // Act
    const { markdown, replaced } = stripImagesFromMarkdown(md);

    // Assert — only the image outside the fences is replaced.
    expect(replaced).to.equal(1);
    expect(markdown).to.include("![Image](data:image/png;base64,AAAA)");
    expect(markdown).to.include('<img src="x.png">');
    expect(markdown).to.not.include("BBBB");
  });

  it("When the markdown contains no images, then the input is returned unchanged with replaced=0", function () {
    // Arrange — exclamation marks and brackets that are NOT image syntax.
    const md =
      "# Title\n\nSee [the repo](https://example.org)! Tables stay:\n\n| a | b |\n|---|---|\n| 1 | 2 |";

    // Act
    const { markdown, replaced } = stripImagesFromMarkdown(md);

    // Assert
    expect(replaced).to.equal(0);
    expect(markdown).to.equal(md);
  });

  it("When the markdown already uses placeholders, then a second pass changes nothing", function () {
    // Arrange — what image_export_mode=placeholder (or a prior run) produces.
    const md = `Intro\n\n${IMAGE_PLACEHOLDER}\n\nOutro`;

    // Act
    const { markdown, replaced } = stripImagesFromMarkdown(md);

    // Assert
    expect(replaced).to.equal(0);
    expect(markdown).to.equal(md);
  });

  // --------- Property-based tests (fast-check) ---------

  it("Property: For any input, stripping twice equals stripping once (idempotence)", function () {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const once = stripImagesFromMarkdown(s).markdown;
        const twice = stripImagesFromMarkdown(once);
        expect(twice.markdown).to.equal(once);
        expect(twice.replaced).to.equal(0);
      }),
    );
  });

  it("Property: For any input, replaced=0 implies the output is the input, verbatim", function () {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const { markdown, replaced } = stripImagesFromMarkdown(s);
        fc.pre(replaced === 0);
        expect(markdown).to.equal(s);
      }),
    );
  });

  it("Property: The output never grows — placeholders are at most as long as what they replace plus slack", function () {
    // Arrange — generate docs with a known number of embedded images and
    // check the byte-saving contract the toast relies on: replacing a
    // base64 image (always longer than the placeholder) shrinks the text.
    const imageArb = fc
      .base64String({ minLength: 32, maxLength: 256 })
      .map((b64) => `![Image](data:image/png;base64,${b64})`);
    fc.assert(
      fc.property(
        fc.array(imageArb, { minLength: 1, maxLength: 5 }),
        (imgs) => {
          const md = `# Doc\n\n${imgs.join("\n\n")}\n\nEnd`;
          const { markdown, replaced } = stripImagesFromMarkdown(md);
          expect(replaced).to.equal(imgs.length);
          expect(markdown.length).to.be.lessThan(md.length);
          expect(markdown).to.not.include("base64");
        },
      ),
    );
  });
});
