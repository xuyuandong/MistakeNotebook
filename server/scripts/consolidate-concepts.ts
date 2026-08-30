import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { Subject, Subjects } from "@mistake-book/shared";
import { createChatClient } from "../src/ai/client.js";
import { loadConfig } from "../src/config/index.js";
import { createDb } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrator.js";
import { DEFAULT_USER_ID } from "../src/db/schema.js";
import {
  applyConsolidationProposal,
  flattenConsolidationProposals,
  proposeConsolidation,
} from "../src/services/consolidation.js";

function selectedSubjects(): (typeof Subjects)[number][] {
  const index = process.argv.indexOf("--subject");
  if (index < 0) return [...Subjects];
  const parsed = Subject.safeParse(process.argv[index + 1]);
  if (!parsed.success) throw new Error("--subject 只允许 chinese / math / english");
  return [parsed.data];
}

async function main() {
  const config = loadConfig();
  for (const warning of config.warnings) console.warn(warning);
  const dataDir = resolve(config.dataDir);
  mkdirSync(dataDir, { recursive: true });
  const { sqlite, db } = createDb(resolve(dataDir, "app.db"));
  runMigrations(sqlite, resolve(import.meta.dirname, "../migrations"));
  const chat = createChatClient(config);
  const rl = createInterface({ input, output });
  try {
    for (const subject of selectedSubjects()) {
      const proposals = flattenConsolidationProposals(
        await proposeConsolidation(db, chat, DEFAULT_USER_ID, subject),
      );
      if (!proposals.length) {
        console.log(`[${subject}] 没有整理建议`);
        continue;
      }
      console.log(`[${subject}] 共 ${proposals.length} 条建议,逐条确认:`);
      for (const proposal of proposals) {
        const text = proposal.kind === "assignment"
          ? `归类 ${proposal.conceptId} -> ${proposal.category}`
          : `归并 ${proposal.fromId} -> ${proposal.intoId}`;
        const answer = (await rl.question(`${text}; ${proposal.reason || "无补充理由"} [y/N] `))
          .trim()
          .toLowerCase();
        if (answer !== "y" && answer !== "yes") continue;
        applyConsolidationProposal(db, DEFAULT_USER_ID, subject, proposal);
        console.log("已应用");
      }
    }
  } finally {
    rl.close();
    sqlite.close();
  }
}

main().catch((error) => {
  console.error((error as Error).message);
  process.exitCode = 1;
});
