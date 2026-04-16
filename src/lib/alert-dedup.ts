// Edge-triggered dedup para alertas de estado estacionário.
//
// Diferente da v1: key é escopada por produto — (productId, key) é unique.
// Alerta "agent_skipped" do produto A não deduplica com "agent_skipped"
// do produto B.

import prisma from "../prisma";

const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export async function shouldSendStateAlert(
  productId: string,
  key: string,
  currentState: string,
  maxAgeMs: number = DEFAULT_MAX_AGE_MS
): Promise<boolean> {
  const now = new Date();

  try {
    const existing = await prisma.alertDedup.findUnique({
      where: { productId_key: { productId, key } },
    });

    if (!existing) {
      await prisma.alertDedup.create({
        data: { productId, key, lastState: currentState, lastSentAt: now },
      });
      return true;
    }

    const stateChanged = existing.lastState !== currentState;
    const stale = now.getTime() - existing.lastSentAt.getTime() >= maxAgeMs;

    if (stateChanged || stale) {
      await prisma.alertDedup.update({
        where: { productId_key: { productId, key } },
        data: { lastState: currentState, lastSentAt: now },
      });
      return true;
    }

    return false;
  } catch (err) {
    console.error(
      `[AlertDedup] erro em "${productId}:${key}": ${err instanceof Error ? err.message : String(err)}. enviando por segurança.`
    );
    return true;
  }
}

export async function resetStateAlert(productId: string, key: string): Promise<void> {
  try {
    await prisma.alertDedup.delete({
      where: { productId_key: { productId, key } },
    });
  } catch {
    // idempotente
  }
}
