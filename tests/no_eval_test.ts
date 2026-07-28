/**
 * Guards the primary trust-boundary invariant: the trusted request path must
 * never contain `eval` or `new Function`. Only the sandbox runner source (which
 * is data here and executed exclusively inside the microVM) may contain them.
 */

import { assertEquals } from "@std/assert";
import { dirname, fromFileUrl, join, relative } from "@std/path";

const root = join(dirname(fromFileUrl(import.meta.url)), "..");
const srcDir = join(root, "src");
const ALLOWED = new Set(["google-fonts/runner/program-source.ts"]);

Deno.test("no trusted module evaluates code", async () => {
  const offenders: string[] = [];
  for await (const entry of Deno.readDir(srcDir)) {
    await walk(join(srcDir, entry.name), entry.isDirectory, offenders);
  }
  assertEquals(offenders, []);
});

async function walk(path: string, isDirectory: boolean, offenders: string[]): Promise<void> {
  if (isDirectory) {
    for await (const entry of Deno.readDir(path)) {
      await walk(join(path, entry.name), entry.isDirectory, offenders);
    }
    return;
  }
  if (!path.endsWith(".ts")) return;
  const rel = relative(srcDir, path).replaceAll("\\", "/");
  if (ALLOWED.has(rel)) return;
  const source = await Deno.readTextFile(path);
  if (/\bnew Function\b/.test(source) || /(^|[^.\w])eval\s*\(/.test(source)) {
    offenders.push(rel);
  }
}
