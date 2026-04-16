import test from "node:test";
import assert from "node:assert/strict";
import { checkStorageHealth, getStorageMode, getLocalUploadsRoot } from "../src/lib/storage";

test("storage health is available in local fallback mode", async () => {
  assert.equal(getStorageMode(), "local");

  const health = await checkStorageHealth();
  assert.equal(health.ok, true);
  assert.equal(health.mode, "local");
  assert.match(health.message, /storage local/i);
  assert.ok(getLocalUploadsRoot().length > 0);
});
