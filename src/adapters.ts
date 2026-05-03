import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { copySkillSnapshot, SkillResearcher } from "./orchestrator.js";
import { EvalAgent, EvalAgentRequest } from "./runner.js";
import { EvalScore, EvalScoreSchema, parseWithSchema } from "./schemas.js";

export class SnapshotResearcher implements SkillResearcher {
  async improve(request: Parameters<SkillResearcher["improve"]>[0]): Promise<void> {
    await copySkillSnapshot(request.previousSkillDir, request.candidateSkillDir);
    await mkdir(request.candidateSkillDir, { recursive: true });
    await writeFile(
      join(request.candidateSkillDir, ".autoresearch-iteration.json"),
      `${JSON.stringify(
        {
          iteration: request.iteration,
          previousSkillDir: request.previousSkillDir,
          previousNormalizedScore: request.previousAggregate.overall.normalizedScore
        },
        null,
        2
      )}\n`,
      { flag: "wx" }
    );
  }
}

export interface FileScoreAgentOptions {
  scoreDir: string;
}

export class FileScoreAgent implements EvalAgent {
  readonly #scoreDir: string;
  readonly #seen = new Map<string, number>();

  constructor(options: FileScoreAgentOptions) {
    this.#scoreDir = options.scoreDir;
  }

  async run(request: EvalAgentRequest): Promise<EvalScore> {
    const key = request.evalCase.id;
    const count = this.#seen.get(key) ?? 0;
    this.#seen.set(key, count + 1);

    const candidates = [
      join(this.#scoreDir, `${key}-${count}.json`),
      join(this.#scoreDir, `${key}.json`),
      join(this.#scoreDir, `scores-${count}.json`)
    ];

    for (const path of candidates) {
      try {
        const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
        return parseWithSchema(EvalScoreSchema, raw, path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
    }

    throw new Error(`No file-backed score found for eval "${key}" in ${this.#scoreDir}`);
  }
}
