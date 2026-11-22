import { expect } from "chai";
import fc from "fast-check";
import {
  effectiveConcurrency,
  MAX_CONCURRENCY,
  SYNC_CONCURRENCY_CAP,
} from "../src/utils/effectiveConcurrency";

// Sync jobs wait in docling-serve's queue against a 120 s budget that starts
// at submission, so sending more than the server's 2 default workers made
// the extra ones fail with a 504 before they started.

describe("effectiveConcurrency #cold", function () {
  describe("with the async endpoint", function () {
    it("When the pref is 6, then 6 conversions run at once", function () {
      // Arrange
      const raw = 6;
      // Act
      const limit = effectiveConcurrency(raw, true);
      // Assert
      expect(limit).to.equal(6);
    });

    it("When the pref is above the maximum, then it is capped at the maximum", function () {
      // Arrange
      const raw = 50;
      // Act
      const limit = effectiveConcurrency(raw, true);
      // Assert
      expect(limit).to.equal(MAX_CONCURRENCY);
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

    it("When the pref is fractional, then it rounds down", function () {
      // Arrange
      const raw = 3.7;
      // Act
      const limit = effectiveConcurrency(raw, true);
      // Assert
      expect(limit).to.equal(3);
    });
  });

  describe("invariants", function () {
    it("Property: For any input, the result is an integer within [1, cap]", function () {
      fc.assert(
        fc.property(fc.anything(), fc.boolean(), (raw, useAsync) => {
          const limit = effectiveConcurrency(raw, useAsync);
          const cap = useAsync ? MAX_CONCURRENCY : SYNC_CONCURRENCY_CAP;
          return Number.isInteger(limit) && limit >= 1 && limit <= cap;
        }),
      );
    });
  });
});
