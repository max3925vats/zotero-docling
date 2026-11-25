import { expect } from "chai";
import fc from "fast-check";
import {
  ASYNC_PREFETCH,
  effectiveConcurrency,
  MAX_CONCURRENCY,
  SYNC_CONCURRENCY_CAP,
} from "../src/utils/effectiveConcurrency";

// Sync jobs wait in docling-serve's queue against a 120 s budget that starts
// at submission, so sending more than the server's 2 default workers made
// the extra ones fail with a 504 before they started.

describe("effectiveConcurrency #cold", function () {
  describe("with the async endpoint", function () {
    it("When the pref is 6, then 6 conversions plus the prefetch are kept in flight", function () {
      // Arrange
      const raw = 6;
      // Act
      const limit = effectiveConcurrency(raw, true);
      // Assert
      expect(limit).to.equal(6 + ASYNC_PREFETCH);
    });

    it("When the pref is above the maximum, then it is capped at the maximum plus the prefetch", function () {
      // Arrange
      const raw = 50;
      // Act
      const limit = effectiveConcurrency(raw, true);
      // Assert
      expect(limit).to.equal(MAX_CONCURRENCY + ASYNC_PREFETCH);
    });

    it("When the pref is 1, then conversions stay one at a time with no prefetch", function () {
      // Arrange
      const raw = 1;
      // Act
      const limit = effectiveConcurrency(raw, true);
      // Assert
      expect(limit).to.equal(1);
    });
  });

  describe("with the sync endpoint", function () {
    it("When the pref is 8, then at most the sync cap run at once", function () {
      // Arrange
      const raw = 8;
      // Act
      const limit = effectiveConcurrency(raw, false);
      // Assert
      expect(limit).to.equal(SYNC_CONCURRENCY_CAP);
    });

    it("When the pref is 1, then conversions stay sequential", function () {
      // Arrange
      const raw = 1;
      // Act
      const limit = effectiveConcurrency(raw, false);
      // Assert
      expect(limit).to.equal(1);
    });
  });

  describe("with unusable pref values", function () {
    it("When the pref is missing, non-numeric, zero or negative, then 1 is used", function () {
      // Arrange
      const raws = [undefined, null, "", "abc", 0, -3, NaN];
      // Act
      const limits = raws.map((r) => effectiveConcurrency(r, true));
      // Assert
      expect(limits).to.deep.equal(raws.map(() => 1));
    });

    it("When the pref can't be converted to a number at all, then 1 is used instead of throwing", function () {
      // Arrange: fast-check found { toString: "" } (Number() throws on it).
      const raws = [{ toString: "" }, Symbol("x")];
      // Act
      const limits = raws.map((r) => effectiveConcurrency(r, true));
      // Assert
      expect(limits).to.deep.equal([1, 1]);
    });

    it("When the pref is fractional, then it rounds down (1.7 → 1)", function () {
      // Arrange
      const raw = 1.7;
      // Act
      const limit = effectiveConcurrency(raw, false);
      // Assert
      expect(limit).to.equal(1);
    });
  });

  describe("invariants", function () {
    it("Property: For any input, the result is an integer within [1, cap]", function () {
      fc.assert(
        fc.property(fc.anything(), fc.boolean(), (raw, useAsync) => {
          const limit = effectiveConcurrency(raw, useAsync);
          const cap = useAsync
            ? MAX_CONCURRENCY + ASYNC_PREFETCH
            : SYNC_CONCURRENCY_CAP;
          return Number.isInteger(limit) && limit >= 1 && limit <= cap;
        }),
      );
    });
  });
});
