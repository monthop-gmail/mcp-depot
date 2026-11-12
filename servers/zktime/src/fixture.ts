import { inDateRange, inDepartments, matchesQuery, type ZktimeStore } from "./store.js";
import type { Department, DepartmentIds, Device, Employee, EmployeeQuery, Punch, PunchQuery, Schema, Status } from "./types.js";

/**
 * Synthetic ZKTime for tests and demos. All people, departments and terminals are invented; addresses are
 * from the documentation range 192.0.2.0/24. It records the department filter each call received, so tests
 * can prove the scope reaches the store rather than being applied to results afterwards.
 */
const departments: Department[] = [
  { id: 1, name: "Head Office" },
  { id: 2, name: "Workshop", parent_id: 1 },
  { id: 3, name: "Warehouse", parent_id: 1 },
];

const employees: Employee[] = [
  { user_id: 1, badge: "1001", name: "Sample Person A", department_id: 1, department: "Head Office", title: "Clerk", hired_on: "2020-03-01" },
  { user_id: 2, badge: "1002", name: "Sample Person B", department_id: 2, department: "Workshop", title: "Technician", hired_on: "2021-08-15" },
  { user_id: 3, badge: "1003", name: "Sample Person C", department_id: 2, department: "Workshop", title: "Technician", hired_on: "2022-01-10" },
  { user_id: 4, badge: "1004", name: "Sample Person D", department_id: 3, department: "Warehouse", title: "Storekeeper", hired_on: "2023-05-02" },
];

const devices: Device[] = [
  { id: 1, alias: "Main entrance", ip: "192.0.2.21", port: 4370, enabled: true, serial: "DEMO0001", machine_number: 1, product_type: "DEMO-F1" },
  { id: 2, alias: "Side door", ip: "192.0.2.22", port: 4370, enabled: true, serial: "DEMO0002", machine_number: 2, product_type: "DEMO-F1" },
];

const punch = (user_id: number, check_time: string, raw: "I" | "O", sensor_id: string): Punch => {
  const e = employees.find((x) => x.user_id === user_id)!;
  return { user_id, badge: e.badge, name: e.name, check_time, check_type: raw === "I" ? "in" : "out", check_type_raw: raw, sensor_id };
};

const punches: Punch[] = [
  punch(1, "2026-11-02 08:01:00", "I", "1"),
  punch(2, "2026-11-02 07:55:00", "I", "2"),
  punch(3, "2026-11-02 08:10:00", "I", "2"),
  punch(4, "2026-11-02 07:45:00", "I", "1"),
  punch(1, "2026-11-02 17:05:00", "O", "1"),
  punch(2, "2026-11-02 17:00:00", "O", "2"),
  punch(3, "2026-11-02 17:20:00", "O", "2"),
  punch(4, "2026-11-02 16:50:00", "O", "1"),
  punch(1, "2026-11-03 08:03:00", "I", "1"),
  punch(2, "2026-11-03 07:58:00", "I", "2"),
  punch(4, "2026-11-03 07:40:00", "I", "1"),
].sort((a, b) => a.check_time.localeCompare(b.check_time));

const departmentOf = (userId: number) => employees.find((e) => e.user_id === userId)?.department_id;

export class FixtureStore implements ZktimeStore {
  readonly mode = "fixture" as const;
  /** Department filter received by each call, for tests. */
  readonly calls: Array<{ method: string; departmentIds?: DepartmentIds }> = [];

  async departmentIdsByName(names: string[]): Promise<number[]> {
    return departments.filter((d) => names.includes(d.name)).map((d) => d.id);
  }

  async status(departmentIds: DepartmentIds): Promise<Status> {
    this.calls.push({ method: "status", departmentIds });
    return {
      mode: this.mode,
      sample: true,
      tables_missing: [],
      department_count: departments.filter((d) => inDepartments(departmentIds, d.id)).length,
      employee_count: employees.filter((e) => inDepartments(departmentIds, e.department_id)).length,
      device_count: devices.length,
    };
  }

  async inspect(): Promise<Schema> {
    return {
      tables: ["CHECKINOUT", "DEPARTMENTS", "Machines", "USERINFO"],
      columns: {
        USERINFO: ["USERID", "Badgenumber", "Name", "TITLE", "DEFAULTDEPTID", "HIREDDAY"],
        CHECKINOUT: ["USERID", "CHECKTIME", "CHECKTYPE", "SENSORID"],
        DEPARTMENTS: ["DEPTID", "DEPTNAME", "SUPDEPTID"],
        Machines: ["ID", "MachineAlias", "IP", "Port", "MachineNumber", "Enabled", "sn", "ProductType"],
      },
    };
  }

  async listDepartments(departmentIds: DepartmentIds): Promise<Department[]> {
    this.calls.push({ method: "listDepartments", departmentIds });
    return departments.filter((d) => inDepartments(departmentIds, d.id));
  }

  async listDevices(): Promise<Device[]> {
    this.calls.push({ method: "listDevices" });
    return devices;
  }

  async listEmployees(departmentIds: DepartmentIds, q: EmployeeQuery): Promise<Employee[]> {
    this.calls.push({ method: "listEmployees", departmentIds });
    return employees
      .filter((e) => inDepartments(departmentIds, e.department_id) && matchesQuery(q.query, e))
      .slice(0, q.limit);
  }

  async listPunches(departmentIds: DepartmentIds, q: PunchQuery): Promise<Punch[]> {
    this.calls.push({ method: "listPunches", departmentIds });
    return punches
      .filter(
        (p) =>
          inDepartments(departmentIds, departmentOf(p.user_id)) &&
          inDateRange(p.check_time, q.from, q.to) &&
          (!q.user_id || p.user_id === q.user_id) &&
          (!q.check_type || p.check_type === q.check_type),
      )
      .slice(0, q.limit);
  }
}
