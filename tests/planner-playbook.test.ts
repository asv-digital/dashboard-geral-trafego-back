import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPlannerPlaybook,
  getStrategyAssetRecommendations,
  resolvePlaybookAudienceTargets,
  type PlannerPlaybookCampaign,
} from "../src/lib/planner-playbook";

const basePlan: PlannerPlaybookCampaign = {
  name: "PROSP LAL 1-3%",
  type: "Prospecção",
  dailyBudget: 100,
  audience: "lookalike_1_3",
  targeting: { geo_locations: { countries: ["BR"] } },
  optimizationGoal: "OFFSITE_CONVERSIONS",
  usesAdvantage: false,
};

test("resolvePlaybookAudienceTargets skips missing lookalike plans", () => {
  const result = resolvePlaybookAudienceTargets([basePlan], {});

  assert.equal(result.planned.length, 0);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /lookalike 1-3% indispon/i);
});

test("resolvePlaybookAudienceTargets injects lookalike audience", () => {
  const result = resolvePlaybookAudienceTargets([basePlan], {
    lookalike: { id: "aud_123", name: "LAL 1% compradores" },
  });

  assert.equal(result.planned.length, 1);
  assert.deepEqual(result.planned[0].targeting.custom_audiences, [{ id: "aud_123" }]);
  assert.equal(result.planned[0].audience, "LAL 1% compradores");
});

test("resolvePlaybookAudienceTargets skips warm remarketing without audience", () => {
  const result = resolvePlaybookAudienceTargets(
    [
      {
        ...basePlan,
        name: "RMK Quente",
        type: "Remarketing",
        audience: "website_visitors_30d",
      },
    ],
    {}
  );

  assert.equal(result.planned.length, 0);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /audiencia quente de remarketing/i);
});

test("resolvePlaybookAudienceTargets injects warm audience", () => {
  const result = resolvePlaybookAudienceTargets(
    [
      {
        ...basePlan,
        name: "RMK Quente",
        type: "Remarketing",
        audience: "website_visitors_30d",
      },
    ],
    {
      warmAudience: { id: "aud_warm", name: "Visitantes 30d" },
    }
  );

  assert.equal(result.planned.length, 1);
  assert.deepEqual(result.planned[0].targeting.custom_audiences, [{ id: "aud_warm" }]);
  assert.equal(result.planned[0].audience, "Visitantes 30d");
});

test("buildPlannerPlaybook keeps launch compact on lower budget", () => {
  const result = buildPlannerPlaybook("launch", 250);

  assert.equal(result.length, 2);
  assert.equal(result.reduce((sum, plan) => sum + plan.dailyBudget, 0), 250);
  assert.match(result[0].name, /Controle|Validacao/i);
});

test("resolvePlaybookAudienceTargets redistributes missing audience budget", () => {
  const playbook = buildPlannerPlaybook("escalavel", 500);

  const result = resolvePlaybookAudienceTargets(
    playbook,
    {
      warmAudience: { id: "warm_1", name: "Warm 30d" },
    },
    500
  );

  assert.equal(result.planned.length, 3);
  assert.equal(result.planned.reduce((sum, plan) => sum + plan.dailyBudget, 0), 500);
  assert.match(result.warnings.join(" "), /redistribuido/i);
});

test("getStrategyAssetRecommendations grows inventory needs for scale stages", () => {
  const launch = getStrategyAssetRecommendations("launch", 250);
  const escalavel = getStrategyAssetRecommendations("escalavel", 900);

  assert.equal(launch.recommendedMediaAssets, 2);
  assert.equal(launch.creativeSlotLimit, 2);
  assert.ok(escalavel.recommendedMediaAssets >= 6);
  assert.ok(escalavel.recommendedTextAssets >= 5);
  assert.ok(escalavel.creativeSlotLimit >= 5);
});
