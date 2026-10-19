import { Notice } from 'obsidian';
import { IMCQGenerationService } from './mcq-generation-service';
import { MCQSet } from '../models/mcq';
import { SpaceforgeSettings } from '../models/settings';
import { buildMcqPrompt, parseMcqResponse, questionsToGenerate } from './mcq-prompt';
import { CliChatClient, createCliChatClient } from './cli/cli-chat-client';
import { getCliAgent } from './cli/cli-agents';
import { agentIdOfProvider, cliModelFor } from './provider-registry';
import { ApiProvider } from '../models/settings';
import SpaceforgePlugin from '../main';

/**
 * Question writing through a local agent CLI.
 *
 * The point of this class is how little it does: the prompt and the parser are
 * the same ones every HTTP provider uses (api/mcq-prompt.ts), so questions
 * written by Claude Code, Codex or Hermes are shaped exactly like questions
 * written by an API key — same format, same marking, same parsing. Only the
 * transport differs, and the CLI owns the login.
 */
export class CliService implements IMCQGenerationService {
    plugin: SpaceforgePlugin;

    constructor(plugin: SpaceforgePlugin) {
        this.plugin = plugin;
    }

    async generateMCQs(
        notePath: string,
        noteContent: string,
        settings: SpaceforgeSettings
    ): Promise<MCQSet | null> {
        // The provider id *is* the CLI (`cli:claude`); a vault that still holds
        // the old single 'cli' choice is read as the agent it stored.
        const agentId = agentIdOfProvider(settings.mcqApiProvider)
            ?? (settings.mcqApiProvider === ApiProvider.Cli ? settings.cliAgent : null);
        const agent = getCliAgent(agentId ?? undefined);
        if (!agent) {
            new Notice('That local CLI is not one this plugin knows. Pick another provider.');
            return null;
        }

        const client = createCliChatClient(agent.id, cliModelFor(settings, agent.id));
        if (!client) {
            new Notice(`Could not start ${agent.name}. Check the CLI is installed and signed in.`);
            return null;
        }

        const numQuestionsToGenerate = questionsToGenerate(noteContent, settings);
        const prompt = buildMcqPrompt(noteContent, settings, numQuestionsToGenerate);

        new Notice(`Asking ${agent.name} for ${numQuestionsToGenerate} questions…`);

        let reply: string;
        try {
            const result = await client.send({ messages: [{ role: 'user', content: prompt }] });
            reply = result.text;
        } catch (error) {
            // The runner's errors are already written for a person: not found,
            // not signed in, took too long. Say exactly that.
            const message = error instanceof Error ? error.message : String(error);
            new Notice(message, 8000);
            return null;
        }

        const questions = parseMcqResponse(reply, settings, numQuestionsToGenerate);
        if (questions.length === 0) {
            new Notice(`${agent.name} answered, but no usable questions could be read from it. Try again.`);
            return null;
        }

        return {
            notePath,
            questions,
            generatedAt: Date.now(),
        };
    }
}

export type { CliChatClient };
