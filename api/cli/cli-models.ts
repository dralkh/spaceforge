import { getCliAgent } from './cli-agents';
import { resolveShellPath, runCliCapture } from './cli-runner';
import { CliModelEntry } from './cli-types';

/**
 * The models a CLI will answer to. Where the CLI can print a list, that list is
 * the truth; where it cannot, the definition's small catalog is offered and the
 * user can still type any id the CLI accepts.
 */
export async function fetchCliModels(agentId: string | undefined): Promise<CliModelEntry[]> {
    const agent = getCliAgent(agentId);
    if (!agent) return [];

    const catalog = agent.catalogModels;
    if (!agent.listModels) return catalog;

    try {
        resolveShellPath();
        const result = await runCliCapture(agent.bin, agent.listModels.args, 15_000);
        if (result.notFound) return catalog;
        const parsed = agent.listModels.parse(`${result.stdout}\n${result.stderr}`);
        if (parsed.length === 0) return catalog;
        // Keep the catalog's names for ids the CLI also lists, and keep any id
        // from the catalog the CLI did not mention (aliases usually).
        const byId = new Map(parsed.map(entry => [entry.id, entry]));
        for (const entry of catalog) {
            if (!byId.has(entry.id)) byId.set(entry.id, entry);
        }
        return [...byId.values()];
    } catch {
        return catalog;
    }
}
