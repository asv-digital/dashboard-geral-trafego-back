import test from "node:test";
import assert from "node:assert/strict";
import { deriveThresholds } from "../src/lib/product-economics";

test("deriveThresholds is conservative on launch and more permissive on escalavel", () => {
  const launch = deriveThresholds({
    priceGross: 297,
    gatewayFeeRate: 0.035,
    netPerSale: 240,
    dailyBudgetTarget: 250,
    stage: "launch",
  });
  const scale = deriveThresholds({
    priceGross: 297,
    gatewayFeeRate: 0.035,
    netPerSale: 240,
    dailyBudgetTarget: 900,
    stage: "escalavel",
  });

  assert.ok(launch.autoScaleCPAThreshold < scale.autoScaleCPAThreshold);
  assert.ok(launch.autoScalePercent < scale.autoScalePercent);
  assert.ok(launch.autoScaleMinDays > scale.autoScaleMinDays);
  assert.ok(scale.autoScaleMaxBudget > launch.autoScaleMaxBudget);
});

test("deriveThresholds enables dayparting only for higher-signal stages", () => {
  const launch = deriveThresholds({
    priceGross: 197,
    gatewayFeeRate: 0.035,
    netPerSale: 160,
    dailyBudgetTarget: 500,
    stage: "launch",
  });
  const evergreen = deriveThresholds({
    priceGross: 197,
    gatewayFeeRate: 0.035,
    netPerSale: 160,
    dailyBudgetTarget: 500,
    stage: "evergreen",
  });

  assert.equal(launch.daypartingEnabled, false);
  assert.equal(evergreen.daypartingEnabled, true);
});
