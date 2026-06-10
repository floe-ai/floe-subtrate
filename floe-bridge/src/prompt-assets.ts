import { readFileSync } from "node:fs";

const cache = new Map<string, string>();

export function readPromptAsset(name: string): string {
  const cached = cache.get(name);
  if (cached != null) return cached;

  const text = readFileSync(new URL(`./prompts/${name}`, import.meta.url), "utf8").trim();
  cache.set(name, text);
  return text;
}
