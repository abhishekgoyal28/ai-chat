import { Injectable } from '@nestjs/common';
import { config } from '../../shared/config/config';
import {
  GENERATION_SCHEMA_VERSION,
  GenerationFailureReason,
  GenerationKind,
  GenerationMeta,
  GenerationRequest,
  GenerationResponse,
  GenerationStatus,
  ModelRouteRef,
  PreviewRequest,
  PreviewResponse,
} from '../../shared/contracts/generation.contract';
import { LlmProvider } from '../../shared/database/entities';
import { AgentSettings, parseAgentSettings } from '../../shared/domain/agent-settings';
import { describeError, getLogger } from '../../shared/logger/logger';
import { metrics } from '../../shared/observability/metrics';
import { ExpertConfigService } from '../config/expert-config.service';
import {
  LlmConfigurationError,
  LlmError,
  LlmGenerateResult,
  LlmMalformedError,
  LlmSafetyError,
  LlmTimeoutError,
} from '../llm/llm-client';
import { LlmClientFactory } from '../llm/llm-client.factory';
import { PROMPT_VERSION, PromptBuilder, PromptInputs } from '../prompts/prompt-builder';

const RETRY_BACKOFF_MS = 1500;
/** Below this much time before the deadline a retry cannot finish, so none is attempted. */
const MIN_ATTEMPT_MS = 3000;

class GenerationFailure extends Error {
  constructor(
    readonly reason: GenerationFailureReason,
    message: string,
  ) {
    super(message);
  }
}

interface RunOutcome {
  result: LlmGenerateResult;
  provider: LlmProvider;
  latencyMs: number;
  systemPrompt: string;
  knowledgeDocumentsUsed: number;
}

/**
 * request → configuration → prompt → model → structured reply.
 *
 * Failures never throw out of generate(): a failed generation becomes a FAILED
 * response, so chat-app can tell the user and offer a retry. Throwing would
 * make the queue redeliver the request — a second billed call for the same
 * failure. Only process death redelivers.
 */
@Injectable()
export class GenerationService {
  private readonly log = getLogger(GenerationService.name);
  private readonly promptBuilder = new PromptBuilder();

  constructor(
    private readonly configService: ExpertConfigService,
    private readonly clientFactory: LlmClientFactory,
  ) {}

  async generate(request: GenerationRequest): Promise<GenerationResponse> {
    const base = {
      schemaVersion: GENERATION_SCHEMA_VERSION,
      dispatchId: request.dispatchId,
      conversationId: request.conversationId,
      requestTurnId: request.turnId,
      kind: request.kind,
      answeredMessageIds: request.userMessages.map((message) => message.id),
      ...(request.endReason && { endReason: request.endReason }),
    };

    try {
      if (Date.parse(request.deadline) <= Date.now()) {
        throw new GenerationFailure(GenerationFailureReason.PAST_DEADLINE, 'request arrived after its deadline');
      }
      const resolved = await this.configService.resolveAgent(request.agentId);
      if (!resolved) {
        throw new GenerationFailure(GenerationFailureReason.NOT_CONFIGURED, `agent ${request.agentId} not found`);
      }

      const offeredActions = new Set(request.availableActions ?? []);
      const inputs: PromptInputs = {
        kind: request.kind,
        agentName: resolved.agent.name,
        settings: resolved.settings,
        personaDisplayName: resolved.persona.displayName,
        personaPrompt: resolved.persona.prompt,
        domainPromptText: resolved.domainPrompt?.text ?? null,
        masterPromptText: resolved.masterPrompt?.text ?? null,
        knowledge: resolved.knowledge,
        user: request.user,
        context: request.context,
        history: request.history,
        userMessages: request.userMessages,
        availableActions: resolved.settings.actions.filter((action) => action.enabled && offeredActions.has(action.name)),
        endReason: request.endReason,
        chipCount: request.chipCount,
      };
      const route = request.route ?? this.pickDefaultRoute(resolved.agent.modelRoutes);
      const outcome = await this.run(inputs, resolved.settings, route, Date.parse(request.deadline), request);

      this.recordSuccess(request.kind, outcome);
      return {
        ...base,
        status: GenerationStatus.SUCCESS,
        parts: outcome.result.parts,
        ...(outcome.result.chips?.length && { chips: outcome.result.chips }),
        action: outcome.result.action ?? null,
        meta: this.buildMeta(outcome, {
          agent: resolved.agent.revision,
          persona: resolved.persona.revision,
          domainPrompt: resolved.domainPrompt?.revision ?? null,
          masterPrompt: resolved.masterPrompt?.revision ?? null,
        }),
      };
    } catch (error) {
      const failure = this.toFailure(error);
      metrics.generations.inc({ kind: request.kind, status: 'failed', failure_reason: failure.reason });
      this.log.warn(
        { conversationId: request.conversationId, turnId: request.turnId, kind: request.kind, reason: failure.reason, error: failure.message },
        'generation failed',
      );
      return { ...base, status: GenerationStatus.FAILED, parts: [], failureReason: failure.reason, meta: null };
    }
  }

