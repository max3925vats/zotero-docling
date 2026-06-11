import { expect } from "chai";
import * as fc from "fast-check";
import {
  truncateMiddle,
  formatDuration,
  formatBytes,
} from "../src/utils/format";

// Style notes for this file (Goldberg testing best practices):
//   #1.1 — 3-part test names (what / when / expected).
//   #1.2 — AAA structure with explicit Arrange / Act / Assert comments.
//   #1.3 — BDD-style `expect(...).to...` assertions over `assert.equal`.
//   #1.7 — Property-based tests with fast-check for invariants that should
//          hold over the entire input space.
//   #1.11 — Tagged `#cold` (fast, no IO) so a future runner config can grep.

describe("format helpers #cold", function () {
  describe("truncateMiddle", function () {
    // --------- Example-based tests ---------

    it("When input length is below max, then the original string is returned unchanged", function () {
      // Arrange
      const input = "short.pdf";
      const max = 40;

      // Act
      const result = truncateMiddle(input, max);

      // Assert
      expect(result).to.equal(input);
    });

    it("When input length equals max, then the original string is returned unchanged", function () {
      // Arrange
      const input = "x".repeat(10);
      const max = 10;

      // Act
      const result = truncateMiddle(input, max);

      // Assert
      expect(result).to.equal(input);
    });

    it("When max is 3 or less, then the head is returned with no ellipsis (because the ellipsis itself would not fit)", function () {
      // Arrange & Act
      const out3 = truncateMiddle("abcdefgh", 3);
      const out1 = truncateMiddle("abcdefgh", 1);

      // Assert
      expect(out3).to.equal("abc");
      expect(out1).to.equal("a");
      expect(out3).to.not.include("…");
      expect(out1).to.not.include("…");
    });

    it("When input is truncated, then both the head and tail of the original survive around an ellipsis", function () {
      // Arrange — realistic filename (Goldberg #1.6) instead of "foo".
      const filename = "very_long_paper_title_with_authors_and_more_stuff.pdf";
      const max = 30;

      // Act
      const result = truncateMiddle(filename, max);

      // Assert
      expect(result).to.have.lengthOf(max);
      expect(result).to.include("…");
      expect(result.startsWith("very_long_paper")).to.equal(true);
      expect(result.endsWith(".pdf")).to.equal(true);
    });

    it("When max=11 on a 16-char input, then the head/tail split is balanced (5 + ellipsis + 5)", function () {
      // Arrange — the issue-spec'd case: max=11 → keep=10 → head=ceil(5)=5, tail=floor(5)=5.
      const input = "abcdefghijklmnop";
      const max = 11;

      // Act
      const result = truncateMiddle(input, max);

      // Assert
      expect(result).to.equal("abcde…lmnop");
    });

    // --------- Property-based tests (fast-check) ---------
    //
    // Invariants that should hold over the entire input space, not just the
    // hand-picked examples above. fast-check shrinks counter-examples so
    // failures point at the minimum input that breaks the property.

    it("Property: For any string and any max ≥ 1, the result is never longer than max", function () {
      // Arrange / Act / Assert — all inside the property body.
      fc.assert(
        fc.property(fc.string(), fc.integer({ min: 1, max: 200 }), (s, max) => {
          const result = truncateMiddle(s, max);
          expect(result.length).to.be.at.most(max);
        }),
      );
    });

    it("Property: When input.length ≤ max, then the result equals the input", function () {
      fc.assert(
        fc.property(fc.string({ minLength: 0, maxLength: 50 }), (s) => {
          // Use max strictly ≥ s.length so the no-truncate branch is hit.
          const max = s.length + 1;
          const result = truncateMiddle(s, max);
          expect(result).to.equal(s);
        }),
      );
    });

    it("Property: When max ≥ 4 and input is longer than max, then the result always contains the ellipsis character", function () {
      fc.assert(
        fc.property(
          fc.string({ minLength: 5, maxLength: 200 }),
          fc.integer({ min: 4, max: 199 }),
          (s, max) => {
            // Pre-condition: only assert on inputs that will actually be truncated.
            fc.pre(s.length > max);
            const result = truncateMiddle(s, max);
            expect(result).to.include("…");
          },
        ),
      );
    });
  });

  describe("formatDuration", function () {
    // --------- Example-based tests ---------

    it("When the input is zero, undefined, NaN, or negative, then '0s' is returned", function () {
      // Arrange & Act & Assert — `0s` is the documented fallback for invalid input.
      expect(formatDuration(0)).to.equal("0s");
      expect(formatDuration(undefined)).to.equal("0s");
      expect(formatDuration(NaN)).to.equal("0s");
      expect(formatDuration(-5)).to.equal("0s");
    });

    it("When the duration is under a minute, then it is formatted as 'Xs'", function () {
      // Arrange & Act & Assert
      expect(formatDuration(42)).to.equal("42s");
      expect(formatDuration(59)).to.equal("59s");
    });

    it("When the duration is between one minute and one hour, then it is formatted as 'Mm Ss' (seconds dropped when zero)", function () {
      // Arrange & Act & Assert
      expect(formatDuration(60)).to.equal("1m");
      expect(formatDuration(252)).to.equal("4m 12s");
      expect(formatDuration(3599)).to.equal("59m 59s");
    });

    it("When the duration is at least one hour, then it is formatted as 'Hh Mm Ss' (seconds dropped when zero, minutes always retained)", function () {
      // Arrange & Act & Assert — the JSDoc example: 3725s → '1h 2m 5s'.
      // At hour boundaries we still emit '1h 0m', not '1h' — the spec only
      // drops seconds when they're zero, not minutes.
      expect(formatDuration(3600)).to.equal("1h 0m");
      expect(formatDuration(3725)).to.equal("1h 2m 5s");
      expect(formatDuration(7200)).to.equal("2h 0m");
    });

    // --------- Property-based tests (fast-check) ---------

    it("Property: For any non-negative finite input, the result is a non-empty string", function () {
      fc.assert(
        fc.property(fc.float({ min: 0, max: 100000, noNaN: true }), (n) => {
          const out = formatDuration(n);
          expect(out).to.be.a("string");
          expect(out.length).to.be.greaterThan(0);
        }),
      );
    });
  });

  describe("formatBytes", function () {
    // --------- Example-based tests ---------

    it("When the input is zero, undefined, NaN, or negative, then '0 B' is returned", function () {
      // Arrange & Act & Assert — `0 B` is the documented fallback.
      expect(formatBytes(0)).to.equal("0 B");
      expect(formatBytes(undefined)).to.equal("0 B");
      expect(formatBytes(NaN)).to.equal("0 B");
      expect(formatBytes(-1024)).to.equal("0 B");
    });

    it("When the input is below 1024, then whole bytes are shown with no decimal", function () {
      // Arrange & Act & Assert
      expect(formatBytes(1)).to.equal("1 B");
      expect(formatBytes(512)).to.equal("512 B");
      expect(formatBytes(1023)).to.equal("1023 B");
    });

    it("When the input crosses a unit boundary, then it is scaled to one decimal in that unit", function () {
      // Arrange & Act & Assert — the toast-facing cases: KB for small
      // markdown, MB for a typical base64-bloated paper.
      expect(formatBytes(1024)).to.equal("1.0 KB");
      expect(formatBytes(1536)).to.equal("1.5 KB");
      expect(formatBytes(18 * 1024 * 1024)).to.equal("18.0 MB");
      expect(formatBytes(2.5 * 1024 * 1024 * 1024)).to.equal("2.5 GB");
    });

    // --------- Property-based tests (fast-check) ---------

    it("Property: For any finite input, the result is a non-empty string ending in a known unit", function () {
      fc.assert(
        fc.property(fc.double({ min: -1e15, max: 1e15, noNaN: true }), (n) => {
          const out = formatBytes(n);
          expect(out).to.match(/^\d+(\.\d)? (B|KB|MB|GB|TB)$/);
        }),
      );
    });
  });
});
