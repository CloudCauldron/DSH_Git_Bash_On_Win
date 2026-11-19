import { inventoryGitFiles, linkFreshTree } from '../runtime/git-installation.ts';
import { openExclusiveMetadata, requireActiveLease } from '../runtime/ntfs-filesystem.ts';
import { admitElevationPlan, decodeElevationPlan, planByteLimit, planGeneration } from './elevated-linking.ts';
import { LocalizedError } from '../localized-error.ts';

/** Fixed linker only: no process launch, ACL repair, plan rewrite or recursive cleanup. */
export async function runLinkHelper(planPath: string, digest: string): Promise<void> {
  const generation = planGeneration(planPath);
  const input = openExclusiveMetadata(generation, 'plan.json');
  try {
    const plan = decodeElevationPlan(input.readJson(planByteLimit), digest);
    const attempt = admitElevationPlan(plan, generation);
    const checkActive = () => requireActiveLease(attempt.generation, plan.identities.lease);
    const files = await inventoryGitFiles(attempt.source.path, checkActive);
    await linkFreshTree({ source: attempt.source, base: attempt.base, files }, checkActive);
  } finally { input.close(); }
}

if (import.meta.main) {
  process.exitCode = 1;
  try {
    if (process.argv.length !== 4) throw new LocalizedError('error.setupPlanArgument');
    await runLinkHelper(process.argv[2]!, process.argv[3]!);
    process.exitCode = 0;
  } catch (error) { console.error(String(error).slice(0, 8192)); }
}
