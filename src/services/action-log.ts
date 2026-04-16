// Logger central de ações do agente, escopado por produto.
// Cada decisão/ação do agente passa por aqui — é o trading journal.
// Suporta reasoning em linguagem natural + snapshot do input que levou
// à decisão, pra auditoria posterior no "trading journal" do produto.

import prisma from "../prisma";

export interface ActionLogInput {
  productId: string;
  action: string;
  entityType?: string;
  entityId?: string;
  entityName?: string;
  details?: string;
  source?: string;
  reasoning?: string;
  inputSnapshot?: any;
  outcome?: any;
}

export async function logAction(input: ActionLogInput): Promise<string | null> {
  try {
    const created = await prisma.actionLog.create({
      data: {
        productId: input.productId,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId,
        entityName: input.entityName,
        details: input.details,
        reasoning: input.reasoning,
        inputSnapshot: input.inputSnapshot ?? undefined,
        outcome: input.outcome ?? undefined,
        source: input.source || "system",
      },
    });
    return created.id;
  } catch (err) {
    console.error(
      `[action-log] FALHA CRÍTICA ao logar ${input.action} (product=${input.productId}): ${err instanceof Error ? err.message : String(err)}`,
      { stack: err instanceof Error ? err.stack : undefined, input }
    );
    return null;
  }
}

// Atualiza retroativamente o outcome de uma decisão.
// Usado quando o efeito de uma ação só aparece algumas horas depois
// (ex: depois de pausar um adset, medir quanto de spend foi evitado).
export async function attachOutcome(actionLogId: string, outcome: any): Promise<void> {
  try {
    await prisma.actionLog.update({
      where: { id: actionLogId },
      data: { outcome },
    });
  } catch (err) {
    console.error(`[action-log] attachOutcome falhou: ${(err as Error).message}`);
  }
}