  /** The dashboard playground: the same pipeline against unsaved configuration. */
  async preview(request: PreviewRequest): Promise<PreviewResponse> {
    let systemPrompt = '';
    try {
      const settings = parseAgentSettings(request.agent.settings);
      const savedMaster = request.agent.masterPromptText === null ? await this.configService.resolveMasterPrompt() : null;
      const knowledge = await this.configService.resolveKnowledge(settings.knowledge.knowledgeBaseIds);
      const inputs: PromptInputs = {
        kind: request.kind,
        agentName: request.agent.name,
        settings,
        personaDisplayName: request.agent.personaName,
        personaPrompt: request.agent.personaPrompt,
        domainPromptText: request.agent.domainPromptText,
        masterPromptText: request.agent.masterPromptText ?? savedMaster?.text ?? null,
        knowledge,
        user: request.user,
        context: request.context,
        history: request.history,
        userMessages: request.userMessage ? [{ id: 'preview', body: request.userMessage }] : [],
        availableActions: settings.actions.filter((action) => action.enabled),
        endReason: request.kind === GenerationKind.FAREWELL ? 'USER_ENDED' : undefined,
        chipCount: request.kind === GenerationKind.GREETING && settings.chips.source === 'LLM' ? settings.chips.count : undefined,
      };
      systemPrompt = this.promptBuilder.build(inputs).systemPrompt;
      if (request.agent.route) {
        this.configService.invalidateProvider(request.agent.route.providerId);
      }
      const outcome = await this.run(inputs, settings, request.agent.route, Date.parse(request.deadline));
      return {
        previewId: request.previewId,
        status: GenerationStatus.SUCCESS,
        parts: outcome.result.parts,
        chips: outcome.result.chips,
        action: outcome.result.action ?? null,
        systemPrompt: outcome.systemPrompt,
        meta: this.buildMeta(outcome, { agent: null, persona: null, domainPrompt: null, masterPrompt: null }),
      };
    } catch (error) {
      const failure = this.toFailure(error);
      return {
        previewId: request.previewId,
        status: GenerationStatus.FAILED,
        parts: [],
        failureReason: failure.reason,
        errorMessage: failure.message,
        systemPrompt,
        meta: null,
      };
    }
  }

