/**
 * Live end-to-end test for every local agent CLI the plugin can drive.
 *
 * This is opt-in and not part of `npm test`: every case spawns a real CLI and
 * spends a real model turn.
 *
 *   npm run check:cli
 *
 * or, by hand:
 *
 *   node test/live/build.mjs
 *   node --test .test-build/live/cli-agents.test.js
 *
 * The list under test is the registry itself (`CLI_AGENTS`), so a newly added
 * agent is covered the moment it is registered — the previous version of this
 * file named five agents by hand and silently skipped Claude Code, Cursor and
 * OpenClaw, which is exactly how Cursor shipped without ever being sent a
 * prompt.
 *
 * Outcomes are three-valued on purpose: an agent whose binary is absent from
 * this machine, or that is installed but not signed in, is reported as SKIP with
 * the reason (the plugin cannot fix either), while an agent that is present and
 * signed in must detect, list models and answer, or the run fails.
 *
 * A turn with no model chosen runs whatever default the CLI has configured, and
 * that default is often the reader's own decision (an account, a provider, a
 * tier). To verify the plugin's plumbing against a specific model, name one per
 * agent in the environment — the run then sends it in the same field the
 * settings screen writes:
 *
 *   SF_CLI_MODEL_OPENCODE=opencode-go/deepseek-v4.1-flash npm run check:cli
 *
 * Copilot CLI is not always installed where the search looks. Point the test at
 * an install outside the usual places with SF_CLI_EXTRA_PATH:
 *
 *   export SF_CLI_EXTRA_PATH=/tmp/opencode/copilot-cli/node_modules/.bin
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { listCliAgents } from '../../api/cli/cli-agents';
import { detectCliAgent } from '../../api/cli/cli-detection';
import { findCliBinary } from '../../api/cli/cli-binary';
import { setCliExtraPath } from '../../api/cli/cli-runner';
import { createChatClient, inspectChatProvider } from '../../api/chat-client';
import { discoverModels } from '../../api/provider-registry';
import { DEFAULT_SETTINGS, ProviderId } from '../../models/settings';
import { parseJsonLoose } from '../../utils/tutor-protocol';

interface Defect {
    id: string;
    what: string;
    detail: unknown;
}

const defects: Defect[] = [];
const skipped: { id: string; reason: string }[] = [];

function check(condition: unknown, id: string, what: string, detail?: unknown): boolean {
    if (condition) {
        console.log(`  ok   [${id}] ${what}`);
        return true;
    }
    const suffix = detail === undefined ? '' : ` — ${JSON.stringify(detail).slice(0, 800)}`;
    defects.push({ id, what, detail });
    console.error(`  FAIL [${id}] ${what}${suffix}`);
    return false;
}

/** A model named for this agent in the environment, e.g. SF_CLI_MODEL_OPENCODE. */
function modelOverride(id: string): string {
    const key = `SF_CLI_MODEL_${id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
    return (process.env[key] ?? '').trim();
}

test('live: every registered agent CLI detects, lists models and answers through the plugin', { timeout: 1_500_000 }, async () => {
    if (process.env.SF_CLI_EXTRA_PATH) setCliExtraPath(process.env.SF_CLI_EXTRA_PATH);

    try {
        for (const definition of listCliAgents()) {
            const id = definition.id;

            // Absent from this machine is a skip, not a plugin defect — but it
            // must be found by the same search the plugin uses to say so.
            const binary = findCliBinary(definition.bin);
            if (!binary) {
                skipped.push({ id, reason: `\`${definition.bin}\` is not installed on this machine` });
                console.log(`\n--- ${definition.name} (${definition.bin}): SKIP — not installed`);
                continue;
            }

            console.log(`\n=== ${definition.name} (${definition.bin}) ===`);
            const detection = await detectCliAgent(id);
            console.log(
                `  detection: installed=${detection.installed} authenticated=${detection.authenticated} ` +
                `version=${detection.version ?? '-'} path=${detection.resolvedPath ?? '-'}`
            );
            console.log(`  detection message: ${detection.message}`);

            check(detection.installed, id, `the \`${definition.bin}\` binary is found by the plugin's own search`, detection.message);
            if (!detection.installed) continue;

            if (!detection.authenticated) {
                // Installed but never signed in: the reader has to act, and the
                // detection message already names the command.
                skipped.push({ id, reason: 'installed but not signed in' });
                console.log(`  SKIP [${id}] installed but not signed in: ${detection.message}`);
                continue;
            }

            // The model list the settings screen would offer.
            const discovery = await discoverModels(`cli:${id}`, { ...DEFAULT_SETTINGS });
            check(discovery.error === null, id, 'the model list can be read', discovery.error);
            check(discovery.models.length > 0, id, 'the model list is not empty', discovery.models.length);
            console.log(`  models: ${discovery.models.length} (${discovery.models.slice(0, 3).map(model => model.id).join(', ')}…)`);

            // The whole plugin path: inspect -> client -> flattened prompt -> CLI -> parser.
            const model = modelOverride(id);
            const settings = {
                ...DEFAULT_SETTINGS,
                mcqApiProvider: `cli:${id}` as ProviderId,
                providerModels: model ? { [`cli:${id}`]: model } : {},
            };
            const inspected = inspectChatProvider(settings);
            check(inspected.ready === true, id, 'Study sees the CLI as ready', inspected.reason);
            check(/\(CLI\)/.test(inspected.label), id, 'the provider is labelled as a CLI', inspected.label);
            console.log(`  model: ${model || '(the CLI default)'}`);

            const client = createChatClient(settings);
            if (!check(client, id, 'a chat client is built for the CLI')) continue;
            if (!client) continue;

            const started = Date.now();
            let result;
            try {
                result = await client.send({
                    messages: [
                        { role: 'system', content: 'You answer with one JSON object and nothing else.' },
                        { role: 'user', content: 'Reply with exactly this JSON: {"answer":"ok"}' },
                    ],
                    json: true,
                    maxTokens: 64,
                });
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                const detail = (error as { detail?: string | null }).detail ?? null;
                check(false, id, 'the turn completes through the plugin', { message, detail });
                continue;
            }
            const parsed = parseJsonLoose(result.text);
            check(parsed?.answer === 'ok', id, 'the turn returns the requested JSON', result.text.slice(0, 400));
            check(result.text.trim().length > 0, id, 'the turn returned text');
            console.log(
                `  turn: ${Date.now() - started}ms model=${result.model} finish=${result.finishReason ?? '-'} ` +
                `text=${JSON.stringify(result.text.slice(0, 120))}`
            );
        }
    } finally {
        setCliExtraPath('');
    }

    const summary = [
        `${listCliAgents().length - skipped.length - defects.length} agent(s) verified`,
        `${skipped.length} skipped`,
        `${defects.length} defect(s)`,
    ].join(', ');
    console.log(`\n${summary}`);
    for (const entry of skipped) console.log(`  skipped: ${entry.id} — ${entry.reason}`);

    assert.deepEqual(
        defects,
        [],
        `${defects.length} CLI defect(s):\n${defects.map(defect => `- [${defect.id}] ${defect.what}`).join('\n')}`
    );
});
