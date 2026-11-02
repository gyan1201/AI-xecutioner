import { paperclipSettings } from "./config.mjs";

/**
 * Paperclip bridge.
 *
 * Mirrors a company built here into a real Paperclip instance over its REST API,
 * so Paperclip stays the system of record for agents, tasks, budgets, approvals
 * and audit while NVIDIA NIM provides the inference.
 *
 * Contracts implemented (verified against paperclipai/paperclip source):
 *   GET  /api/companies                          list
 *   POST /api/companies                          { name, description, budgetMonthlyCents }
 *   GET  /api/companies/:companyId/agents        list
 *   POST /api/companies/:companyId/agents        createAgentSchema
 *   GET  /api/companies/:companyId/goals         list
 *   POST /api/companies/:companyId/goals         createGoalSchema
 *   POST /api/companies/:companyId/issues        createIssueSchema
 *   POST /api/issues/:id/comments                addIssueCommentSchema
 * Auth: `Authorization: Bearer <token>`; agent-authenticated mutations also send
 * `X-Paperclip-Run-Id`.
 */

export class PaperclipError extends Error {
  constructor(message, { status = 502, hint = "", body } = {}) {
    super(message);
    this.name = "PaperclipError";
    this.status = status;
    this.hint = hint;
    this.body = body;
  }
}

const STATUS_MAP = {
  backlog: "backlog",
  todo: "todo",
  in_progress: "in_progress",
  in_review: "in_review",
  done: "done",
  blocked: "blocked",
  cancelled: "cancelled",
};

function hintFor(status, path) {
  if (status === 401 || status === 403) {
    return "Paperclip rejected the credential. Create a board token in Paperclip (Settings → Access) or use `paperclipai auth` and paste the bearer token here.";
  }
  if (status === 404) {
    return `Paperclip has no route ${path}. Check the base URL includes /api — it should look like http://localhost:3100/api.`;
  }
  if (status === 400 || status === 422) {
    return "Paperclip rejected the payload. Its validator is stricter than this app's; check the required fields for that resource.";
  }
  return "";
}

