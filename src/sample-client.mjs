import { readFileSync } from "node:fs";
import { FatalError } from "./ai-client.mjs";

export const createSampleClient = ({ responsesPath }) => {
  let responses;
  try {
    responses = JSON.parse(readFileSync(responsesPath, "utf-8"));
  } catch (error) {
    throw new FatalError(`サンプル回答ファイル ${responsesPath} を読み込めません（${error.message}）`);
  }

  return {
    mode: "sample",
    model: "sample",
    usage: { requests: 0, inputTokens: 0, outputTokens: 0 },
    async judge({ id }) {
      if (!(id in responses)) throw new Error(`サンプル回答ファイルに id "${id}" の回答がありません`);
      return structuredClone(responses[id]);
    },
  };
};
