import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
  COLUMNS,
  TABLES,
  asNumber,
  cell,
  departmentFromRow,
  deviceFromRow,
  employeeFromRow,
  findName,
  inDateRange,
  inDepartments,
  matchesQuery,
  punchFromRow,
  type ZktimeStore,
} from "./store.js";
import type { Department, DepartmentIds, Device, Employee, EmployeeQuery, Punch, PunchQuery, Row, Schema, Status } from "./types.js";

const MAX_OUTPUT = 64 * 1024 * 1024;

/** Runs an mdb-tools command (no shell) and returns its stdout. */
function run(cmd: string, args: string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], signal });
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      out += chunk;
      if (out.length > MAX_OUTPUT) child.kill();
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (err += chunk.slice(0, 2000)));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve(out) : reject(new Error(`${cmd} failed (${code}): ${err.trim().slice(0, 300)}`)),
    );
  });
}

/**
 * Streams a table as one JSON object per line (`mdb-json`) and keeps only rows `keep` accepts, so a large
 * CHECKINOUT is never held in memory as a whole.
 */
function scan(mdbPath: string, table: string, keep: (row: Row) => boolean, signal?: AbortSignal): Promise<Row[]> {
  return new Promise((resolve, reject) => {
    const child = spawn("mdb-json", ["-T", "%Y-%m-%d %H:%M:%S", mdbPath, table], {
      stdio: ["ignore", "pipe", "pipe"],
      signal,
    });
    const rows: Row[] = [];
    let err = "";
    let bad: Error | undefined;
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (err += chunk.slice(0, 2000)));
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => {
      if (bad || !line.trim()) return;
      try {
        const row = JSON.parse(line) as Row;
        if (keep(row)) rows.push(row);
      } catch (error) {
        bad = error instanceof Error ? error : new Error(String(error));
        child.kill();
      }
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (bad) reject(new Error(`mdb-json returned unreadable output for ${table}: ${bad.message}`));
      else if (code !== 0) reject(new Error(`mdb-json failed (${code}): ${err.trim().slice(0, 300)}`));
      else resolve(rows);
    });
  });
}

/** ZKTIME_MDB_FILE if set, else att2000.mdb, else the first .mdb in the data directory. */
export function resolveMdbFile(dataDir: string, named = ""): string {
  if (named) return named.startsWith("/") ? named : join(dataDir, named);
  const mdbs = readdirSync(dataDir).filter((n) => n.toLowerCase().endsWith(".mdb")).sort();
  const chosen = findName(mdbs, "att2000.mdb") ?? mdbs[0];
  if (!chosen) throw new Error(`no .mdb file in ${dataDir}`);
  return join(dataDir, chosen);
}

/** Picks only the mapped columns, so nothing else (fingerprints, passwords, card numbers…) leaves this module. */
const pick = (row: Row, wanted: string[]): Row => Object.fromEntries(wanted.map((w) => [w, cell(row, w)]));

/**
 * ZKTime 5 Access database (att2000.mdb), read with mdb-tools.
 *
 * mdb-tools has no WHERE clause: `mdb-json`/`mdb-export` always emit the whole table. The department scope is
 * therefore applied here, row by row while parsing the export and before anything is returned or retained —
 * the closest this backend has to filtering in the query (ADR 0002 rule 3). Rows outside the scope are dropped
 * as they stream past and are never collected.
 */
export class MdbStore implements ZktimeStore {
  readonly mode = "mdb" as const;

  constructor(
    private readonly dataDir: string,
    private readonly mdbFile = "",
  ) {}

  private path(): string {
    return resolveMdbFile(this.dataDir, this.mdbFile);
  }

  private async tables(mdbPath: string, signal?: AbortSignal): Promise<string[]> {
    return (await run("mdb-tables", ["-1", mdbPath], signal)).split("\n").map((t) => t.trim()).filter(Boolean);
  }

  private async table(logical: (typeof TABLES)[number], keep: (row: Row) => boolean, signal?: AbortSignal): Promise<Row[]> {
    const mdbPath = this.path();
    const actual = findName(await this.tables(mdbPath, signal), logical);
    if (!actual) return [];
    return (await scan(mdbPath, actual, keep, signal)).map((row) => pick(row, COLUMNS[logical]));
  }

  private deptOf = (row: Row) => asNumber(cell(row, "DEFAULTDEPTID")) || undefined;

