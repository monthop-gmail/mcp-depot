import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import _Ajv2020 from "ajv/dist/2020.js";
import type { ErrorObject, ValidateFunction } from "ajv";
import _addFormats from "ajv-formats";

// ajv ships CommonJS; unwrap the default export under NodeNext.
const Ajv2020 = _Ajv2020 as unknown as typeof _Ajv2020.default;
const addFormats = _addFormats as unknown as typeof _addFormats.default;

/** Repository-level schemas live in /schemas; core resolves them from its own location. */
const SCHEMA_DIR = fileURLToPath(new URL("../../../../schemas/", import.meta.url));

export const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false, useDefaults: false });
addFormats(ajv);

function load(name: string): ValidateFunction {
  const schema = JSON.parse(readFileSync(`${SCHEMA_DIR}${name}`, "utf8")) as Record<string, unknown>;
  return ajv.compile(schema);
}

export const validateManifest = load("server-manifest.schema.json");
export const validateRoles = load("roles.schema.json");
export const validateMembers = load("members.schema.json");

export function describeErrors(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? [])
    .slice(0, 5)
    .map((e) => `${e.instancePath || "/"} ${e.message ?? "invalid"}`)
    .join("; ");
}
