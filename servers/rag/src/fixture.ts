import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { RagCorpus } from "./corpus.js";

/**
 * Synthetic documents only: invented procedures, no real organisation, person, place or budget.
 * Each file carries a unique code word (e.g. ALPHA-7731) so tests can tell exactly what a member saw.
 * Folder pairs that differ only by a LIKE wildcard ("ops_team"/"opsXteam", "50%"/"50-percent"), by case
 * ("hr"/"HR") or by a prefix boundary ("hr"/"hr-old") prove a folder scope cannot spill into a neighbour.
 */
export const FIXTURE_DOCS: Record<string, string> = {
  "คู่มือไอที/การสำรองข้อมูล.md": `# ขั้นตอนการสำรองข้อมูล (ตัวอย่าง)

รหัสเอกสาร ALPHA-7731 — เอกสารสมมติสำหรับทดสอบเท่านั้น
สำรองข้อมูลเครื่องแม่ข่ายทุกคืนเวลา 02:00 และตรวจผลทุกเช้า
เก็บสำเนาไว้นอกสถานที่อย่างน้อยหนึ่งชุด

ข้อความที่ตัวสกัด PDF แยกสระลอย: หมวดครุภณั ฑ์ คอมพิวเตอร์
`,
  "คู่มือไอที/network/wifi-setup.txt": `Wi-Fi setup for the sample office (document ALPHA-7732, synthetic).
Connect to the guest network, then register the device with the help desk.
`,
  "hr/leave-policy.md": `# Leave policy (sample)

Document BRAVO-4410. Synthetic text for tests.
การลาพักร้อนต้องแจ้งล่วงหน้าอย่างน้อยเจ็ดวัน
Annual leave requests go to the line manager.
`,
  "HR/archive.md": "Archived notes GOLF-5501 (synthetic). Upper-case folder; must not match the 'hr' scope.\n",
  "hr-old/memo.md": "Old memo HOTEL-6601 (synthetic). Shares the 'hr' prefix but is another folder.\n",
  "ops_team/runbook.md": "Runbook CHARLIE-1101 (synthetic): restart the queue worker, then check the dashboard.\n",
  "opsXteam/notes.md": "Notes DELTA-2201 (synthetic). '_' in a LIKE pattern would match this folder.\n",
  "50%/plan.md": "Plan ECHO-3301 (synthetic). Folder name contains a percent sign.\n",
  "50-percent/plan.md": "Plan FOXTROT-4401 (synthetic). '%' in a LIKE pattern would match this folder.\n",
};

export function writeFixtureDocs(dir: string): void {
  for (const [rel, text] of Object.entries(FIXTURE_DOCS)) {
    const path = join(dir, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text, "utf8");
  }
}

let counter = 0;

/** A corpus over the synthetic documents, written to a temporary directory on first use, indexed in memory. */
export function fixtureCorpus(): RagCorpus {
  const docsDir = join(tmpdir(), `mcp-depot-rag-fixture-${process.pid}-${(counter += 1)}`);
  return new RagCorpus({
    mode: "fixture",
    docsDir,
    indexPath: ":memory:",
    prepare: () => {
      writeFixtureDocs(docsDir);
      process.once("exit", () => rmSync(docsDir, { recursive: true, force: true }));
    },
  });
}