  async departmentIdsByName(names: string[], signal?: AbortSignal): Promise<number[]> {
    if (names.length === 0) return [];
    const rows = await this.table("DEPARTMENTS", (row) => names.includes(String(cell(row, "DEPTNAME") ?? "").trim()), signal);
    return rows.map((row) => asNumber(cell(row, "DEPTID"))).filter((id) => id > 0);
  }

  async listDepartments(departmentIds: DepartmentIds, signal?: AbortSignal): Promise<Department[]> {
    if (departmentIds?.length === 0) return [];
    const rows = await this.table("DEPARTMENTS", (row) => inDepartments(departmentIds, asNumber(cell(row, "DEPTID"))), signal);
    return rows.map(departmentFromRow).filter((d): d is Department => d !== null).sort((a, b) => a.id - b.id);
  }

  async listDevices(signal?: AbortSignal): Promise<Device[]> {
    return (await this.table("Machines", () => true, signal)).map(deviceFromRow).filter((d): d is Device => d !== null);
  }

  /** Employees in scope, keyed by USERID; punches are joined to this in memory. */
  private async people(departmentIds: DepartmentIds, signal?: AbortSignal): Promise<Employee[]> {
    if (departmentIds?.length === 0) return [];
    const [rows, departments] = await Promise.all([
      this.table("USERINFO", (row) => inDepartments(departmentIds, this.deptOf(row)), signal),
      this.listDepartments(departmentIds, signal),
    ]);
    const names = new Map(departments.map((d) => [d.id, d.name]));
    return rows
      .map((row) => employeeFromRow(row, names))
      .filter((e): e is Employee => e !== null)
      .sort((a, b) => a.user_id - b.user_id);
  }

  async listEmployees(departmentIds: DepartmentIds, q: EmployeeQuery, signal?: AbortSignal): Promise<Employee[]> {
    return (await this.people(departmentIds, signal)).filter((e) => matchesQuery(q.query, e)).slice(0, q.limit);
  }

  async listPunches(departmentIds: DepartmentIds, q: PunchQuery, signal?: AbortSignal): Promise<Punch[]> {
    if (departmentIds?.length === 0) return [];
    const people = new Map((await this.people(departmentIds, signal)).map((e) => [e.user_id, { badge: e.badge, name: e.name }]));
    // Scope: a punch is kept only if its USERID belongs to an employee in the permitted departments.
    const rows = await this.table(
      "CHECKINOUT",
      (row) => {
        const p = punchFromRow(row, people);
        return (
          p !== null &&
          people.has(p.user_id) &&
          inDateRange(p.check_time, q.from, q.to) &&
          (!q.user_id || p.user_id === q.user_id) &&
          (!q.check_type || p.check_type === q.check_type)
        );
      },
      signal,
    );
    return rows
      .map((row) => punchFromRow(row, people))
      .filter((p): p is Punch => p !== null)
      .sort((a, b) => a.check_time.localeCompare(b.check_time))
      .slice(0, q.limit);
  }

  async status(departmentIds: DepartmentIds, signal?: AbortSignal): Promise<Status> {
    const mdbPath = this.path();
    const tables = await this.tables(mdbPath, signal);
    if (!findName(tables, "USERINFO") || !findName(tables, "CHECKINOUT")) {
      throw new Error("ZKTime database has no USERINFO/CHECKINOUT tables");
    }
    const [departments, employees, devices] = await Promise.all([
      this.listDepartments(departmentIds, signal),
      this.people(departmentIds, signal),
      this.listDevices(signal),
    ]);
    return {
      mode: this.mode,
      sample: false,
      tables_missing: TABLES.filter((t) => !findName(tables, t)),
      department_count: departments.length,
      employee_count: employees.length,
      device_count: devices.length,
    };
  }

  async inspect(signal?: AbortSignal): Promise<Schema> {
    const mdbPath = this.path();
    const tables = await this.tables(mdbPath, signal);
    const columns: Record<string, string[]> = {};
    for (const logical of TABLES) {
      const actual = findName(tables, logical);
      // mdb-schema prints DDL; column lines look like `\t[Name]\t\t\tType`.
      const ddl = actual ? await run("mdb-schema", ["-T", actual, mdbPath], signal) : "";
      columns[logical] = [...ddl.matchAll(/^\s+\[([^\]]+)\]\s/gm)].map((m) => m[1]!);
    }
    return { tables, columns };
  }
}
