import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import Anthropic from "@anthropic-ai/sdk";

export const DEFAULT_MODEL = "claude-haiku-5-5";

const PRICES_PER_MILLION = {
  "claude-haiku-5-5": {
    input: 0.1,
    output: 0.5,
    longPrompt: { overTokens: 100_000, input: 0.5, output: 2.5 },
  },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-haiku-4-5": { input: 1, output: 5 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-opus-5": { input: 5, output: 25 },
};

const requestCostUsd = (model, { promptTokens, inputTokens, outputTokens }) => {
  const base = PRICES_PER_MILLION[model];
  if (!base) return null;
  const price =
    base.longPrompt && promptTokens > base.longPrompt.overTokens
      ? base.longPrompt
      : base;
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
};

export class FatalError extends Error {}

const describeApiError = (error, model) => {
  if (error instanceof Anthropic.AuthenticationError)
    return new FatalError(
      "APIキーが無効です。.env の ANTHROPIC_API_KEY を確認してください",
    );
  if (error instanceof Anthropic.PermissionDeniedError)
    return new FatalError(`このAPIキーではモデル ${model} を利用できません`);
  if (error instanceof Anthropic.NotFoundError)
    return new FatalError(
      `モデル ${model} が見つかりません。.env の AI_MODEL を確認してください`,
    );
  if (error instanceof Anthropic.RateLimitError)
    return new Error(
      "APIの利用上限（レート制限）に達しました。時間をおいて再実行してください",
    );
  if (error instanceof Anthropic.BadRequestError)
    return new Error(
      `APIがリクエストを受け付けませんでした（${error.message}）`,
    );
  if (error instanceof Anthropic.APIError)
    return new Error(`APIエラー ${error.status ?? ""}（${error.message}）`);
  return error;
};

export const createAiClient = ({
  model = DEFAULT_MODEL,
  responsesPath,
} = {}) => {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new FatalError(
      "ANTHROPIC_API_KEY が設定されていません。.env.example をコピーして .env を作るか、--sample を付けてサンプル実行モードで試してください",
    );
  }
  const client = new Anthropic();
  const responses = {};
  const usage = {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: PRICES_PER_MILLION[model] ? 0 : null,
  };

  return {
    mode: "ai",
    model,
    usage,
    async judge({ id, system, input, schema }) {
      let response;
      try {
        response = await client.messages.create({
          model,
          max_tokens: 16000,
          system,
          messages: [{ role: "user", content: input }],
          output_config: { format: { type: "json_schema", schema } },
        });
      } catch (error) {
        throw describeApiError(error, model);
      }

      const {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_read_input_tokens: cacheRead,
        cache_creation_input_tokens: cacheWrite,
      } = response.usage;
      usage.requests += 1;
      usage.inputTokens += inputTokens;
      usage.outputTokens += outputTokens;
      if (usage.costUsd !== null) {
        const promptTokens = inputTokens + (cacheRead ?? 0) + (cacheWrite ?? 0);
        usage.costUsd += requestCostUsd(model, {
          promptTokens,
          inputTokens,
          outputTokens,
        });
      }

      if (response.stop_reason === "refusal")
        throw new Error("AIが回答を拒否しました");
      if (response.stop_reason === "max_tokens")
        throw new Error("AIの出力が上限で途切れました");
      const text = response.content.find(
        (block) => block.type === "text",
      )?.text;
      if (!text) throw new Error("AIの応答にテキストがありません");

      let data;
      try {
        data = JSON.parse(text);
      } catch (error) {
        throw new Error(`AI応答のJSON解析に失敗（${error.message}）`);
      }
      if (responsesPath) {
        responses[id] = data;
        mkdirSync(dirname(responsesPath), { recursive: true });
        writeFileSync(responsesPath, `${JSON.stringify(responses, null, 2)}\n`);
      }
      return data;
    },
  };
};
