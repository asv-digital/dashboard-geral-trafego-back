// Scheduler product-aware com pipeline completo:
//   0. clean locks expirados
//   1. collect insights de cada produto (meta api)
//   2. update learning phase
//   3. auto-executor (pause/scale)
//   4. budget-rebalancer
//   5. dayparting
//   6. ab-test-resolver
//   7. creative-stock
//   8. comment-analyzer (LLM)
//   9. audience-builder (lookalikes em milestones)
//
// Tudo por produto. Falha em um não derruba os outros.

import { collectAllProducts } from "./collector";
import type { ProductCollectionResult } from "./types";
import { cleanExpiredLocks } from "../services/automation-coordinator";
import { updateLearningPhaseAll } from "../services/learning-phase";
import { executeAllAutomations } from "../services/auto-executor";
import { rebalanceAll } from "../services/budget-rebalancer";
import { applyDaypartingAll } from "../services/dayparting";
import { resolveActiveTestsAll } from "../services/ab-test-resolver";
import { checkCreativeStockAll } from "../services/creative-stock";
import { analyzeCommentsAll } from "../services/comment-analyzer";
import { checkLookalikeAll } from "../services/audience-builder";

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const RUN_INTERVAL_MINUTES = parsePositiveInt(process.env.AGENT_RUN_INTERVAL_MINUTES, 240);
const STARTUP_DELAY_SECONDS = parsePositiveInt(process.env.AGENT_STARTUP_DELAY_SECONDS, 30);
const RUN_INTERVAL_MS = RUN_INTERVAL_MINUTES * 60 * 1000;
const STARTUP_DELAY_MS = STARTUP_DELAY_SECONDS * 1000;

let isRunning = false;
let lastRunAt: string | null = null;
let nextRunAt: string | null = null;
let lastResults: ProductCollectionResult[] = [];
let lastError: string | null = null;
let intervalHandle: ReturnType<typeof setInterval> | null = null;

async function runPipeline(): Promise<ProductCollectionResult[]> {
  if (isRunning) {
    console.log("[scheduler] já rodando, pulando");
    return lastResults;
  }
  isRunning = true;
  const startedAt = new Date().toISOString();
  console.log(`[scheduler] ▶︎ pipeline iniciado em ${startedAt}`);

  try {
    // 0. locks
    try {
      const cleaned = await cleanExpiredLocks();
      if (cleaned > 0) console.log(`[scheduler] ${cleaned} locks expirados limpos`);
    } catch (err) {
      console.error(`[scheduler] clean locks falhou: ${(err as Error).message}`);
    }

    // 1. collect
    const results = await collectAllProducts();
    lastResults = results;

    // 2. learning phase
    try {
      await updateLearningPhaseAll();
    } catch (err) {
      console.error(`[scheduler] learning-phase falhou: ${(err as Error).message}`);
    }

    // 3. auto-executor
    try {
      await executeAllAutomations();
    } catch (err) {
      console.error(`[scheduler] auto-executor falhou: ${(err as Error).message}`);
    }

    // 4. rebalance
    try {
      await rebalanceAll();
    } catch (err) {
      console.error(`[scheduler] rebalance falhou: ${(err as Error).message}`);
    }

    // 5. dayparting
    try {
      await applyDaypartingAll();
    } catch (err) {
      console.error(`[scheduler] dayparting falhou: ${(err as Error).message}`);
    }

    // 6. AB tests
    try {
      await resolveActiveTestsAll();
    } catch (err) {
      console.error(`[scheduler] ab-resolver falhou: ${(err as Error).message}`);
    }

    // 7. creative stock
    try {
      await checkCreativeStockAll();
    } catch (err) {
      console.error(`[scheduler] creative-stock falhou: ${(err as Error).message}`);
    }

    // 8. comment analyzer (LLM)
    try {
      await analyzeCommentsAll();
    } catch (err) {
      console.error(`[scheduler] comment-analyzer falhou: ${(err as Error).message}`);
    }

    // 9. audience builder (lookalikes)
    try {
      await checkLookalikeAll();
    } catch (err) {
      console.error(`[scheduler] audience-builder falhou: ${(err as Error).message}`);
    }

    lastRunAt = new Date().toISOString();
    lastError = null;
    console.log(`[scheduler] ◀︎ pipeline finalizado em ${lastRunAt}`);
    return results;
  } catch (err) {
    lastError = (err as Error).message;
    console.error(`[scheduler] erro global: ${lastError}`);
    return lastResults;
  } finally {
    isRunning = false;
    nextRunAt = new Date(Date.now() + RUN_INTERVAL_MS).toISOString();
  }
}

export function startScheduler(): void {
  if (intervalHandle) return;
  console.log(`[scheduler] aguardando ${STARTUP_DELAY_MS / 1000}s antes do primeiro ciclo`);
  setTimeout(async () => {
    await runPipeline();
    intervalHandle = setInterval(runPipeline, RUN_INTERVAL_MS);
    console.log(`[scheduler] intervalo de ${RUN_INTERVAL_MINUTES} minuto(s) ativo`);
  }, STARTUP_DELAY_MS);
  nextRunAt = new Date(Date.now() + STARTUP_DELAY_MS).toISOString();
}

export function stopScheduler(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

export async function runCollectionNow(): Promise<ProductCollectionResult[]> {
  return runPipeline();
}

export function getSchedulerStatus() {
  return {
    isRunning,
    lastRunAt,
    nextRunAt,
    lastError,
    lastResults,
    runIntervalMinutes: RUN_INTERVAL_MINUTES,
    startupDelaySeconds: STARTUP_DELAY_SECONDS,
  };
}
