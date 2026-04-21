import { MongoClient, Collection } from "mongodb";
import { config } from "./config.js";

export interface HolderDoc {
  hookAddress:    string; // discriminator
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
  await _collection.createIndex({ hookAddress: 1, credentialId: 1 }, { unique: true });
  await _collection.createIndex({ hookAddress: 1, address: 1 });
}

export function holders(): Collection<HolderDoc> {
  return _collection;
}
