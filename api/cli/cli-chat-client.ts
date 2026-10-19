import { ChatClient, ChatClientError, ChatRequest, ChatResult } from '../chat-client';
import { getCliAgent } from './cli-agents';
import { CliTurnError, runCliTurn } from './cli-runner';
import { CliAgentDef } from './cli-types';

/**
 * A ChatClient whose backend is an agent CLI instead of an HTTP API.
 *
 * Everything above this line — question writing, the tutor, note charting — only
 * knows the ChatClient contract, so a learner with a signed-in Claude Code or
 * Codex gets every AI feature of the plugin without ever pasting an API key.
 * The CLI's own login is the credential; nothing is stored here.
 */
export class CliChatClient implements ChatClient {
    readonly providerLabel: string;
    readonly model: string;
    private agent: CliAgentDef;

    constructor(agent: CliAgentDef, model: string) {
        this.agent = agent;
        this.providerLabel = `${agent.name} (CLI)`;
        this.model = model || 'default';
    }

    async send(request: ChatRequest): Promise<ChatResult> {
        const started = Date.now();
        const prompt = flattenMessages(request);
        if (!prompt.trim()) {
            throw new ChatClientError(`${this.providerLabel} was asked nothing.`);
        }

        try {
            const text = await runCliTurn(this.agent, {
                model: this.model,
                prompt,
                timeoutMs: cliTimeoutMs(request),
            });
            return {
                text,
                providerLabel: this.providerLabel,
                model: this.model,
                durationMs: Date.now() - started,
                finishReason: 'stop',
                truncated: false,
            };
        } catch (error) {
            if (error instanceof CliTurnError) {
                throw new ChatClientError(error.message, null, error.detail);
            }
            const message = error instanceof Error ? error.message : String(error);
            throw new ChatClientError(`${this.providerLabel} failed: ${message}`);
        }
    }
}

/** Build a client for the chosen CLI, or null when the choice is not one. */
export function createCliChatClient(agentId: string | undefined, model: string): CliChatClient | null {
    const agent = getCliAgent(agentId);
    return agent ? new CliChatClient(agent, model) : null;
}

/**
 * One prompt out of a chat request. A CLI turn is a single non-interactive
 * invocation, so the system message is folded into the front of the user turn
 * rather than pretending the harness has roles.
 */
export function flattenMessages(request: ChatRequest): string {
    // A CLI turn has no roles to assign, so the system message becomes a
    // preamble at the front of the one prompt — which is where callers put it
    // anyway, and the blank line between parts is what separates the standing
    // instruction from the turn itself.
    const parts: string[] = request.messages.map(message => message.content);
    if (request.json) {
        // The tasks that ask for JSON also parse it strictly; say so in the
        // prompt, because a CLI has no response_format to set.
        parts.push('Respond with a single valid JSON object. No prose, no code fences.');
    }
    return parts.join('\n\n');
}

/**
 * A CLI turn is slower than an HTTP call and has no streaming here, so the
 * budget is generous — except for local backends, where the request already
 * says how big the context is.
 */
function cliTimeoutMs(request: ChatRequest): number {
    const base = 180_000;
    return request.maxTokens && request.maxTokens > 8000 ? base * 2 : base;
}
