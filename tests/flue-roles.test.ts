import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadAvailableFlueRoles } from "../src/flue-roles.js";
import { tempProject } from "./helpers.js";

test("discovers sorted unique roles from roles and .flue/roles", async () => {
  const root = await tempProject();
  const rolesDir = join(root, "roles");
  const flueRolesDir = join(root, ".flue", "roles");
  await mkdir(rolesDir, { recursive: true });
  await mkdir(flueRolesDir, { recursive: true });
  await Promise.all([
    writeFile(join(rolesDir, "zebra.md"), "Role"),
    writeFile(join(rolesDir, "shared.md"), "Role"),
    writeFile(join(rolesDir, "ignored.txt"), "Not a role"),
    writeFile(join(flueRolesDir, "alpha.md"), "Role"),
    writeFile(join(flueRolesDir, "shared.md"), "Role")
  ]);

  await expect(loadAvailableFlueRoles(root)).resolves.toEqual(["alpha", "shared", "zebra"]);
});
