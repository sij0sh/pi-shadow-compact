import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { defaultConfig } from "../src/config.js";
import { resolveSummarizerModel, resolveVerificationModel } from "../src/summary.js";

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
const defaultPair = { provider: "default", id: "configured" };
const defaultModel = { provider: "default", id: "configured", api: "test" } as Model<Api>;

type SummaryContext = Pick<ExtensionContext, "model" | "modelRegistry">;

function registry(
  finds: Array<[string, string]>,
  found: Model<Api> | undefined,
): ExtensionContext["modelRegistry"] {
  return {
    find(provider: string, id: string) {
      finds.push([provider, id]);
      return found;
    },
  } as unknown as ExtensionContext["modelRegistry"];
}

function context(finds: Array<[string, string]>, found: Model<Api> | undefined): SummaryContext {
  return { model: sessionModel, modelRegistry: registry(finds, found) };
}

/** Resolves the configured pair and Pi's default pair to distinct models. */
function layeredContext(finds: Array<[string, string]>): SummaryContext {
  return {
    model: sessionModel,
    modelRegistry: {
      find(provider: string, id: string) {
        finds.push([provider, id]);
        if (provider === "configured" && id === "summary") return summaryModel;
        if (provider === "default" && id === "configured") return defaultModel;
        return undefined;
      },
    } as unknown as SummaryContext["modelRegistry"],
  };
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

  it("falls back to the session model when the configured model is missing", () => {
    const finds: Array<[string, string]> = [];

    const resolved = resolveSummarizerModel(context(finds, undefined), config);

    assert.equal(resolved, sessionModel);
    assert.deepEqual(finds, [["configured", "summary"]]);
  });

  it("uses Pi's configured default model when the summarizer pair is blank", () => {
    const finds: Array<[string, string]> = [];

    const resolved = resolveSummarizerModel(layeredContext(finds), blankModelConfig, defaultPair);

    assert.equal(resolved, defaultModel);
    assert.deepEqual(finds, [["default", "configured"]]);
  });

  it("uses the configured pair before Pi's configured default model", () => {
    const finds: Array<[string, string]> = [];

    const resolved = resolveSummarizerModel(layeredContext(finds), config, defaultPair);

    assert.equal(resolved, summaryModel);
    assert.deepEqual(finds, [["configured", "summary"]]);
  });

  it("uses Pi's configured default model when the configured pair is missing", () => {
    const finds: Array<[string, string]> = [];

    const resolved = resolveSummarizerModel(
      layeredContext(finds),
      { ...config, summarizerModel: { provider: "gone", id: "removed" } },
      defaultPair,
    );

    assert.equal(resolved, defaultModel);
    assert.deepEqual(finds, [
      ["gone", "removed"],
      ["default", "configured"],
    ]);
  });

  it("throws when no configured, default, or session model resolves", () => {
    assert.throws(
      () => resolveSummarizerModel(contextWithoutSessionModel([], undefined), blankModelConfig),
      /Summary model not found: current Pi session model/,
    );
    assert.throws(
      () =>
        resolveSummarizerModel(
          contextWithoutSessionModel([], undefined),
          blankModelConfig,
          defaultPair,
        ),
      /Summary model not found: default\/configured/,
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

    assert.equal(
      resolveVerificationModel(context(finds, summaryModel), blankModelConfig),
      sessionModel,
    );
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

  it("falls back to the summarizer chain when the configured verification model is missing", () => {
    const finds: Array<[string, string]> = [];

    const resolved = resolveVerificationModel(context(finds, undefined), verifierConfig);

    assert.equal(resolved, sessionModel);
    assert.deepEqual(finds, [
      ["configured", "verifier"],
      ["configured", "summary"],
    ]);
  });

  it("uses Pi's configured default model when both pairs are blank", () => {
    const finds: Array<[string, string]> = [];

    const resolved = resolveVerificationModel(layeredContext(finds), blankModelConfig, defaultPair);

    assert.equal(resolved, defaultModel);
    assert.deepEqual(finds, [["default", "configured"]]);
  });
});