export function createPaperclipClient({ config, fetchImpl } = {}) {
  const call = fetchImpl ?? fetch;
  const readSettings =
    config?.read ?? (() => (config?.load ? { paperclip: paperclipSettings() } : {}));
  const loadConfig = config?.load ?? (() => ({}));

  function settings() {
    const value = readSettings();
    const paperclip = value?.paperclip ?? {};
    const env = paperclipSettings();
    return {
      baseUrl: String(paperclip.baseUrl || env.baseUrl || "").replace(/\/+$/, ""),
      token: String(paperclip.token || env.token || ""),
      runId: String(paperclip.runId || process.env.PAPERCLIP_RUN_ID || ""),
    };
  }

  async function request(path, { method = "GET", body, token, baseUrl, runId } = {}) {
    const current = settings();
    const url = `${(baseUrl ?? current.baseUrl).replace(/\/+$/, "")}${path}`;
    const authToken = token ?? current.token;
    const headers = { Accept: "application/json" };
    if (authToken) headers.Authorization = `Bearer ${authToken}`;
    if (body) headers["Content-Type"] = "application/json";
    const id = runId ?? current.runId;
    if (id) headers["X-Paperclip-Run-Id"] = id;
    let response;
    try {
      response = await call(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(Number(loadConfig()?.requestTimeoutMs) || 30_000),
      });
    } catch (error) {
      throw new PaperclipError(`Could not reach Paperclip at ${url}: ${error?.message ?? error}`, {
        status: 502,
        hint: "Check the Paperclip server is running and the base URL includes /api.",
      });
    }
    const text = await response.text().catch(() => "");
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = { raw: text.slice(0, 1000) };
    }
    if (!response.ok) {
      throw new PaperclipError(payload?.error || `Paperclip responded ${response.status} for ${path}`, {
        status: response.status,
        hint: hintFor(response.status, path),
        body: payload,
      });
    }
    return payload;
  }

  return {
    hasCredentials() {
      const current = settings();
      return Boolean(current.baseUrl && current.token);
    },

    settings,

    async probe({ baseUrl, token } = {}) {
      const startedAt = Date.now();
      const companies = await request("/companies", { baseUrl, token });
      return {
        ok: true,
        latencyMs: Date.now() - startedAt,
        companies: Array.isArray(companies) ? companies.length : Array.isArray(companies?.companies) ? companies.companies.length : 0,
        sample: (Array.isArray(companies) ? companies : companies?.companies ?? []).slice(0, 5).map((entry) => ({
          id: entry.id,
          name: entry.name,
          issuePrefix: entry.issuePrefix ?? null,
        })),
      };
    },

    async listCompanies(options = {}) {
      const result = await request("/companies", options);
      return Array.isArray(result) ? result : result?.companies ?? [];
    },

    /**
     * Build the exact API call plan for one company without sending anything.
     * Used by dry runs, the UI preview and tests.
     */
    planMirror(company, { existingCompanyId = null } = {}) {
      const plan = [];
      if (!existingCompanyId) {
        plan.push({
          step: "create-company",
          method: "POST",
          path: "/companies",
          body: {
            name: company.name,
            description: company.mission || company.description || "",
            budgetMonthlyCents: company.budgetMonthlyCents || 0,
          },
        });
      }
      const companyRef = existingCompanyId ? `/companies/${existingCompanyId}` : "/companies/:companyId";
      for (const agent of company.agents) {
        plan.push({
          step: `hire-${agent.role}`,
          method: "POST",
          path: `${companyRef}/agents`,
          body: {
            name: agent.name,
            role: agent.role,
            title: agent.title,
            adapterType: "opencode_local",
            capabilities: (agent.capabilities ?? []).join(", ") || null,
            budgetMonthlyCents: agent.budgetMonthlyCents ?? 0,
            adapterConfig: agent.model ? { model: agent.model } : {},
            runtimeConfig: {},
            metadata: {
              source: "nvidia-autopilot",
              nimModel: agent.model,
              nimBaseUrl: loadConfig()?.nimBaseUrl ?? null,
              department: company.departments.find((department) => department.id === agent.departmentId)?.name ?? null,
              skills: agent.skills ?? [],
            },
          },
        });
      }
      for (const goal of company.goals) {
        plan.push({
          step: "goal",
          method: "POST",
          path: `${companyRef}/goals`,
          body: {
            title: goal.title,
            description: goal.description ?? "",
            level: goal.level === "team" ? "team" : "company",
            status: goal.status === "achieved" ? "achieved" : goal.status === "cancelled" ? "cancelled" : "active",
          },
        });
      }
      for (const issue of company.issues) {
        plan.push({
          step: "issue",
          method: "POST",
          path: `${companyRef}/issues`,
          body: {
            title: issue.title,
            description: [
              issue.description,
              issue.acceptanceCriteria?.length
                ? `\n\n**Acceptance criteria**\n${issue.acceptanceCriteria.map((item) => `- ${item}`).join("\n")}`
                : "",
              `\n\n_Imported from NVIDIA Autopilot as ${issue.key}_`,
            ].join(""),
            status: STATUS_MAP[issue.status] ?? "todo",
            priority: issue.priority,
            acceptanceCriteria: issue.acceptanceCriteria ?? [],
          },
        });
      }
      return plan;
    },

    /**
     * Execute a mirror. In dry-run mode nothing is sent and the plan is returned.
     * Idempotency is the caller's responsibility: mirror into a fresh or
     * explicitly chosen Paperclip company.
     */
    async mirror(company, { dryRun = true, existingCompanyId = null, baseUrl, token } = {}) {
      const plan = this.planMirror(company, { existingCompanyId });
      if (dryRun) {
        return { dryRun: true, calls: plan.length, plan, created: null };
      }
      if (!this.hasCredentials() && !(baseUrl && token)) {
        throw new PaperclipError("Paperclip is not configured.", {
          status: 400,
          hint: "Set the Paperclip API base URL and board token in the company's Paperclip bridge panel.",
        });
      }
      const created = { companyId: existingCompanyId, agents: [], goals: [], issues: [] };
      for (const step of plan) {
        if (step.step === "create-company") {
          const result = await request("/companies", { method: "POST", body: step.body, baseUrl, token });
          created.companyId = result?.id ?? result?.company?.id ?? null;
          if (!created.companyId) {
            throw new PaperclipError("Paperclip created the company but returned no id.", { body: result });
          }
          continue;
        }
        const resolved = step.path.replace("/companies/:companyId", `/companies/${created.companyId}`);
        const result = await request(resolved, { method: step.method, body: step.body, baseUrl, token });
        if (step.step.startsWith("hire-")) created.agents.push({ role: step.body.role, id: result?.id ?? result?.agent?.id ?? null });
        else if (step.step === "goal") created.goals.push({ title: step.body.title, id: result?.id ?? result?.goal?.id ?? null });
        else if (step.step === "issue") created.issues.push({ title: step.body.title, id: result?.id ?? result?.issue?.id ?? null });
      }
      return { dryRun: false, calls: plan.length, created };
    },

    /** Pull Paperclip's view of a company so the UI can show both sides. */
    async snapshot({ companyId, baseUrl, token } = {}) {
      if (!companyId) throw new PaperclipError("companyId is required to read a Paperclip company.");
      const [company, agents, goals, issues] = await Promise.all([
        request(`/companies/${companyId}`, { baseUrl, token }).catch(() => null),
        request(`/companies/${companyId}/agents`, { baseUrl, token }).catch(() => []),
        request(`/companies/${companyId}/goals`, { baseUrl, token }).catch(() => []),
        request(`/companies/${companyId}/issues`, { baseUrl, token }).catch(() => []),
      ]);
      const asArray = (value) => (Array.isArray(value) ? value : value?.items ?? value?.issues ?? value?.agents ?? []);
      return {
        company,
        agents: asArray(agents).length,
        goals: asArray(goals).length,
        issues: asArray(issues).length,
      };
    },
  };
}
