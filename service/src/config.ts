export const config = {
  port:            parseInt(process.env.PORT ?? "3100"),
  mongoUri:        process.env.MONGO_URI ?? "mongodb://localhost:27017",
  mongoDb:         process.env.MONGO_DB  ?? "vcsvcs_db",
  rpcUrl:          process.env.RPC_URL   ?? "https://sepolia.base.org",
  hookAddress:     process.env.HOOK_ADDRESS ?? "",
  attesterKey:     process.env.ATTESTER_PRIVATE_KEY ?? "",
  defaultWindowMs: parseInt(process.env.DEFAULT_WINDOW_MS ?? "60000"), // 1 min
};