  private async run(
    inputs: PromptInputs,
    settings: AgentSettings,
    route: ModelRouteRef | null,
    deadlineMs: number,
    request?: GenerationRequest,
  ): Promise<RunOutcome> {
    if (!route) {
      throw new GenerationFailure(GenerationFailureReason.NOT_CONFIGURED, 'agent has no model route — add one in the dashboard');
    }
    const provider = await this.configService.resolveProvider(route.providerId);
    if (!provider) {
      throw new GenerationFailure(GenerationFailureReason.NOT_CONFIGURED, `LLM provider ${route.providerId} not found`);
    }
    const model = route.model || provider.defaultModel;
    if (!model) {
      throw new GenerationFailure(GenerationFailureReason.NOT_CONFIGURED, `no model set for provider "${provider.name}"`);
    }

    const client = this.clientFactory.clientFor(provider);
    const built = this.promptBuilder.build(inputs);

    const attempt = async (): Promise<LlmGenerateResult> => {
      const remaining = deadlineMs - Date.now();
      if (remaining < MIN_ATTEMPT_MS) {
        throw new GenerationFailure(GenerationFailureReason.PAST_DEADLINE, 'no time left before the deadline');
      }
      return client.generate({
        model,
        systemPrompt: built.systemPrompt,
        conversation: built.conversation,
        output: built.output,
        temperature: settings.reply.temperature,
        maxOutputTokens: settings.reply.maxOutputTokens,
        reasoningEffort: settings.reply.reasoningEffort,
        timeoutMs: Math.min(config.LLM_TIMEOUT_MS, remaining),
      });
    };

    const startedAt = Date.now();
    let result: LlmGenerateResult;
    try {
      result = await attempt();
    } catch (error) {
      if (!(error instanceof LlmError) || !error.retryable || deadlineMs - Date.now() < MIN_ATTEMPT_MS + RETRY_BACKOFF_MS) {
        this.observeLatency(provider, model, inputs.kind, 'failed', startedAt);
        throw error;
      }
      this.log.warn(
        { conversationId: request?.conversationId, provider: provider.name, model, error: describeError(error) },
        'model call failed — retrying once',
      );
      await new Promise((resolve) => setTimeout(resolve, RETRY_BACKOFF_MS));
      try {
        result = await attempt();
      } catch (retryError) {
        this.observeLatency(provider, model, inputs.kind, 'failed', startedAt);
        throw retryError;
      }
    }

    const latencyMs = this.observeLatency(provider, model, inputs.kind, 'success', startedAt);
    return { result, provider, latencyMs, systemPrompt: built.systemPrompt, knowledgeDocumentsUsed: built.knowledgeDocumentsUsed };
  }

  /** Conversations normally carry a pinned route; this covers ones created before any route existed. */
  private pickDefaultRoute(routes: Array<{ providerId: string; model: string; weight: number }>): ModelRouteRef | null {
    const route = routes.find((candidate) => candidate.weight > 0) ?? routes[0];
    return route ? { providerId: route.providerId, model: route.model } : null;
  }

  private observeLatency(provider: LlmProvider, model: string, kind: string, status: string, startedAt: number): number {
    const latencyMs = Date.now() - startedAt;
    metrics.llmLatencyMs.observe({ provider_kind: provider.kind, model, kind, status }, latencyMs);
    return latencyMs;
  }

  private recordSuccess(kind: GenerationKind, outcome: RunOutcome): void {
    metrics.generations.inc({ kind, status: 'success', failure_reason: '' });
    const labels = { provider_kind: outcome.provider.kind, model: outcome.result.model };
    if (outcome.result.inputTokens) {
      metrics.llmTokens.inc({ ...labels, direction: 'input' }, outcome.result.inputTokens);
    }
    if (outcome.result.outputTokens) {
      metrics.llmTokens.inc({ ...labels, direction: 'output' }, outcome.result.outputTokens);
    }
  }

  private buildMeta(outcome: RunOutcome, revisions: GenerationMeta['revisions']): GenerationMeta {
    return {
      providerId: outcome.provider.id,
      providerKind: outcome.provider.kind,
      model: outcome.result.model,
      latencyMs: outcome.latencyMs,
      inputTokens: outcome.result.inputTokens ?? null,
      outputTokens: outcome.result.outputTokens ?? null,
      promptVersion: PROMPT_VERSION,
      revisions,
      knowledgeDocuments: outcome.knowledgeDocumentsUsed,
    };
  }

  private toFailure(error: unknown): GenerationFailure {
    if (error instanceof GenerationFailure) {
      return error;
    }
    if (error instanceof LlmTimeoutError) {
      return new GenerationFailure(GenerationFailureReason.TIMEOUT, error.message);
    }
    if (error instanceof LlmSafetyError) {
      return new GenerationFailure(GenerationFailureReason.SAFETY_BLOCKED, error.message);
    }
    if (error instanceof LlmMalformedError) {
      return new GenerationFailure(GenerationFailureReason.MALFORMED, error.message);
    }
    if (error instanceof LlmConfigurationError) {
      return new GenerationFailure(GenerationFailureReason.NOT_CONFIGURED, error.message);
    }
    this.log.error({ error: describeError(error) }, 'unexpected generation error');
    return new GenerationFailure(GenerationFailureReason.PROVIDER_ERROR, error instanceof Error ? error.message : String(error));
  }
}
