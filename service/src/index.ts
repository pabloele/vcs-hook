import express from "express";
import { config } from "./config.js";
import { connectDb } from "./db.js";
import { initChain, restoreTree } from "./chain.js";
import { router } from "./routes.js";

const app = express();
app.use(express.json());
app.use(router);

async function main() {
  await connectDb();
  console.log("MongoDB connected");

  await initChain();
  console.log("Chain initialized");

  await restoreTree();
  console.log("Tree restored");

  app.listen(config.port, () =>
    console.log(`merkle-tree-service listening on :${config.port}`)
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
