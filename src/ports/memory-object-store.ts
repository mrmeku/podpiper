import type { ObjectStore } from "./types";

export function createMemoryObjectStore(): ObjectStore & { size(): number } {
  const store = new Map<string, Uint8Array>();
  return {
    uploadFile: async (data, key, bucket) => { store.set(`${bucket}/${key}`, data); },
    getFile: async (bucket, key) => store.get(`${bucket}/${key}`) ?? null,
    fileExists: async (bucket, key) => store.has(`${bucket}/${key}`),
    size: () => store.size,
  };
}
