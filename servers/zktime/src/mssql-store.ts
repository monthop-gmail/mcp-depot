import sql from "mssql";
import {
  COLUMNS,
  TABLES,
  asNumber,
  cell,
  departmentFromRow,
  deviceFromRow,
  employeeFromRow,
  findName,
  punchFromRow,
  type ZktimeStore,
} from "./store.js";
import type { Department, DepartmentIds, Device, Employee, EmployeeQuery, Punch, PunchQuery, Row, Schema, Status } from "./types.js";

/** The slice of the mssql driver this store uses; tests pass a fake that records SQL text and inputs. */
export interface SqlRequest {
  input(name: string, type: unknown, value: unknown): SqlRequest;
  query(text: string): Promise<{ recordset: Row[] }>;
}
export interface SqlPool {
  request(): SqlRequest;
}

export interface MssqlConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  encrypt: boolean;
}

export function openPool(config: MssqlConfig): () => Promise<SqlPool> {
  return async () =>
    (await new sql.ConnectionPool({
      server: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      database: config.database,
      // ZKTime 5 installs run old SQL Server editions with self-signed certificates.
      options: { encrypt: config.encrypt, trustServerCertificate: true, enableArithAbort: true },
      requestTimeout: 15_000,
      connectionTimeout: 8_000,
      pool: { max: 4 },
    }).connect()) as unknown as SqlPool;
}

const quote = (name: string) => `[${name.replace(/]/g, "]]")}]`;
/** LIKE pattern for a literal substring; the value is still bound as a parameter. */
const likeContains = (text: string) => `%${text.replace(/[\\%_[]/g, (c) => `\\${c}`)}%`;

/**
 * Binds each value as its own parameter (@p0, @p1, …) and returns the placeholder list for `IN (…)`.
 * Values never enter the SQL text.
 */
export function bindList(request: SqlRequest, prefix: string, type: unknown, values: readonly unknown[]): string {
  return values
    .map((value, i) => {
      request.input(`${prefix}${i}`, type, value);
      return `@${prefix}${i}`;
    })
    .join(", ");
}

type Table = { name: string; columns: string[] };

/**
 * ZKTime 5 on SQL Server. Scopes and filters are bound parameters inside the query (ADR 0002 rule 3):
 * employees by `USERINFO.DEFAULTDEPTID IN (@d0, …)`, punches through a JOIN on USERINFO with the same filter.
 */
export class MssqlStore implements ZktimeStore {
  readonly mode = "mssql" as const;
  private pool?: Promise<SqlPool>;
  private tables?: Promise<Map<string, Table>>;

  constructor(private readonly open: () => Promise<SqlPool>) {}

  private async request(): Promise<SqlRequest> {
    this.pool ??= this.open().catch((error: unknown) => {
      this.pool = undefined;
      throw error;
    });
    return (await this.pool).request();
  }

  /** Actual names (installs differ in case) and columns of the mapped tables, read once. */
  private schema(): Promise<Map<string, Table>> {
    this.tables ??= (async () => {
      const r = await this.request();
      const list = bindList(r, "t", sql.NVarChar, TABLES);
      const { recordset } = await r.query(
        `SELECT TABLE_NAME, COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME IN (${list}) ORDER BY TABLE_NAME, ORDINAL_POSITION`,
      );
      const found = new Map<string, Table>();
      for (const row of recordset) {
        const name = String(cell(row, "TABLE_NAME"));
        const logical = findName(TABLES, name);
        if (!logical) continue;
        const table = found.get(logical) ?? { name, columns: [] };
        table.columns.push(String(cell(row, "COLUMN_NAME")));
        found.set(logical, table);
      }
      return found;
    })().catch((error: unknown) => {
      this.tables = undefined;
      throw error;
    });
    return this.tables;
  }

  /** `alias.[column]` for each wanted column the table has, so missing optional columns do not break queries. */
  private static select(table: Table, alias: string, wanted: string[]): string[] {
    return wanted.flatMap((w) => {
      const actual = findName(table.columns, w);
      return actual ? [`${alias}.${quote(actual)} AS ${quote(w)}`] : [];
    });
  }

  private static column(table: Table, alias: string, wanted: string): string {
    const actual = findName(table.columns, wanted);
    if (!actual) throw new Error(`${table.name} has no ${wanted} column`);
    return `${alias}.${quote(actual)}`;
  }

  async departmentIdsByName(names: string[]): Promise<number[]> {
    const t = (await this.schema()).get("DEPARTMENTS");
    if (!t || names.length === 0) return [];
    const r = await this.request();
    const list = bindList(r, "n", sql.NVarChar, names);
    const { recordset } = await r.query(
      `SELECT ${MssqlStore.column(t, "d", "DEPTID")} AS [DEPTID] FROM ${quote(t.name)} d WHERE ${MssqlStore.column(t, "d", "DEPTNAME")} IN (${list})`,
    );
    return recordset.map((row) => asNumber(cell(row, "DEPTID"))).filter((id) => id > 0);
  }

  async listDepartments(departmentIds: DepartmentIds): Promise<Department[]> {
    const t = (await this.schema()).get("DEPARTMENTS");
    if (!t || departmentIds?.length === 0) return [];
    const r = await this.request();
    const where = departmentIds
      ? ` WHERE ${MssqlStore.column(t, "d", "DEPTID")} IN (${bindList(r, "d", sql.Int, departmentIds)})`
      : "";
    const { recordset } = await r.query(
      `SELECT ${MssqlStore.select(t, "d", COLUMNS.DEPARTMENTS).join(", ")} FROM ${quote(t.name)} d${where} ORDER BY ${MssqlStore.column(t, "d", "DEPTID")}`,
    );
    return recordset.map(departmentFromRow).filter((d): d is Department => d !== null);
  }

