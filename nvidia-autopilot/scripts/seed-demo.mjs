/**
 * Seeds a demo company so the UI has real content on first run.
 *
 *   node scripts/seed-demo.mjs            # against http://localhost:8787
 *   BASE=http://host:port node scripts/seed-demo.mjs
 *
 * Safe to re-run: it adds documents and a fresh run each time.
 */

const BASE = process.env.BASE ?? `http://localhost:${process.env.PORT ?? 8787}`;

const DOCUMENTS = [
  {
    title: "Northwind Labs — Q3 strategy memo",
    text: `Northwind Labs sells a B2B SaaS planning tool at $49 per seat per month.
Q3 priority: self-serve onboarding. Today every new account needs a manual call, which caps growth at 40 accounts per month.
Self-serve activation target: 20% quarter-over-quarter growth in accounts that reach the "first plan published" milestone within 7 days.
Free trial is 14 days, no credit card. Trial-to-paid conversion is currently 11%; the target is 15%.
Biggest drop-off: step 3 of the setup wizard (connecting a data source) — 46% abandon there.
Engineering has 2 weeks of capacity in Q3 for onboarding work; no additional headcount is approved.
Paid acquisition is paused this quarter. Growth must come from activation and referral.`,
  },
  {
    title: "Pricing and packaging policy",
    text: `Pricing stays at $49 per seat per month for the Growth tier through Q3. No discounting without finance approval.
Annual plans get 2 months free. Enterprise tier requires a security review and is sold by the founder.
Any experimental pricing test must run for at least 4 weeks and be approved by finance before launch.
Refunds are handled by support; anything above $500 needs finance sign-off.`,
  },
  {
    title: "Customer research — onboarding interviews (n=12)",
    text: `Recurring themes from 12 onboarding interviews:
1. Users do not understand what "publish a plan" unlocks; they treat the trial as a note-taking app.
2. Data-source connection fails silently for spreadsheets with more than 3 tabs.
3. Buyers want a template gallery before they are asked to invite teammates.
4. Three of twelve asked for a Slack integration during week one.
5. The strongest activation predictor is publishing a plan within the first 48 hours (78% of those accounts convert).`,
  },
];

const GOAL =
  "Make self-serve onboarding reach 20% quarter-over-quarter activation growth by shipping a guided first-plan flow, fixing spreadsheet ingestion, and launching a template gallery — without new headcount or paid acquisition.";

const CONTEXT =
  "B2B SaaS at $49/seat. 2 weeks of engineering capacity. No paid acquisition. Finance must approve any pricing change. Founder is the only enterprise seller.";

async function call(path, { method = "GET", body } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(`${method} ${path} → ${response.status}: ${payload.error ?? text.slice(0, 200)}`);
  return payload;
}

async function main() {
  console.log(`Seeding ${BASE}…`);
  const before = await call("/api/knowledge");
  for (const document of DOCUMENTS) {
    if ((before.documentsList ?? []).some((entry) => entry.title === document.title)) continue;
    await call("/api/knowledge", { method: "POST", body: document });
    console.log(`  + document: ${document.title}`);
  }
  const indexed = await call("/api/knowledge/index", { method: "POST" });
  console.log(`  · indexed ${indexed.chunks} chunks`);

  const { run } = await call("/api/autopilot", {
    method: "POST",
    body: {
      goal: GOAL,
      company: "Northwind Labs",
      companyContext: CONTEXT,
      options: { maxSteps: 5, requireApproval: "never", concurrency: 2 },
    },
  });
  console.log(`  → run ${run.id} started`);

  for (let attempt = 0; attempt < 240; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const detail = await call(`/api/autopilot/${run.id}`);
    const status = detail.run.status;
    if (detail.run.status === "awaiting_approval") {
      await call(`/api/autopilot/${run.id}/approve`, { method: "POST", body: { approved: true } });
      continue;
    }
    if (["completed", "completed_with_issues", "failed", "blocked", "cancelled"].includes(status)) {
      console.log(
        `  ✓ ${status} · ${detail.run.tasks.filter((task) => task.status === "done").length}/${detail.run.tasks.length} work items · ${detail.run.usage.totalTokens} tokens · ${detail.artifacts.length} artifacts`,
      );
      console.log(`\nOpen ${BASE}/#/autopilot/${run.id}`);
      return;
    }
  }
  throw new Error("Timed out waiting for the demo run to finish.");
}

main().catch((error) => {
  console.error(`Seed failed: ${error.message}`);
  process.exitCode = 1;
});
