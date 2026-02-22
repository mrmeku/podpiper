import type { FileSystem } from "@/ports/types";

export type JsonPath<T> = string & { readonly __jsonType: T };

export function jsonPath<T>(path: string): JsonPath<T> {
  return path as JsonPath<T>;
}

export async function readJson<T>(fs: FileSystem, path: JsonPath<T>): Promise<T> {
  return fs.readJson<T>(path);
}

export async function readJsonIfExists<T>(fs: FileSystem, path: JsonPath<T>): Promise<T | null> {
  if (!(await fs.exists(path))) return null;
  return fs.readJson<T>(path);
}
