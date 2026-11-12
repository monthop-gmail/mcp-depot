import { ToolError, type ToolContext, type ToolDefinition } from "@mcp-depot/core";
import type { ZktimeStore } from "./store.js";
import type { DepartmentIds } from "./types.js";

export const MAX_RANGE_DAYS = 31;

/**
 * Resolves the member's `departments` scope (explicit names) to department ids once per call; the ids then go
 * into every store query (ADR 0002 rule 3). There is no "all departments": this is personal data and core
 * refuses the wildcard. Unknown names resolve to nothing, so a member scoped only to departments that do not
 * exist sees empty results rather than an error.
 */
async function permittedDepartmentIds(store: ZktimeStore, ctx: ToolContext): Promise<DepartmentIds> {
  const names = ctx.scopes.departments ?? [];
  return names.length === 0 ? [] : store.departmentIdsByName(names, ctx.signal);
}

const DAY_MS = 86_400_000;
const parseDay = (text: string) => {
  const t = Date.parse(`${text}T00:00:00Z`);
  return Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== text ? undefined : t;
};

/** `from`/`to` are required, inclusive and at most MAX_RANGE_DAYS days apart. */
export function checkRange(from: string, to: string): void {
  const a = parseDay(from);
  const b = parseDay(to);
  if (a === undefined || b === undefined) throw new ToolError("invalid arguments: from/to must be real dates (YYYY-MM-DD)");
  if (b < a) throw new ToolError("invalid arguments: to is before from");
  if ((b - a) / DAY_MS + 1 > MAX_RANGE_DAYS) {
    throw new ToolError(`invalid arguments: date range exceeds ${MAX_RANGE_DAYS} days`);
  }
}

const query = { type: "string", minLength: 1, maxLength: 100, description: "Case-insensitive substring." };
const limit = (max: number, def: number) => ({
  type: "integer",
  minimum: 1,
  maximum: max,
  description: `Maximum rows (default ${def}, at most ${max}).`,
});
const date = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "YYYY-MM-DD (inclusive)." };
const contains = (text: string | undefined, ...fields: Array<string | undefined>) =>
  !text || fields.some((f) => (f ?? "").toLowerCase().includes(text.toLowerCase()));

/**
 * Tools receive validated arguments and a context with the verified principal and its scopes.
 * Identity and roles were already checked by core's guard; this file only applies the department scope.
 */
export function zktimeTools(store: ZktimeStore): Record<string, ToolDefinition<any>> {
  const getStatus: ToolDefinition<Record<string, never>> = {
    description:
      "ZKTime 5 attendance connection status: backend mode (fixture, mdb, mssql), missing tables, and counts " +
      "of departments and employees within your permitted departments.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async (_args, ctx) => ({ ok: true, ...(await store.status(await permittedDepartmentIds(store, ctx), ctx.signal)) }),
  };

  const listDepartments: ToolDefinition<{ query?: string; limit?: number }> = {
    description: "Departments in ZKTime that you are permitted to see.",
    inputSchema: {
      type: "object",
      properties: { query, limit: limit(200, 100) },
      additionalProperties: false,
    },
    handler: async ({ query: text, limit: max = 100 }, ctx) => {
      const rows = (await store.listDepartments(await permittedDepartmentIds(store, ctx), ctx.signal))
        .filter((d) => contains(text, d.name))
        .slice(0, max);
      return { sample: store.mode === "fixture", count: rows.length, departments: rows };
    },
  };

  const listDevices: ToolDefinition<{ query?: string; limit?: number }> = {
    description:
      "ZKTime attendance terminals: alias, address, serial and model. Terminals are not tied to a department.",
    inputSchema: {
      type: "object",
      properties: { query, limit: limit(200, 50) },
      additionalProperties: false,
    },
    handler: async ({ query: text, limit: max = 50 }, ctx) => {
      const rows = (await store.listDevices(ctx.signal))
        .filter((d) => contains(text, d.alias, d.ip, d.serial))
        .slice(0, max);
      return { sample: store.mode === "fixture", count: rows.length, devices: rows };
    },
  };

  const listEmployees: ToolDefinition<{ query?: string; limit?: number }> = {
    description:
      "Employees in your permitted departments: badge, name, department, title, hire date. " +
      "Optionally search by badge or name.",
    inputSchema: {
      type: "object",
      properties: { query, limit: limit(200, 50) },
      additionalProperties: false,
    },
    handler: async ({ query: text, limit: max = 50 }, ctx) => {
      const rows = await store.listEmployees(await permittedDepartmentIds(store, ctx), { query: text, limit: max }, ctx.signal);
      return { sample: store.mode === "fixture", count: rows.length, limit: max, employees: rows };
    },
  };

  const listPunches: ToolDefinition<{
    from: string;
    to: string;
    user_id?: number;
    check_type?: "in" | "out" | "all";
    limit?: number;
  }> = {
    description:
      `Clock-in/out punches of employees in your permitted departments, oldest first, for a date range of at most ` +
      `${MAX_RANGE_DAYS} days (from/to inclusive, terminal local time).`,
    inputSchema: {
      type: "object",
      properties: {
        from: date,
        to: date,
        user_id: { type: "integer", minimum: 1, description: "USERID from list_employees." },
        check_type: { type: "string", enum: ["in", "out", "all"], description: "Default all." },
        limit: limit(500, 100),
      },
      required: ["from", "to"],
      additionalProperties: false,
    },
    handler: async ({ from, to, user_id, check_type = "all", limit: max = 100 }, ctx) => {
      checkRange(from, to);
      const rows = await store.listPunches(
        await permittedDepartmentIds(store, ctx),
        { from, to, user_id, check_type: check_type === "all" ? undefined : check_type, limit: max },
        ctx.signal,
      );
      return { sample: store.mode === "fixture", from, to, count: rows.length, limit: max, truncated: rows.length === max, punches: rows };
    },
  };

  const inspectSchema: ToolDefinition<Record<string, never>> = {
    description: "Table names and the columns of the tables this server reads, without any row data.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async (_args, ctx) => ({ mode: store.mode, ...(await store.inspect(ctx.signal)) }),
  };

  return {
    get_status: getStatus,
    list_departments: listDepartments,
    list_devices: listDevices,
    list_employees: listEmployees,
    list_punches: listPunches,
    inspect_schema: inspectSchema,
  };
}
