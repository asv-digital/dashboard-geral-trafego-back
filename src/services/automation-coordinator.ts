// Coordena locks entre services autônomos, escopados por produto.
// Hierarquia de prioridade: ab_resolver > auto_executor > budget_rebalancer > dayparting
// Mesmo service pode sobrescrever seu próprio lock. Locks expirados são limpos.

import prisma from "../prisma";

const LOCK_DURATIONS_MIN: Record<string, number> = {
  auto_executor: 4 * 60, // 4h
  budget_rebalancer: 4 * 60, // 4h
  dayparting: 65, // ~1h
  ab_resolver: 24 * 60, // 24h
};

const PRIORITY: Record<string, number> = {
  ab_resolver: 4,
  auto_executor: 3,
  budget_rebalancer: 2,
  dayparting: 1,
};

export type LockActor = keyof typeof PRIORITY;

export async function canAutomate(
  productId: string,
  entityType: string,
  entityId: string,
  requestedBy: LockActor
): Promise<{ allowed: boolean; blockedBy?: string; reason?: string }> {
  const existing = await prisma.automationLock.findUnique({
    where: {
      productId_entityType_entityId: { productId, entityType, entityId },
    },
  });
  if (!existing) return { allowed: true };

  if (new Date() > existing.expiresAt) {
    await prisma.automationLock.delete({ where: { id: existing.id } });
    return { allowed: true };
  }

  if (existing.lockedBy === requestedBy) return { allowed: true };

  const requestPriority = PRIORITY[requestedBy] ?? 0;
  const existingPriority = PRIORITY[existing.lockedBy] ?? 0;

  if (requestPriority > existingPriority) {
    await prisma.automationLock.delete({ where: { id: existing.id } });
    return { allowed: true };
  }

  return {
    allowed: false,
    blockedBy: existing.lockedBy,
    reason: `bloqueado por ${existing.lockedBy} (${existing.action}) até ${existing.expiresAt.toISOString()}`,
  };
}

export async function acquireLock(
  productId: string,
  entityType: string,
  entityId: string,
  lockedBy: LockActor,
  action: string,
  previousValue?: string,
  newValue?: string
): Promise<void> {
  const minutes = LOCK_DURATIONS_MIN[lockedBy] ?? 60;
  const expiresAt = new Date(Date.now() + minutes * 60 * 1000);

  await prisma.automationLock.upsert({
    where: {
      productId_entityType_entityId: { productId, entityType, entityId },
    },
    create: {
      productId,
      entityType,
      entityId,
      lockedBy,
      action,
      previousValue,
      newValue,
      expiresAt,
    },
    update: {
      lockedBy,
      action,
      previousValue,
      newValue,
      expiresAt,
    },
  });
}

export async function cleanExpiredLocks(): Promise<number> {
  const result = await prisma.automationLock.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  });
  return result.count;
}
