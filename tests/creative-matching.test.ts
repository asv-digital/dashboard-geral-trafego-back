import test from "node:test";
import assert from "node:assert/strict";
import { creativeMatchesAdName } from "../src/lib/creative-matching";

test("creativeMatchesAdName matches planner naming convention", () => {
  assert.equal(
    creativeMatchesAdName("PROSP Broad -- creative 2", "PROSP Broad -- ad 2"),
    true
  );
});

test("creativeMatchesAdName rejects different variants", () => {
  assert.equal(
    creativeMatchesAdName("PROSP Broad -- creative 1", "PROSP Broad -- ad 3"),
    false
  );
});

test("creativeMatchesAdName matches exact same normalized label", () => {
  assert.equal(
    creativeMatchesAdName("Remarketing Quente Creative 1", "remarketing quente ad 1"),
    true
  );
});
