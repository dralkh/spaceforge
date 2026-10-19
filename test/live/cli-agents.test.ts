/**
 * Live end-to-end test for the local agent CLIs the plugin can drive.
 *
 * This is opt-in and not part of `npm test`: every case spawns a real CLI and
 * spends a real model turn.
 *
 *   node --env-file=$HOME/.env test/live/build.mjs
 *   node --env-file=$HOME/.env --test .test-build/live/cli-agents.test.js
 *
 * Copilot CLI is not always installed where the search looks. Point the test
 * at an install outside the usual places with SF_CLI_EXTRA_PATH, and give it a
 * token if the CLI is not already signed in:
 *
 *   export SF_CLI_EXTRA_PATH=/tmp/opencode/copilot-cli/node_modules/.bin
 *   export GH_TOKEN=$(gh auth token)
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { getCliAgent } from '../../api/cli/cli-agents';
import { detectCliAgent } from '../../api/cli/cli-detection';
import { setCliExtraPath } from '../../api/cli/cli-runner';
import { createChatClient, inspectChatProvider } from '../../api/chat-client';
import { discoverModels } from '../../api/provider-registry';
import { DEFAULT_SETTINGS, ProviderId } from '../../models/settings';
import { parseJsonLoose } from '../../utils/tutor-protocol';

/** The CLIs this run must prove: agy replaced the Gemini CLI; the rest are the
 * assistant CLIs the plugin offers under their own provider rows. */
const REQUIRED = [
    { id: 'antigravity', bin: 'agy' },
    { id: 'codex', bin: 'codex' },
    { id: 'hermes', bin: 'hermes' },
    { id: 'opencode', bin: 'opencode' },
    { id: 'copilot', bin: 'copilot' },
];

interface Defect {
    id: string;
    what: string;
    detail: unknown;
}

const defects: Defect[] = [];

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

test('live: the agent CLIs detect, list and answer through the plugin', { timeout: 1_200_000 }, async () => {
    if (process.env.SF_CLI_EXTRA_PATH) setCliExtraPath(process.env.SF_CLI_EXTRA_PATH);

    try {
        for (const { id, bin } of REQUIRED) {
            const definition = getCliAgent(id);
            if (!check(definition, id, 'is a registered agent')) continue;
            if (!definition) continue;

            console.log(`\n=== ${definition.name} (${bin}) ===`);
            const detection = await detectCliAgent(id);
            console.log(
                `  detection: installed=${detection.installed} authenticated=${detection.authenticated} ` +
                `version=${detection.version ?? '-'} path=${detection.resolvedPath ?? '-'}`
            );
            console.log(`  detection message: ${detection.message}`);

            check(detection.installed, id, `the \`${bin}\` binary is found on this machine`, detection.message);
            check(detection.authenticated, id, 'the CLI reports a usable sign-in', detection.message);
            if (!detection.installed || !detection.authenticated) {
                // A turn without a binary or a login can only test the error path;
                // the detection result already says what is wrong.
                continue;
            }

            // The model list the settings screen would offer.
            const discovery = await discoverModels(`cli:${id}`, { ...DEFAULT_SETTINGS });
            check(discovery.error === null, id, 'the model list can be read', discovery.error);
            check(discovery.models.length > 0, id, 'the model list is not empty', discovery.models.length);
            console.log(`  models: ${discovery.models.length} (${discovery.models.slice(0, 3).map(model => model.id).join(', ')}…)`);

            // The whole plugin path: inspect -> client -> flattened prompt -> CLI -> parser.
            const settings = { ...DEFAULT_SETTINGS, mcqApiProvider: `cli:${id}` as ProviderId };
            const inspected = inspectChatProvider(settings);
            check(inspected.ready === true, id, 'Study sees the CLI as ready', inspected.reason);
            check(/\(CLI\)/.test(inspected.label), id, 'the provider is labelled as a CLI', inspected.label);

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

    assert.deepEqual(
        defects,
        [],
        `${defects.length} CLI defect(s):\n${defects.map(defect => `- [${defect.id}] ${defect.what}`).join('\n')}`
    );
});
