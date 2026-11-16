import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const SUPPORTED_DSH = '0.2.2-rc.2';

/** Discover installed code only; never open or create a user's DSH profile. */
export function findInstalledDshManifest(): string | undefined {
  if (process.env.DSH_PACKAGE_JSON) return process.env.DSH_PACKAGE_JSON;
  const local = process.env.LOCALAPPDATA;
  if (!local) return undefined;
  const root = join(local, 'pnpm/global/v11');
  const found = new Set<string>();
  if (existsSync(root)) {
    for (const item of readdirSync(root)) {
      const candidate = join(root, item, 'node_modules/@deepseek-ai/dsh/package.json');
      if (existsSync(candidate)) found.add(realpathSync(candidate));
    }
  }
  if (found.size > 1) throw new Error(`Found ${found.size} DSH installations; select one with DSH_PACKAGE_JSON.`);
  return [...found][0];
}

/** Use the CLI's own dependency graph, with no private native implementation imports. */
export function installedDsh(manifest?: string) {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Installed DSH tooling requires native Windows x64 Node.');
  manifest ??= findInstalledDshManifest();
  if (!manifest) throw new Error('No installed DSH found; set DSH_PACKAGE_JSON to its absolute package.json path.');
  if (!isAbsolute(manifest)) throw new Error('DSH_PACKAGE_JSON must be an absolute package.json path.');
  manifest = realpathSync(manifest);
  const metadata = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: unknown; version?: unknown };
  if (metadata.name !== '@deepseek-ai/dsh' || metadata.version !== SUPPORTED_DSH) {
    throw new Error(`Expected @deepseek-ai/dsh ${SUPPORTED_DSH}; review compatibility before using this installation.`);
  }
  const cliRequire = createRequire(manifest);
  const baseRequire = createRequire(cliRequire.resolve('@deepseek-ai/dsh-base'));
  const load = (require: NodeJS.Require, name: string): Promise<unknown> => import(pathToFileURL(require.resolve(name)).href);
  return { manifest, version: SUPPORTED_DSH, cliRequire, baseRequire, load };
}
