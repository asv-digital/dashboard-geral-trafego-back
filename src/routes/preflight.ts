import { Router, Request, Response } from "express";
import { requireAuth } from "../auth/middleware";
import { runPreflightChecks } from "../services/preflight-checks";

const router = Router();
router.use(requireAuth);

router.get("/:productId", async (req: Request, res: Response) => {
  const productId = String(req.params.productId);
  const result = await runPreflightChecks(productId);
  if (!result) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json(result);
});

export default router;