  async listDevices(): Promise<Device[]> {
    const t = (await this.schema()).get("Machines");
    if (!t) return [];
    const r = await this.request();
    const { recordset } = await r.query(`SELECT ${MssqlStore.select(t, "m", COLUMNS.Machines).join(", ")} FROM ${quote(t.name)} m`);
    return recordset.map(deviceFromRow).filter((d): d is Device => d !== null);
  }

  async listEmployees(departmentIds: DepartmentIds, q: EmployeeQuery): Promise<Employee[]> {
    const u = (await this.schema()).get("USERINFO");
    if (!u || departmentIds?.length === 0) return [];
    const names = new Map((await this.listDepartments(departmentIds)).map((d) => [d.id, d.name]));
    const r = await this.request();
    r.input("limit", sql.Int, q.limit);
    const where: string[] = [];
    if (departmentIds) where.push(`${MssqlStore.column(u, "u", "DEFAULTDEPTID")} IN (${bindList(r, "d", sql.Int, departmentIds)})`);
    if (q.query) {
      r.input("q", sql.NVarChar, likeContains(q.query));
      where.push(`(${MssqlStore.column(u, "u", "Badgenumber")} LIKE @q ESCAPE '\\' OR ${MssqlStore.column(u, "u", "Name")} LIKE @q ESCAPE '\\')`);
    }
    const { recordset } = await r.query(
      `SELECT TOP (@limit) ${MssqlStore.select(u, "u", COLUMNS.USERINFO).join(", ")} FROM ${quote(u.name)} u` +
        (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
        ` ORDER BY ${MssqlStore.column(u, "u", "USERID")}`,
    );
    return recordset.map((row) => employeeFromRow(row, names)).filter((e): e is Employee => e !== null);
  }

  async listPunches(departmentIds: DepartmentIds, q: PunchQuery): Promise<Punch[]> {
    const tables = await this.schema();
    const c = tables.get("CHECKINOUT");
    const u = tables.get("USERINFO");
    if (!c || !u || departmentIds?.length === 0) return [];
    const r = await this.request();
    r.input("limit", sql.Int, q.limit);
    r.input("from", sql.VarChar, q.from);
    r.input("to", sql.VarChar, q.to);
    const time = MssqlStore.column(c, "c", "CHECKTIME");
    const where = [`${time} >= CONVERT(datetime, @from, 120)`, `${time} < DATEADD(day, 1, CONVERT(datetime, @to, 120))`];
    if (departmentIds) where.push(`${MssqlStore.column(u, "u", "DEFAULTDEPTID")} IN (${bindList(r, "d", sql.Int, departmentIds)})`);
    if (q.user_id) {
      r.input("userid", sql.Int, q.user_id);
      where.push(`${MssqlStore.column(c, "c", "USERID")} = @userid`);
    }
    if (q.check_type) {
      const codes = q.check_type === "in" ? ["I", "0"] : ["O", "1"];
      where.push(`UPPER(${MssqlStore.column(c, "c", "CHECKTYPE")}) IN (${bindList(r, "k", sql.VarChar, codes)})`);
    }
    const columns = [
      ...MssqlStore.select(c, "c", COLUMNS.CHECKINOUT),
      ...MssqlStore.select(u, "u", ["Badgenumber", "Name"]),
    ];
    const { recordset } = await r.query(
      `SELECT TOP (@limit) ${columns.join(", ")} FROM ${quote(c.name)} c` +
        ` JOIN ${quote(u.name)} u ON ${MssqlStore.column(u, "u", "USERID")} = ${MssqlStore.column(c, "c", "USERID")}` +
        ` WHERE ${where.join(" AND ")} ORDER BY ${time}`,
    );
    return recordset.map((row) => punchFromRow(row, new Map())).filter((p): p is Punch => p !== null);
  }

  private async count(table: Table | undefined, alias: string, departmentIds: DepartmentIds, column?: string): Promise<number> {
    if (!table) return 0;
    if (column && departmentIds?.length === 0) return 0;
    const r = await this.request();
    const where =
      column && departmentIds
        ? ` WHERE ${MssqlStore.column(table, alias, column)} IN (${bindList(r, "d", sql.Int, departmentIds)})`
        : "";
    const { recordset } = await r.query(`SELECT COUNT(*) AS n FROM ${quote(table.name)} ${alias}${where}`);
    return asNumber(recordset[0]?.n);
  }

  async status(departmentIds: DepartmentIds): Promise<Status> {
    const tables = await this.schema();
    if (!tables.has("USERINFO") || !tables.has("CHECKINOUT")) {
      throw new Error("ZKTime database has no USERINFO/CHECKINOUT tables");
    }
    return {
      mode: this.mode,
      sample: false,
      tables_missing: TABLES.filter((t) => !tables.has(t)),
      department_count: await this.count(tables.get("DEPARTMENTS"), "d", departmentIds, "DEPTID"),
      employee_count: await this.count(tables.get("USERINFO"), "u", departmentIds, "DEFAULTDEPTID"),
      device_count: await this.count(tables.get("Machines"), "m", undefined),
    };
  }

  async inspect(): Promise<Schema> {
    const r = await this.request();
    const { recordset } = await r.query(
      "SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME",
    );
    const tables = await this.schema();
    return {
      tables: recordset.map((row) => String(cell(row, "TABLE_NAME"))),
      columns: Object.fromEntries(TABLES.map((t) => [t, tables.get(t)?.columns ?? []])),
    };
  }
}
