import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MssqlStore, type SqlPool, type SqlRequest } from "../src/mssql-store.js";
import type { Row } from "../src/types.js";

/** Columns a ZKTime install has, including sensitive ones that must never be selected. */
const SCHEMA: Record<string, string[]> = {
  USERINFO: ["USERID", "Badgenumber", "SSN", "Name", "Gender", "TITLE", "CardNo", "PASSWORD", "DEFAULTDEPTID", "HIREDDAY"],
  CHECKINOUT: ["USERID", "CHECKTIME", "CHECKTYPE", "SENSORID", "WorkCode", "sn"],
  DEPARTMENTS: ["DEPTID", "DEPTNAME", "SUPDEPTID"],
  Machines: ["ID", "MachineAlias", "IP", "Port", "CommPassword", "MachineNumber", "Enabled", "sn", "ProductType"],
};

type Sent = { text: string; inputs: Map<string, unknown> };

/** Fake mssql request: records SQL text and bound inputs; answers with canned rows. */
function fakePool(answer: (text: string) => Row[] = () => []) {
  const sent: Sent[] = [];
  const pool: SqlPool = {
    request(): SqlRequest {
      const inputs = new Map<string, unknown>();
      const req: SqlRequest = {
        input(name, _type, value) {
          assert.equal(inputs.has(name), false, `parameter @${name} bound twice`);
          inputs.set(name, value);
          return req;
        },
        async query(text) {
          sent.push({ text, inputs });
          for (const [name] of inputs) assert.match(text, new RegExp(`@${name}\\b`), `@${name} bound but unused`);
          for (const m of text.matchAll(/@(\w+)/g)) assert.ok(inputs.has(m[1]!), `@${m[1]} used but not bound`);
          if (text.includes("INFORMATION_SCHEMA.COLUMNS")) {
            return { recordset: Object.entries(SCHEMA).flatMap(([t, cols]) => cols.map((c) => ({ TABLE_NAME: t, COLUMN_NAME: c }))) };
          }
          return { recordset: answer(text) };
        },
      };
      return req;
    },
  };
  const store = new MssqlStore(async () => pool);
  const last = (needle: string) => sent.filter((s) => s.text.includes(needle)).at(-1)!;
  return { store, sent, last };
}

const HOSTILE = "x'); DROP TABLE USERINFO;--";

describe("mssql store builds parameterised SQL", () => {
  it("filters employees by department with one parameter per id, inside the query", async () => {
    const { store, last } = fakePool((text) =>
      text.includes("FROM [USERINFO]") ? [{ USERID: 7, Badgenumber: "1007", Name: "Sample", DEFAULTDEPTID: 5 }] : [],
    );
    const rows = await store.listEmployees([2, 5], { query: HOSTILE, limit: 10 });
    const q = last("FROM [USERINFO]");
    assert.match(q.text, /u\.\[DEFAULTDEPTID\] IN \(@d0, @d1\)/);
    assert.match(q.text, /^SELECT TOP \(@limit\) /);
    assert.match(q.text, /LIKE @q ESCAPE/);
    assert.deepEqual([q.inputs.get("d0"), q.inputs.get("d1"), q.inputs.get("limit")], [2, 5, 10]);
    assert.equal(q.inputs.get("q"), `%${HOSTILE}%`);
    assert.equal(q.text.includes("DROP"), false, "user text never enters SQL");
    assert.doesNotMatch(q.text, /SSN|Gender|CardNo|PASSWORD/, "sensitive columns are never selected");
    assert.deepEqual(rows.map((r) => r.user_id), [7]);
  });

  it("escapes LIKE wildcards in the search value", async () => {
    const { store, last } = fakePool();
    await store.listEmployees([1], { query: "50%_[a]", limit: 5 });
    assert.equal(last("FROM [USERINFO]").inputs.get("q"), "%50\\%\\_\\[a]%");
  });

  it("filters punches through a JOIN on USERINFO with bound dates, ids and types", async () => {
    const { store, last } = fakePool((text) =>
      text.includes("FROM [CHECKINOUT]")
        ? [{ USERID: 7, CHECKTIME: new Date(Date.UTC(2026, 10, 2, 8, 1, 0)), CHECKTYPE: "I", Badgenumber: "1007", Name: "Sample" }]
        : [],
    );
    const rows = await store.listPunches([3], { from: "2026-11-01", to: "2026-11-30", user_id: 7, check_type: "in", limit: 100 });
    const q = last("FROM [CHECKINOUT]");
    assert.match(q.text, /JOIN \[USERINFO\] u ON u\.\[USERID\] = c\.\[USERID\]/);
    assert.match(q.text, /u\.\[DEFAULTDEPTID\] IN \(@d0\)/);
    assert.match(q.text, /c\.\[CHECKTIME\] >= CONVERT\(datetime, @from, 120\)/);
    assert.match(q.text, /c\.\[CHECKTIME\] < DATEADD\(day, 1, CONVERT\(datetime, @to, 120\)\)/);
    assert.match(q.text, /c\.\[USERID\] = @userid/);
    assert.match(q.text, /IN \(@k0, @k1\)/);
    assert.deepEqual(
      Object.fromEntries(q.inputs),
      { limit: 100, from: "2026-11-01", to: "2026-11-30", d0: 3, userid: 7, k0: "I", k1: "0" },
    );
    assert.doesNotMatch(q.text, /2026|'I'/, "values are parameters, not literals");
    assert.deepEqual(rows, [
      { user_id: 7, badge: "1007", name: "Sample", check_time: "2026-11-02 08:01:00", check_type: "in", check_type_raw: "I", sensor_id: undefined, serial: undefined, work_code: undefined },
    ]);
  });

  it("skips the query entirely for no departments", async () => {
    const none = fakePool();
    assert.deepEqual(await none.store.listPunches([], { from: "2026-11-01", to: "2026-11-02", limit: 10 }), []);
    assert.deepEqual(await none.store.listEmployees([], { limit: 10 }), []);
    assert.deepEqual(await none.store.listDepartments([]), []);
    assert.equal(none.sent.length, 1, "only the cached schema lookup ran");
  });

  it("resolves department names with bound parameters", async () => {
    const { store, last } = fakePool((text) => (text.includes("FROM [DEPARTMENTS]") ? [{ DEPTID: 4 }] : []));
    assert.deepEqual(await store.departmentIdsByName(["Workshop", HOSTILE]), [4]);
    const q = last("FROM [DEPARTMENTS]");
    assert.match(q.text, /d\.\[DEPTNAME\] IN \(@n0, @n1\)/);
    assert.deepEqual([q.inputs.get("n0"), q.inputs.get("n1")], ["Workshop", HOSTILE]);
    assert.equal(q.text.includes("DROP"), false);
  });

  it("counts within the scope and never selects the device password", async () => {
    const { store, sent, last } = fakePool((text) => (text.startsWith("SELECT COUNT") ? [{ n: 3 }] : []));
    const status = await store.status([2]);
    assert.equal(status.employee_count, 3);
    assert.match(last("COUNT(*) AS n FROM [USERINFO]").text, /u\.\[DEFAULTDEPTID\] IN \(@d0\)/);
    await store.listDevices();
    assert.doesNotMatch(last("FROM [Machines]").text, /CommPassword/);
    assert.equal(sent.filter((s) => s.text.includes("INFORMATION_SCHEMA.COLUMNS")).length, 1, "schema read once");
  });
});
