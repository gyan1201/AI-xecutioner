import { api, ago, avatar, esc, icon, toast } from "../lib.js";
import { pageHeader } from "./shared.js";

export const title = "Approvals";

export async function render(root, ctx) {
  const { approvals } = await api(`/api/companies/${ctx.companyId}/approvals`);
  const pending = approvals.filter((approval) => approval.status === "pending");
  const decided = approvals.filter((approval) => approval.status !== "pending");
  const company = ctx.company;

  root.innerHTML = `
    ${pageHeader({
      eyebrow: "Team",
      title: "Approvals",
      subtitle:
        company.settings.approvalPolicy === "off"
          ? "Approval policy is off — agents act without a human gate. Turn it on in Settings."
          : `Policy: ${company.settings.approvalPolicy} · ${pending.length} waiting`,
      actions: `<button class="btn ghost" data-action="settings">${icon("settings", "nav-icon")} Policy</button>`,
    })}

    <div class="section-title">Waiting on you</div>
    <div class="stack">
      ${
        pending.length
          ? pending
              .map(
                (approval) => `<div class="card" style="border-color:rgba(255,123,114,.28)">
                  <div class="row-between" style="align-items:flex-start;gap:12px;flex-wrap:wrap">
                    <div class="grow" style="min-width:260px">
                      <div class="row" style="gap:8px;margin-bottom:5px">
                        <span class="pill red"><span class="dot"></span>${esc(approval.risk)} risk</span>
                        ${approval.issue ? `<a class="pill" href="#/issues/${esc(approval.issue.id)}">${esc(approval.issue.key)}</a>` : ""}
                        <span class="hint">${ago(approval.createdAt)}</span>
                      </div>
                      <div style="font-size:13.5px;font-weight:550">${esc(approval.action)}</div>
                      <div class="hint" style="margin-top:4px">${esc(approval.reason)}</div>
                      <div class="row" style="gap:6px;margin-top:8px">
                        ${avatar(company.agents.find((agent) => agent.id === approval.requestedBy) ?? { name: "system" }, "sm")}
                        <span class="hint">requested by ${esc(company.agents.find((agent) => agent.id === approval.requestedBy)?.name ?? "system")}</span>
                      </div>
                    </div>
                    <div class="row" style="gap:6px">
                      <button class="btn primary sm" data-approve="${esc(approval.id)}">Approve</button>
                      <button class="btn danger sm" data-deny="${esc(approval.id)}">Deny</button>
                    </div>
                  </div>
                </div>`,
              )
              .join("")
          : `<div class="card"><div class="hint">Nothing pending. Risky actions will park here for a decision.</div></div>`
      }
    </div>

    <div class="section-title">History</div>
    <div class="card pad-0" style="overflow:hidden">
      <table class="table">
        <thead><tr><th>Action</th><th>Issue</th><th>Risk</th><th>Decision</th><th>By</th><th>When</th></tr></thead>
        <tbody>
          ${
            decided
              .map(
                (approval) => `<tr>
                  <td class="title-cell">${esc(approval.action)}<div class="sub">${esc(approval.note || approval.reason)}</div></td>
                  <td>${approval.issue ? `<a class="tag" href="#/issues/${esc(approval.issue.id)}">${esc(approval.issue.key)}</a>` : `<span class="dim">—</span>`}</td>
                  <td><span class="pill ${approval.status === "approved" ? "green" : "red"}">${esc(approval.status)}</span></td>
                  <td class="dim">${esc(approval.risk)}</td>
                  <td class="dim">${esc(approval.decidedBy ?? "—")}</td>
                  <td class="dim nowrap">${approval.decidedAt ? ago(approval.decidedAt) : "—"}</td>
                </tr>`,
              )
              .join("") || `<tr><td class="hint">No decisions yet.</td></tr>`
          }
        </tbody>
      </table>
    </div>
  `;

  const decide = async (id, decision) => {
    try {
      await api(`/api/companies/${ctx.companyId}/approvals/${id}/decide`, { method: "POST", body: { decision, by: "you" } });
      toast(decision === "approve" ? "Approved — issue released" : "Denied");
      await ctx.refresh(true);
      render(root, ctx);
    } catch (error) {
      toast(error.message, "error");
    }
  };
  root.querySelectorAll("[data-approve]").forEach((button) => button.addEventListener("click", () => decide(button.dataset.approve, "approve")));
  root.querySelectorAll("[data-deny]").forEach((button) => button.addEventListener("click", () => decide(button.dataset.deny, "deny")));
  root.querySelector('[data-action="settings"]').addEventListener("click", () => ctx.navigate("/settings"));
}
