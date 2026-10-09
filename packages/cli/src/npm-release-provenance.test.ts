import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  moveNextChannel,
  npmFailureText,
  validatePublishedProvenance,
} from "../../../scripts/publish-npm-release.mjs";

const publisher = resolve(import.meta.dirname, "../../../scripts/publish-npm-release.mjs");

const SLSA = "https://slsa.dev/provenance/v1";
const packageName = "@claudexor/core";
const version = "2.0.0";
const candidateSha = "a".repeat(40);
const sha512Hex = "b".repeat(128);
const integrity = `sha512-${Buffer.from("tarball").toString("base64")}`;
const repository = "razzant/claudexor";
const workflowPath = ".github/workflows/release.yml";
const ref = "refs/tags/v2.0.0";

function fixture() {
  const statement = {
    _type: "https://in-toto.io/Statement/v1",
    subject: [
      {
        name: "pkg:npm/%40claudexor/core@2.0.0",
        digest: { sha512: sha512Hex },
      },
    ],
    predicateType: SLSA,
    predicate: {
      buildDefinition: {
        externalParameters: {
          workflow: {
            repository: "https://github.com/razzant/claudexor",
            path: workflowPath,
            ref,
          },
        },
        resolvedDependencies: [
          {
            uri: "git+https://github.com/razzant/claudexor@refs/tags/v2.0.0",
            digest: { gitCommit: candidateSha },
          },
        ],
      },
    },
  };
  return {
    metadata: {
      "dist-tags": { latest: version },
      dist: {
        integrity,
        attestations: {
          url: "https://registry.npmjs.org/-/npm/v1/attestations/%40claudexor%2fcore@2.0.0",
          provenance: { predicateType: SLSA },
        },
      },
    },
    attestationDocument: {
      attestations: [
        {
          predicateType: SLSA,
          bundle: {
            dsseEnvelope: {
              payload: Buffer.from(JSON.stringify(statement)).toString("base64"),
            },
          },
        },
      ],
    },
    packageName,
    version,
    integrity,
    sha512Hex,
    candidateSha,
    repository,
    workflowPath,
    ref,
  };
}

function statement(input: ReturnType<typeof fixture>): any {
  const payload = input.attestationDocument.attestations[0].bundle.dsseEnvelope.payload;
  return JSON.parse(Buffer.from(payload, "base64").toString("utf8"));
}

function replaceStatement(input: ReturnType<typeof fixture>, next: unknown): void {
  input.attestationDocument.attestations[0].bundle.dsseEnvelope.payload = Buffer.from(
    JSON.stringify(next),
  ).toString("base64");
}

