import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LocalizedError } from '../src/localized-error.ts';

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
  if (found.size > 1) throw new LocalizedError('error.multipleDshInstallations', { variable: 'DSH_PACKAGE_JSON', count: String(found.size) });
  return [...found][0];
}

/** Use the CLI's own dependency graph, with no private native implementation imports. */
export function installedDsh(manifest?: string) {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new LocalizedError('error.toolingPlatform');
  manifest ??= findInstalledDshManifest();
  if (!manifest) throw new LocalizedError('error.dshNotInstalled', { variable: 'DSH_PACKAGE_JSON', manifest: 'package.json' });
  if (!isAbsolute(manifest)) throw new LocalizedError('error.dshManifestPath', { variable: 'DSH_PACKAGE_JSON', manifest: 'package.json' });
  manifest = realpathSync(manifest);
  const metadata = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: unknown; version?: unknown };
  if (metadata.name !== '@deepseek-ai/dsh' || metadata.version !== SUPPORTED_DSH) {
    throw new LocalizedError('error.dshVersion', { packageName: '@deepseek-ai/dsh', version: SUPPORTED_DSH });
  }
  const cliRequire = createRequire(manifest);
  const baseRequire = createRequire(cliRequire.resolve('@deepseek-ai/dsh-base'));
  const load = (require: NodeJS.Require, name: string): Promise<unknown> => import(pathToFileURL(require.resolve(name)).href);
  return { manifest, version: SUPPORTED_DSH, cliRequire, baseRequire, load };
}
