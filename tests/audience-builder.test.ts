import test from "node:test";
import assert from "node:assert/strict";
import { getLookalikePercentagesForMilestone } from "../src/services/audience-builder";

test("getLookalikePercentagesForMilestone keeps early lookalikes tighter", () => {
  assert.deepEqual(getLookalikePercentagesForMilestone(100), [1, 2]);
  assert.deepEqual(getLookalikePercentagesForMilestone(200), [1, 2, 3]);
  assert.deepEqual(getLookalikePercentagesForMilestone(500), [1, 2, 3, 5]);
});
