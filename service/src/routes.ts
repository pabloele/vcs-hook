import { Router, Request, Response } from "express";
import { holders } from "./db.js";
import { getProof, knownHooks } from "./chain.js";
import { scheduleDefault, reschedule, flush } from "./batch.js";

export const router = Router();

// Validate that :hook is a known deployed hook
function resolveHook(req: Request, res: Response): string | null {
  const hook = (Array.isArray(req.params.hook) ? req.params.hook[0] : req.params.hook ?? "").toLowerCase();
  if (!knownHooks().includes(hook)) {
    res.status(404).json({ error: `Unknown hook: ${req.params.hook}` });
    return null;
  }
  return hook;
}

// GET /hooks — list configured hooks
router.get("/hooks", (_req, res) => {
  res.json({ hooks: knownHooks() });
});

// POST /:hook/holders/add
// Body: { address, credentialType, credentialId }
router.post("/:hook/holders/add", async (req: Request, res: Response) => {
  const hook = resolveHook(req, res);
  if (!hook) return;

  const { address, credentialType, credentialId } = req.body;
  if (!address || !credentialType || !credentialId) {
    res.status(400).json({ error: "address, credentialType and credentialId are required" });
    return;
  }

  await holders().updateOne(
    { hookAddress: hook, credentialId },
    { $set: { hookAddress: hook, address, credentialType, credentialId } },
    { upsert: true }
  );

  scheduleDefault(hook);
  res.json({ ok: true });
});

// POST /:hook/holders/remove
// Body: { credentialId }
router.post("/:hook/holders/remove", async (req: Request, res: Response) => {
  const hook = resolveHook(req, res);
  if (!hook) return;

  const { credentialId } = req.body;
  if (!credentialId) {
    res.status(400).json({ error: "credentialId is required" });
    return;
  }

  await holders().deleteOne({ hookAddress: hook, credentialId });

  scheduleDefault(hook);
  res.json({ ok: true });
});

// POST /:hook/flush?in=N  (N in seconds, 0 or omitted = immediate)
router.post("/:hook/flush", async (req: Request, res: Response) => {
  const hook = resolveHook(req, res);
  if (!hook) return;

  const inSec  = parseFloat((req.query.in as string) ?? "0");
  const delayMs = Math.max(0, inSec * 1000);

  if (delayMs === 0) {
    await flush(hook);
    res.json({ ok: true, flushed: true });
  } else {
    reschedule(hook, delayMs);
    res.json({ ok: true, scheduledInMs: delayMs });
  }
});

// GET /:hook/holders — list all holders for a hook
router.get("/:hook/holders", async (req: Request, res: Response) => {
  const hook = resolveHook(req, res);
  if (!hook) return;

  const docs = await holders().find({ hookAddress: hook }, { projection: { _id: 0 } }).toArray();
  res.json({ holders: docs });
});

// POST /:hook/holders/remove-by-address
// Body: { address }
router.post("/:hook/holders/remove-by-address", async (req: Request, res: Response) => {
  const hook = resolveHook(req, res);
  if (!hook) return;

  const { address } = req.body;
  if (!address) {
    res.status(400).json({ error: "address is required" });
    return;
  }

  const result = await holders().deleteMany({ hookAddress: hook, address: address.toLowerCase() });
  scheduleDefault(hook);
  res.json({ ok: true, deleted: result.deletedCount });
});

// GET /:hook/proof?address=0x...
router.get("/:hook/proof", (req: Request, res: Response) => {
  const hook = resolveHook(req, res);
  if (!hook) return;

  const address = req.query.address as string;
  if (!address) {
    res.status(400).json({ error: "address is required" });
    return;
  }

  const proof = getProof(hook, address);
  if (!proof) {
    res.status(404).json({ error: "no proof available for this address" });
    return;
  }

  res.json(proof);
});
