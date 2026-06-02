import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ProjectConfig } from "./schemas.js";

export interface RoleReference {
  field: string;
  role: string;
}

async function readRoleDirectory(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => entry.name.slice(0, -".md".length));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export async function loadAvailableFlueRoles(rootPath = process.cwd()): Promise<string[]> {
  const root = resolve(rootPath);
  const roles = await Promise.all([
    readRoleDirectory(join(root, "roles")),
    readRoleDirectory(join(root, ".flue", "roles")),
  ]);
  return [...new Set(roles.flat())].sort();
}

function missingRequiredProjectRoleFields(config: ProjectConfig): string[] {
  const roles = config.roles as Partial<Record<"judge" | "skill_builder", unknown>>;
  return [
    ["roles.judge", roles.judge],
    ["roles.skill_builder", roles.skill_builder],
  ]
    .filter(([, role]) => typeof role !== "string" || role.length === 0)
    .map(([field]) => field as string);
}

export function configuredFlueRoleReferences(config: ProjectConfig): RoleReference[] {
  return [
    { field: "roles.judge", role: config.roles.judge },
    { field: "roles.skill_builder", role: config.roles.skill_builder },
    ...config.tracks.map((track, index) => ({
      field: `tracks[${index}].role`,
      role: track.role,
    })),
  ];
}

export function validateConfiguredFlueRoles(
  config: ProjectConfig,
  availableRoles: string[],
): void {
  const missingRequiredFields = missingRequiredProjectRoleFields(config);
  if (missingRequiredFields.length > 0) {
    throw new Error(
      `Configured Flue roles are missing required fields: ${missingRequiredFields.join(", ")}`,
    );
  }

  const available = new Set(availableRoles);
  const missing = configuredFlueRoleReferences(config).filter(
    (reference) => !available.has(reference.role),
  );

  if (missing.length === 0) {
    return;
  }

  const byRole = new Map<string, string[]>();
  for (const reference of missing) {
    byRole.set(reference.role, [...(byRole.get(reference.role) ?? []), reference.field]);
  }

  const missingLines = [...byRole.entries()].map(
    ([role, fields]) => `- ${role}: ${fields.join(", ")}`,
  );
  const availableLine = availableRoles.length > 0 ? availableRoles.join(", ") : "(none)";
  throw new Error(
    [
      "Configured Flue roles are not registered.",
      "Missing roles:",
      ...missingLines,
      `Available roles: ${availableLine}`,
      "Define roles as markdown files in roles/ or .flue/roles/.",
    ].join("\n"),
  );
}
