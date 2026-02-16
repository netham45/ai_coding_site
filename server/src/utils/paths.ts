import path from "node:path";
import { fileURLToPath } from "node:url";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
export const workspaceRoot = path.resolve(moduleDir, "..", "..", "..");
export const dataRoot = path.join(workspaceRoot, "data");
export const reposRoot = path.join(workspaceRoot, "repos");
