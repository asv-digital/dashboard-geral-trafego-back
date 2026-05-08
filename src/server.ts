import express from "express";
import cors from "cors";
import healthRoutes from "./routes/health";
import authRoutes from "./routes/auth";
import productRoutes from "./routes/products";
import highTicketRoutes from "./routes/high-ticket-sales";
import campaignRoutes from "./routes/campaigns";
import metricRoutes from "./routes/metrics";
import salesRoutes from "./routes/sales";
import agentRoutes from "./routes/agent";
import actionRoutes from "./routes/actions";
import creativeRoutes from "./routes/creatives";
import globalRoutes from "./routes/global";
import webhookRoutes from "./routes/webhooks";
import metaActionsRoutes from "./routes/meta-actions";
import preflightRoutes from "./routes/preflight";
import productAssetsRoutes from "./routes/product-assets";
import plannerRoutes from "./routes/planner";
import placementsRoutes from "./routes/placements";
import notificationsRoutes from "./routes/notifications";
import checkoutPrepRoutes from "./routes/checkout-prep";
import analyticsRoutes from "./routes/analytics";
import { deleteExpiredSessions } from "./auth/session";
import { startScheduler } from "./agent/scheduler";
import { startDailySummary } from "./services/daily-summary";
import { getLocalUploadsRoot } from "./lib/storage";
import { validateEnvOrExit } from "./lib/env-check";

validateEnvOrExit();

const app = express();
const PORT = Number(process.env.PORT || 3001);

app.use(
  cors({
    origin: process.env.FRONTEND_URL || "http://localhost:3000",
    credentials: true,
  })
);
// raw body capturado em rotas de webhook pra HMAC SHA-256.
// Body parseado normalmente pra todas as rotas. Overhead é só uma cópia
// do buffer pra string em rotas que começam com /api/webhooks.
app.use(
  express.json({
    limit: "10mb",
    verify: (req, _res, buf) => {
      if (req.url?.startsWith("/api/webhooks")) {
        (req as any).rawBody = buf.toString("utf8");
      }
    },
  })
);
app.use("/uploads", express.static(getLocalUploadsRoot()));

// Snippets publicos (servidos sem auth) — usado pelas landings externas.
// Cache curto (5min) pra mudancas chegarem rapido sem martelar o backend.
app.use(
  "/public",
  express.static(require("path").join(__dirname, "static"), {
    maxAge: 5 * 60 * 1000,
    setHeaders: res => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("X-Content-Type-Options", "nosniff");
    },
  })
);

// Webhooks e checkout-prep antes do auth pra não exigir sessão
// (sao chamados por servidores externos / browser do user)
app.use("/api/webhooks", webhookRoutes);
app.use("/api/checkout-prep", checkoutPrepRoutes);

// Rotas autenticadas + públicas
app.use("/api/health", healthRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/products", productRoutes);
app.use("/api/products", highTicketRoutes);
app.use("/api/campaigns", campaignRoutes);
app.use("/api/metrics", metricRoutes);
app.use("/api/sales", salesRoutes);
app.use("/api/agent", agentRoutes);
app.use("/api/actions", actionRoutes);
app.use("/api/creatives", creativeRoutes);
app.use("/api/global", globalRoutes);
app.use("/api/meta-actions", metaActionsRoutes);
app.use("/api/preflight", preflightRoutes);
app.use("/api/assets", productAssetsRoutes);
app.use("/api/planner", plannerRoutes);
app.use("/api/placements", placementsRoutes);
app.use("/api/notifications", notificationsRoutes);
app.use("/api/analytics", analyticsRoutes);

app.use((_req, res) => {
  res.status(404).json({ error: "not_found" });
});

// Error middleware — Express 5 encaminha rejeições aqui. Sem isso o Express
// usa o handler default (HTML genérico). Queremos JSON + log estruturado.
app.use(
  (
    err: unknown,
    req: express.Request,
    res: express.Response,
    _next: express.NextFunction
  ) => {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    console.error(
      `[error] ${req.method} ${req.originalUrl} — ${message}${stack ? `\n${stack}` : ""}`
    );
    if (res.headersSent) return;
    res.status(500).json({
      error: "internal",
      message: process.env.NODE_ENV === "production" ? "internal_error" : message,
    });
  }
);

app.listen(PORT, () => {
  console.log(`[agente-v2] server listening on http://localhost:${PORT}`);
  startScheduler();
  startDailySummary();
});

setInterval(
  () => {
    deleteExpiredSessions()
      .then(count => {
        if (count > 0) console.log(`[agente-v2] cleaned ${count} expired sessions`);
      })
      .catch(err => console.error("[agente-v2] session cleanup failed", err));
  },
  6 * 60 * 60 * 1000
);

export default app;
