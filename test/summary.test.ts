import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { defaultConfig } from "../src/config.js";
import {
  resolveSummarizerModel,
  resolveVerificationModel,
} from "../src/summary.js";

const config = {
  ...defaultConfig(),
  summarizerModel: { provider: "configured", id: "summary" },
};
const blankModelConfig = { ...config, summarizerModel: { provider: "", id: "" } };
const verifierConfig = {
  ...config,
  verificationModel: { provider: "configured", id: "verifier" },
};

const sessionModel = { provider: "session", id: "current", api: "test" } as Model<Api>;
const summaryModel = { provider: "configured", id: "summary", api: "test" } as Model<Api>;
const verifierModel = { provider: "configured", id: "verifier", api: "test" } as Model<Api>;

type SummaryContext = Pick<ExtensionContext, "model" | "modelRegistry">;

function registry(finds: Array<[string, string]>, found: Model<Api> | undefined): ExtensionContext["modelRegistry"] {
  return {
    find(provider: string, id: string) {
      finds.push([provider, id]);
      return found;
    },
  } as unknown as ExtensionContext["modelRegistry"];
}

function context(
  finds: Array<[string, string]>,
  found: Model<Api> | undefined,
): SummaryContext {
  return { model: sessionModel, modelRegistry: registry(finds, found) };
}

function contextWithoutSessionModel(
  finds: Array<[string, string]>,
  found: Model<Api> | undefined,
): SummaryContext {
  return { model: undefined, modelRegistry: registry(finds, found) };
}

describe("resolveSummarizerModel", () => {
  it("resolves the configured pair through the model registry", () => {
    const finds: Array<[string, string]> = [];

    const resolved = resolveSummarizerModel(context(finds, summaryModel), config);

    assert.deepEqual(finds, [["configured", "summary"]]);
    assert.equal(resolved, summaryModel);
  });

  it("uses the session model when the configured pair is blank", () => {
    const finds: Array<[string, string]> = [];

    const resolved = resolveSummarizerModel(context(finds, summaryModel), blankModelConfig);

    assert.deepEqual(finds, []);
    assert.equal(resolved, sessionModel);
  });

  it("throws when the configured model is missing", () => {
    assert.throws(
      () => resolveSummarizerModel(context([], undefined), config),
      /Summary model not found: configured\/summary/,
    );
  });

  it("throws when the pair is blank and no session model exists", () => {
    assert.throws(
      () => resolveSummarizerModel(contextWithoutSessionModel([], summaryModel), blankModelConfig),
      /Summary model not found: current Pi session model/,
    );
  });
});

describe("resolveVerificationModel", () => {
  it("reuses the summarizer model when no verification pair is configured", () => {
    const finds: Array<[string, string]> = [];

    assert.equal(resolveVerificationModel(context(finds, summaryModel), config), summaryModel);
    assert.deepEqual(finds, [["configured", "summary"]]);
  });

  it("reuses the session model when both pairs are blank", () => {
    const finds: Array<[string, string]> = [];

    assert.equal(resolveVerificationModel(context(finds, summaryModel), blankModelConfig), sessionModel);
    assert.deepEqual(finds, []);
  });

  it("resolves a configured verification pair through the model registry", () => {
    const finds: Array<[string, string]> = [];
    const registryWithVerifier = {
      find(provider: string, id: string) {
        finds.push([provider, id]);
        return provider === "configured" && id === "verifier" ? verifierModel : undefined;
      },
    } as unknown as SummaryContext["modelRegistry"];

    const resolved = resolveVerificationModel(
      { model: sessionModel, modelRegistry: registryWithVerifier },
      verifierConfig,
    );

    assert.equal(resolved, verifierModel);
    assert.deepEqual(finds, [["configured", "verifier"]]);
  });

  it("throws when the configured verification model is missing", () => {
    assert.throws(
      () => resolveVerificationModel(context([], undefined), verifierConfig),
      /Verification model not found: configured\/verifier/,
    );
  });
});
