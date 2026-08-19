import { appendFile, chmod, cp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

export interface SandboxMount {
  source: string;
  target: string;
  readOnly: boolean;
}

export interface EvalSandbox {
  evalId: string;
  mounts: SandboxMount[];
  outputDir: string;
  assertWritable(path: string): void;
  writeFile(path: string, contents: string): Promise<void>;
  appendFile(path: string, contents: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  rm(path: string): Promise<void>;
  cp(from: string, to: string): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
}

export interface CreateEvalSandboxOptions {
  evalId: string;
  inputDir: string;
  referenceDir: string;
  evalsDir: string;
  outputDir: string;
  skillDir?: string;
}

function isWithin(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
}

function erofs(path: string): NodeJS.ErrnoException {
  const error = new Error(`Read-only sandbox path: ${path}`) as NodeJS.ErrnoException;
  error.code = "EROFS";
  return error;
}

export function createEvalSandbox(options: CreateEvalSandboxOptions): EvalSandbox {
  const outputDir = resolve(options.outputDir, options.evalId);
  const mounts: SandboxMount[] = [
    { source: resolve(options.inputDir), target: "/input", readOnly: true },
    { source: resolve(options.referenceDir), target: "/reference", readOnly: true },
    { source: resolve(options.evalsDir), target: "/evals", readOnly: true },
    { source: outputDir, target: "/output", readOnly: false }
  ];

  if (options.skillDir) {
    mounts.push({ source: resolve(options.skillDir), target: "/skill", readOnly: true });
  }

  const assertWritable = (path: string) => {
    const absolute = resolve(path);
    const readOnlyMount = mounts.find((mount) => mount.readOnly && isWithin(mount.source, absolute));
    if (readOnlyMount) {
      throw erofs(path);
    }
    if (!isWithin(outputDir, absolute)) {
      throw erofs(path);
    }
  };

  return {
    evalId: options.evalId,
    mounts,
    outputDir,
    assertWritable,
    async writeFile(path, contents) {
      assertWritable(path);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, contents, "utf8");
    },
    async appendFile(path, contents) {
      assertWritable(path);
      await mkdir(dirname(path), { recursive: true });
      await appendFile(path, contents, "utf8");
    },
    async mkdir(path) {
      assertWritable(path);
      await mkdir(path, { recursive: true });
    },
    async rm(path) {
      assertWritable(path);
      await rm(path, { recursive: true, force: true });
    },
    async cp(from, to) {
      assertWritable(to);
      await mkdir(dirname(to), { recursive: true });
      await cp(from, to, { recursive: true });
    },
    async chmod(path, mode) {
      assertWritable(path);
      await chmod(path, mode);
    }
  };
}
