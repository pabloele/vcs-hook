import { MongoClient, Collection } from "mongodb";
import { config } from "./config.js";

export interface HolderDoc {
  credentialId:   string;
  address:        string;
  credentialType: string;
}

let _collection: Collection<HolderDoc>;

export async function connectDb(): Promise<void> {
  const client = new MongoClient(config.mongoUri);
  await client.connect();
  const db = client.db(config.mongoDb);
  _collection = db.collection<HolderDoc>("merkle_holders");
  await _collection.createIndex({ credentialId: 1 }, { unique: true });
  await _collection.createIndex({ address: 1 });
}

export function holders(): Collection<HolderDoc> {
  return _collection;
}
