import { Router, Request, Response } from "express";
import { holders } from "./db.js";
import { getProof } from "./chain.js";
import { scheduleDefault, reschedule, flush } from "./batch.js";

export const router = Router();

// POST /holders/add
// Body: { address: string, credentialType: string, credentialId: string }
router.post("/holders/add", async (req: Request, res: Response) => {
  const { address, credentialType, credentialId } = req.body;
  if (!address || !credentialType || !credentialId) {
    res.status(400).json({ error: "address, credentialType and credentialId are required" });
    return;
  }

  await holders().updateOne(
    { credentialId },
    { $set: { address, credentialType, credentialId } },
    { upsert: true }
  );

  scheduleDefault();
  res.json({ ok: true });
});

// POST /holders/remove
// Body: { credentialId: string }
router.post("/holders/remove", async (req: Request, res: Response) => {
  const { credentialId } = req.body;
  if (!credentialId) {
    res.status(400).json({ error: "credentialId is required" });
    return;
  }

  await holders().deleteOne({ credentialId });

  scheduleDefault();
  res.json({ ok: true });
});

// POST /flush?in=N  (N in seconds, 0 or omitted = immediate)
router.post("/flush", async (req: Request, res: Response) => {
  const inSec = parseFloat((req.query.in as string) ?? "0");
  const delayMs = Math.max(0, inSec * 1000);

  if (delayMs === 0) {
    await flush();
    res.json({ ok: true, flushed: true });
  } else {
    reschedule(delayMs);
    res.json({ ok: true, scheduledInMs: delayMs });
  }
});

// GET /proof?address=0x...
router.get("/proof", (req: Request, res: Response) => {
  const address = req.query.address as string;
  if (!address) {
    res.status(400).json({ error: "address is required" });
    return;
  }

  const proof = getProof(address);
  if (!proof) {
    res.status(404).json({ error: "no proof available for this address" });
    return;
  }

  res.json(proof);
});
