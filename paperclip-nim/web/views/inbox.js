import { api, esc, icon, toast, ago } from "../lib.js";
import { pageHeader } from "./shared.js";

export const title = "Inbox";

const KIND_META = {
  approval: { label: "Approval", pill: "red", icon: "approvals" },
  blocked: { label: "Blocked", pill: "amber", icon: "shield" },
  run_failed: { label: "Run failed", pill: "red", icon: "terminal" },
  over_budget: { label: "Over budget", pill: "amber", icon: "budget" },
};

export async function render(root, ctx) {
  const inbox = await api(`/api/companies/${ctx.companyId}/inbox`);

  root.innerHTML = `
    ${pageHeader({
      eyebrow: "Work",
      title: "Inbox",
      subtitle: `${inbox.counts.total} items need a human · ${inbox.counts.pending} approvals · ${inbox.counts.blocked} blocked`,
      actions: `<button class="btn ghost" data-action="refresh">${icon("activity", "nav-icon")} Refresh</button>`,
    })}

    ${
      inbox.items.length
        ? `<div class="stack">${inbox.items
            .map((item) => {
              const meta = KIND_META[item.kind] ?? { label: item.kind, pill: "", icon: "inbox" };
              return `<div class="card" style="display:flex;gap:12px;align-items:flex-start">
                <span class="pill ${meta.pill}">${icon(meta.icon, "nav-icon")}${esc(meta.label)}</span>
                <div class="grow" style="min-width:0">
                  <div style="font-size:13px;font-weight:550">${esc(item.title)}</div>
                  <div class="hint" style="margin-top:3px">${esc(item.detail)}</div>
                  <div class="row" style="gap:8px;margin-top:8px">
                    ${item.issueKey ? `<a class="tag" href="#/issues/${esc(item.issueId)}">${esc(item.issueKey)}</a>` : ""}
                    <span class="hint">${ago(item.at)}</span>
                  </div>
                </div>
                <div class="row" style="gap:6px">
                  ${
                    item.kind === "approval"
                      ? `<button class="btn sm primary" data-approve="${esc(item.approvalId)}">Approve</button>
                         <button class="btn sm danger" data-deny="${esc(item.approvalId)}">Deny</button>`
                      : item.issueId
                        ? `<a class="btn sm ghost" href="#/issues/${esc(item.issueId)}">Open</a>`
                        : item.agentId
                          ? `<a class="btn sm ghost" href="#/agents/${esc(item.agentId)}">Open</a>`
                          : ""
                  }
                </div>
              </div>`;
            })
            .join("")}</div>`
        : `<div class="empty"><h3>Inbox zero</h3><p>Nothing needs a human. Agents are either working or waiting on the next cycle.</p><button class="btn" data-action="cycle" style="margin-top:10px">Run a cycle</button></div>`
    }
  `;

  const decide = async (approvalId, decision) => {
    try {
      await api(`/api/companies/${ctx.companyId}/approvals/${approvalId}/decide`, { method: "POST", body: { decision, by: "you" } });
      toast(decision === "approve" ? "Approved" : "Denied");
      await ctx.refresh(true);
      render(root, ctx);
    } catch (error) {
      toast(error.message, "error");
    }
  };
  root.querySelectorAll("[data-approve]").forEach((button) => button.addEventListener("click", () => decide(button.dataset.approve, "approve")));
  root.querySelectorAll("[data-deny]").forEach((button) => button.addEventListener("click", () => decide(button.dataset.deny, "deny")));
  root.querySelector('[data-action="refresh"]')?.addEventListener("click", () => render(root, ctx));
  root.querySelector('[data-action="cycle"]')?.addEventListener("click", () => ctx.runCycle?.());
}
