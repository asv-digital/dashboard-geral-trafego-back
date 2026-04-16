import test from "node:test";
import assert from "node:assert/strict";
import { classifyCreative } from "../src/services/creative-stock";
import { evaluateLearningPhaseExit } from "../src/services/learning-phase";
import { pickWinner } from "../src/services/ab-test-resolver";

test("evaluateLearningPhaseExit waits for more signal after minimum hours", () => {
  const result = evaluateLearningPhaseExit({
    hoursSince: 80,
    learningPhaseHours: 72,
    approvedSales: 1,
    dailyBudgetTarget: 500,
  });

  assert.equal(result.shouldExit, false);
  assert.match(result.reason, /aguardando sinal/i);
});

test("evaluateLearningPhaseExit exits when signal is sufficient", () => {
  const result = evaluateLearningPhaseExit({
    hoursSince: 80,
    learningPhaseHours: 72,
    approvedSales: 4,
    dailyBudgetTarget: 500,
  });

  assert.equal(result.shouldExit, true);
  assert.match(result.reason, /sinal mínimo atingido/i);
});

test("classifyCreative marks weak scale video as exhausted", () => {
  const result = classifyCreative(
    {
      type: "video",
      createdAt: new Date(Date.now() - 12 * 24 * 60 * 60 * 1000),
      hookRate: 2.1,
      cpa: 180,
      ctr: 0.7,
      thruplayRate: 12,
      stage: "escalavel",
      dailyBudgetTarget: 900,
    },
    150
  );

  assert.equal(result.health, "exhausted");
});

test("classifyCreative keeps young launch asset healthy when metrics are solid", () => {
  const result = classifyCreative(
    {
      type: "video",
      createdAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
      hookRate: 5.4,
      cpa: 70,
      ctr: 1.8,
      thruplayRate: 28,
      stage: "launch",
      dailyBudgetTarget: 250,
    },
    140
  );

  assert.equal(result.health, "healthy");
});

test("pickWinner chooses the variant with sales when the other spent and sold nothing", () => {
  const result = pickWinner(
    {
      metaAdId: "ad_a",
      id: "A",
      name: "A",
      spend: 180,
      sales: 3,
      cpa: 60,
    },
    {
      metaAdId: "ad_b",
      id: "B",
      name: "B",
      spend: 170,
      sales: 0,
      cpa: 0,
    }
  );

  assert.ok(result);
  assert.equal(result?.winner.name, "A");
  assert.equal(result?.loser.name, "B");
});
