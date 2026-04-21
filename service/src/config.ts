export const config = {
  port:            parseInt(process.env.PORT ?? "3100"),
  mongoUri:        process.env.MONGO_URI ?? "mongodb://localhost:27017",
  mongoDb:         process.env.MONGO_DB  ?? "vcsvcs_db",
  rpcUrl:          process.env.RPC_URL   ?? "https://sepolia.base.org",
  // Comma-separated list of deployed MerkleAccessHook addresses
  hookAddresses:   (process.env.HOOK_ADDRESSES ?? "").split(",").map(s => s.trim()).filter(Boolean),
  attesterKey:     process.env.ATTESTER_PRIVATE_KEY ?? "",
  defaultWindowMs: parseInt(process.env.DEFAULT_WINDOW_MS ?? "60000"),
};