describe("npm release provenance", () => {
  it("rejects a branch ref before creating release output or invoking package tools", () => {
    const runnerTemp = mkdtempSync(join(tmpdir(), "claudexor-npm-ref-"));
    try {
      const result = spawnSync(process.execPath, [publisher, "--provenance"], {
        encoding: "utf8",
        env: {
          ...process.env,
          RUNNER_TEMP: runnerTemp,
          NODE_AUTH_TOKEN: "test-only-token",
          GITHUB_SHA: candidateSha,
          GITHUB_REPOSITORY: repository,
          GITHUB_REF: "refs/heads/main",
          PATH: "",
        },
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("GITHUB_REF must be the exact release tag");
      expect(existsSync(join(runnerTemp, "claudexor-npm-release"))).toBe(false);
    } finally {
      rmSync(runnerTemp, { recursive: true, force: true });
    }
  });

  it("binds the published tarball to latest, repository, workflow, tag and candidate SHA", () => {
    expect(validatePublishedProvenance(fixture())).toEqual({ ok: true, reasons: [] });
  });

  it.each([
    [
      "registry integrity",
      (input: ReturnType<typeof fixture>) => {
        input.metadata.dist.integrity = "sha512-wrong";
      },
    ],
    [
      "metadata predicate",
      (input: ReturnType<typeof fixture>) => {
        input.metadata.dist.attestations.provenance.predicateType = "wrong";
      },
    ],
    [
      "SLSA attestation",
      (input: ReturnType<typeof fixture>) => {
        input.attestationDocument.attestations = [];
      },
    ],
    [
      "subject PURL",
      (input: ReturnType<typeof fixture>) => {
        const next = statement(input);
        next.subject[0].name = "pkg:npm/other@2.0.0";
        replaceStatement(input, next);
      },
    ],
    [
      "tarball digest",
      (input: ReturnType<typeof fixture>) => {
        const next = statement(input);
        next.subject[0].digest.sha512 = "c".repeat(128);
        replaceStatement(input, next);
      },
    ],
    [
      "repository",
      (input: ReturnType<typeof fixture>) => {
        const next = statement(input);
        next.predicate.buildDefinition.externalParameters.workflow.repository =
          "https://github.com/example/other";
        replaceStatement(input, next);
      },
    ],
    [
      "workflow path",
      (input: ReturnType<typeof fixture>) => {
        const next = statement(input);
        next.predicate.buildDefinition.externalParameters.workflow.path =
          ".github/workflows/other.yml";
        replaceStatement(input, next);
      },
    ],
    [
      "workflow ref",
      (input: ReturnType<typeof fixture>) => {
        const next = statement(input);
        next.predicate.buildDefinition.externalParameters.workflow.ref = "refs/heads/main";
        replaceStatement(input, next);
      },
    ],
    [
      "candidate commit",
      (input: ReturnType<typeof fixture>) => {
        const next = statement(input);
        next.predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit = "d".repeat(40);
        replaceStatement(input, next);
      },
    ],
    [
      "latest dist-tag",
      (input: ReturnType<typeof fixture>) => {
        input.metadata["dist-tags"].latest = "1.0.1";
      },
    ],
  ])("rejects mismatched %s", (_label, mutate) => {
    const input = fixture();
    mutate(input);
    expect(validatePublishedProvenance(input).ok).toBe(false);
  });

  // v2.1.1 postmortem: builds are not byte-reproducible across CI runs, so
  // the already-published SKIP path anchors on npm's provenance instead of
  // local byte-identity — the SLSA subject must match the PUBLISHED tarball
  // digest and the workflow/tag/commit identity stays fully enforced.
  describe("allowSameSourceRebuild (retry skip path)", () => {
    function rebuildFixture() {
      const input = fixture();
      // A published tarball whose bytes differ from the local re-pack: the
      // registry integrity and the SLSA subject agree with EACH OTHER but
      // not with the local integrity/sha512Hex.
      const publishedSha512Hex = "e".repeat(128);
      input.metadata.dist.integrity = `sha512-${Buffer.from(publishedSha512Hex, "hex").toString("base64")}`;
      const next = statement(input);
      next.subject[0].digest.sha512 = publishedSha512Hex;
      replaceStatement(input, next);
      return { ...input, allowSameSourceRebuild: true };
    }

    it("accepts a same-source rebuild whose provenance matches the published bytes", () => {
      expect(validatePublishedProvenance(rebuildFixture())).toEqual({ ok: true, reasons: [] });
    });

    it("still rejects the same rebuild under the strict fresh-publish contract", () => {
      expect(
        validatePublishedProvenance({ ...rebuildFixture(), allowSameSourceRebuild: false }).ok,
      ).toBe(false);
    });

    it("rejects a published subject that does not match the published tarball", () => {
      const input = rebuildFixture();
      const next = statement(input);
      next.subject[0].digest.sha512 = "f".repeat(128);
      replaceStatement(input, next);
      expect(validatePublishedProvenance(input).ok).toBe(false);
    });

    it("rejects a rebuild from a different candidate commit", () => {
      const input = rebuildFixture();
      const next = statement(input);
      next.predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit = "d".repeat(40);
      replaceStatement(input, next);
      expect(validatePublishedProvenance(input).ok).toBe(false);
    });

    it("rejects a rebuild published by a different workflow ref", () => {
      const input = rebuildFixture();
      const next = statement(input);
      next.predicate.buildDefinition.externalParameters.workflow.ref = "refs/heads/main";
      replaceStatement(input, next);
      expect(validatePublishedProvenance(input).ok).toBe(false);
    });
  });
});

describe("npm release publishing", () => {
  it("needs no stored npm token: a run without NODE_AUTH_TOKEN reaches the release checks", () => {
    const runnerTemp = mkdtempSync(join(tmpdir(), "claudexor-npm-oidc-"));
    try {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        RUNNER_TEMP: runnerTemp,
        GITHUB_SHA: candidateSha,
        GITHUB_REPOSITORY: repository,
        GITHUB_REF: "refs/heads/main",
        PATH: "",
      };
      delete env.NODE_AUTH_TOKEN;
      const result = spawnSync(process.execPath, [publisher, "--provenance"], {
        encoding: "utf8",
        env,
      });
      expect(result.status).toBe(1);
      expect(result.stderr).not.toContain("NODE_AUTH_TOKEN");
      expect(result.stderr).toContain("GITHUB_REF must be the exact release tag");
    } finally {
      rmSync(runnerTemp, { recursive: true, force: true });
    }
  });

  it("reports npm's error lines instead of the debug-log pointer", () => {
    const stderr = [
      "npm notice Publishing to https://registry.npmjs.org/ with tag latest",
      "npm error code E401",
      "npm error 401 Unauthorized - PUT https://registry.npmjs.org/@claudexor%2fcore",
      "npm error A complete log of this run can be found in: /tmp/_logs/debug-0.log",
    ].join("\n");
    expect(npmFailureText(stderr)).toBe(
      "npm error code E401\nnpm error 401 Unauthorized - PUT https://registry.npmjs.org/@claudexor%2fcore",
    );
    expect(npmFailureText("not an npm failure\nits last line")).toBe("its last line");
    expect(npmFailureText("")).toBe("unknown error");
  });

  it("moves next when the registry allows it and never stops the release when it refuses", () => {
    const packed = [
      { pkg: { name: "@claudexor/core", version } },
      { pkg: { name: "claudexor", version } },
    ];
    const calls: string[][] = [];
    const refuseCore = (command: string, args: string[]) => {
      calls.push([command, ...args]);
      return args[2] === `@claudexor/core@${version}`
        ? {
            status: 1,
            stderr: "npm error code E401\nnpm error A complete log of this run can be found in: x",
          }
        : { status: 0, stderr: "" };
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(moveNextChannel(packed, refuseCore)).toEqual([
        `@claudexor/core@${version}: npm error code E401`,
      ]);
      expect(calls).toEqual([
        ["npm", "dist-tag", "add", `@claudexor/core@${version}`, "next"],
        ["npm", "dist-tag", "add", `claudexor@${version}`, "next"],
      ]);
      expect(log).toHaveBeenCalledWith(`npm next channel now resolves to claudexor@${version}`);
      expect(warn).toHaveBeenCalledTimes(1);

      warn.mockClear();
      expect(moveNextChannel(packed, () => ({ status: 0, stderr: "" }))).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      log.mockRestore();
    }
  });
});
