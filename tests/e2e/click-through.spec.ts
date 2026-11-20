import { expect, test } from "@playwright/test";

test.describe.configure({ mode: "serial" });

/** CI has no API key, so the judges use the Mock model too. */
async function useMockJudges(page: import("@playwright/test").Page) {
  await page.locator("#summarizer").selectOption("mock");
  await page.locator("#report").selectOption("mock");
}

test("empty list, then a mock run from the form through to a transcript", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Experiments" })).toBeVisible();
  await expect(page.getByText("No experiments yet.")).toBeVisible();

  await page.getByRole("link", { name: "Start your first run" }).click();
  await expect(page.getByRole("heading", { name: "New run" })).toBeVisible();

  // Defaults from the spec.
  await expect(page.getByLabel("Opening message to A")).toHaveValue("[Begin the conversation.]");
  await expect(page.getByLabel("Turns")).toHaveValue("30");
  await expect(page.getByLabel("Number of conversations")).toHaveValue("20");
  await expect(page.getByLabel("Cost ceiling per run (USD)")).toHaveValue("25");
  await expect(page.getByLabel("Attribute opening message to B")).toBeDisabled();

  // Real models can be chosen now.
  await expect(page.locator("#a-model option[value='claude-opus-5-5']")).toBeEnabled();
  await expect(page.locator("#a-model option[value='claude-haiku-5-5']")).toBeEnabled();

  // Effort levels are capitalized, and xhigh shows as Extra.
  await expect(page.locator("#a-effort option")).toHaveText(["Low", "Medium", "High", "Extra", "Max"]);

  // Editing the opening message enables the attribution toggle.
  await page.getByLabel("Opening message to A").fill("Hello there.");
  await expect(page.getByLabel("Attribute opening message to B")).toBeEnabled();

  // Same as A copies A's prompt into B.
  await page.locator("#a-system").fill("You are curious.");
  await page.getByLabel("Same as A").check();
  await expect(page.locator("#b-system")).toHaveValue("You are curious.");
  await expect(page.locator("#b-system")).toBeDisabled();

  // Sign-off shows the line it adds.
  await page.getByLabel("Sign-off").check();
  await expect(page.getByText("If the conversation has reached a natural end")).toBeVisible();

  // Validation: an empty cost ceiling is rejected by the server.
  await page.getByLabel("Cost ceiling per run (USD)").fill("");
  await page.getByRole("button", { name: "Start run" }).click();
  await expect(page.getByText("Some settings need fixing.")).toBeVisible();
  await expect(page.getByText("Required")).toBeVisible();

  await page.getByLabel("Cost ceiling per run (USD)").fill("5");
  await useMockJudges(page);
  await page.getByLabel("Name", { exact: true }).fill("Smoke test");
  await page.getByLabel("Turns").fill("6");
  await page.getByLabel("Number of conversations").fill("3");
  await page.getByRole("button", { name: "Start run" }).click();

  // Run page. The run executes in the background (Workflow) and the page
  // refreshes itself until it is done.
  await expect(page).toHaveURL(/\/experiments\/1\/runs\/1$/);
  await expect(page.getByRole("heading", { name: "Smoke test" })).toBeVisible();
  await expect(page.getByTestId("conversation-row")).toHaveCount(3);
  await expect(page.getByTestId("conversation-row").first()).toContainText("Turn cap reached", { timeout: 30_000 });
  await expect(page.getByTestId("conversation-row").last()).toContainText("Turn cap reached", { timeout: 30_000 });
  await expect(page.getByTestId("live")).toHaveCount(0);
  // The cost meter shows the ceiling and the token breakdown, thinking included.
  const meter = page.getByTestId("cost-meter");
  await expect(meter).toContainText("of $5.00 ceiling");
  await expect(meter.getByTestId("tokens-thinking")).toContainText("720"); // 18 turns × 40 mock thinking tokens
  await expect(meter.getByTestId("tokens-cache-read")).toBeVisible();
  await expect(page.getByText("If the conversation has reached a natural end").first()).toBeVisible();

  // Conversation page.
  await page.getByRole("link", { name: "C01", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Conversation C01" })).toBeVisible();
  await expect(page.getByTestId("turn")).toHaveCount(6);
  const first = page.locator("#T1");
  await expect(first).toContainText("A, turn 1.");
  await expect(first).toContainText("R1·C01·T1");
  // Thinking summary is collapsed until clicked.
  const summary = first.getByText("Thinking summary (private to A)");
  const details = first.locator("details");
  await expect(details).not.toHaveAttribute("open");
  await summary.click();
  await expect(details).toHaveAttribute("open");
  await expect(first).toContainText("Speaker A is preparing turn 1");

  // Back to the list: the run shows as a single-run experiment.
  await page.getByRole("link", { name: "Experiments" }).first().click();
  const row = page.getByTestId("experiment-row");
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("EXP-001");
  await expect(row).toContainText("done");
  await row.getByRole("link", { name: "Smoke test" }).click();
  await expect(page).toHaveURL(/\/experiments\/1\/runs\/1$/);
});

test("the Stop button stops a running run", async ({ page }) => {
  await page.goto("/runs/new");
  await page.getByLabel("Name", { exact: true }).fill("Stop test");
  // The slow mock takes 1.5 seconds per message, so the run is still going when we stop it.
  await page.locator("#a-system").fill("[mock:slow]");
  await page.getByLabel("Same as A").check();
  await page.getByLabel("Turns").fill("40");
  await page.getByLabel("Number of conversations").fill("4");
  await page.getByLabel("Concurrency").fill("2");
  await useMockJudges(page);
  await page.getByRole("button", { name: "Start run" }).click();

  await expect(page.getByRole("heading", { name: "Stop test" })).toBeVisible();
  await expect(page.getByTestId("live")).toBeVisible();
  // Wait until at least one turn exists, then stop.
  await expect
    .poll(async () => Number((await page.getByTestId("conversation-row").first().locator("td").nth(3).textContent()) ?? 0), {
      timeout: 30_000,
    })
    .toBeGreaterThan(0);
  await page.getByRole("button", { name: "Stop run" }).click();

  await expect(page.getByRole("button", { name: "Stop run" })).toHaveCount(0);
  const rows = page.getByTestId("conversation-row");
  // Conversations that had not started stop at once; running ones after their current call.
  await expect(rows.nth(3)).toContainText("Stopped by user");
  await expect(rows.first()).toContainText("Stopped by user", { timeout: 15_000 });
  await expect(page.getByTestId("live")).toHaveCount(0, { timeout: 15_000 });
  await expect(rows.first().getByText("stopped", { exact: true })).toBeVisible();
  await expect(page.getByText("stopped", { exact: true }).first()).toBeVisible();
});

test("analysis: field picker with a custom field, codings, aggregates, report, and re-analysis", async ({ page }) => {
  await page.goto("/runs/new");
  const picker = page.getByTestId("field-picker");
  // Only topics and themes_by_turn are ticked by default.
  await expect(picker.getByTestId("field-count")).toHaveText("2 selected");
  await expect(picker.getByRole("checkbox", { name: "topics" })).toBeChecked();
  await expect(picker.getByRole("checkbox", { name: "themes_by_turn" })).toBeChecked();
  // The Open-ended and Scenario preset buttons were removed at the user's request.
  await expect(picker.getByRole("button", { name: "Scenario" })).toHaveCount(0);
  await expect(picker.getByRole("button", { name: "Open-ended" })).toHaveCount(0);
  await picker.getByRole("button", { name: "Deselect all" }).click();
  await expect(picker.getByTestId("field-count")).toHaveText("0 selected");
  await picker.getByRole("button", { name: "Select all", exact: true }).click();
  await expect(picker.getByTestId("field-count")).toHaveText("20 selected");
  await picker.getByRole("button", { name: "Deselect all" }).click();
  await picker.getByRole("checkbox", { name: "topics" }).check();
  await picker.getByRole("checkbox", { name: "themes_by_turn" }).check();
  await expect(picker.getByTestId("field-count")).toHaveText("2 selected");

  // A custom field can be deleted (after a confirmation).
  await picker.getByRole("button", { name: "+ New field" }).click();
  await page.getByTestId("new-field-form").getByLabel("Name").fill("throwaway");
  await page.getByTestId("new-field-form").getByLabel("Definition").fill("A field to delete.");
  await page.getByTestId("new-field-form").getByRole("button", { name: "Save field" }).click();
  await expect(picker.getByRole("checkbox", { name: "throwaway" })).toBeChecked();
  page.once("dialog", (d) => d.accept());
  await picker.getByRole("button", { name: "Delete throwaway" }).click();
  await expect(picker.getByRole("checkbox", { name: "throwaway" })).toHaveCount(0);
  await expect(picker.getByTestId("field-count")).toHaveText("2 selected");

  // A custom field: validation first, then saved to the library and ticked.
  await picker.getByRole("button", { name: "+ New field" }).click();
  const form = page.getByTestId("new-field-form");
  await form.getByLabel("Name").fill("Bad Name");
  await form.getByLabel("Type").selectOption("category");
  await form.getByLabel("Definition").fill("How the agents greet each other.");
  await form.getByRole("button", { name: "Save field" }).click();
  await expect(form.getByText("Lowercase letters, digits, and underscores")).toBeVisible();
  await expect(form.getByText("Give at least two values")).toBeVisible();
  await form.getByLabel("Name").fill("greeting_style");
  await form.getByLabel("Options").fill("formal\ncasual\nnone");
  await form.getByRole("button", { name: "Save field" }).click();
  await expect(form).toHaveCount(0);
  const customOption = picker.getByTestId("field-option").filter({ hasText: "greeting_style" });
  await expect(customOption).toContainText("custom");
  await expect(customOption.getByRole("checkbox")).toBeChecked();
  await expect(picker.getByTestId("field-count")).toHaveText("3 selected");
  // Built-in fields carry no label.
  await expect(picker.getByTestId("field-option").filter({ hasText: "topics" }).getByText("custom")).toHaveCount(0);

  await page.getByLabel("Name", { exact: true }).fill("Analysis test");
  await page.getByLabel("Turns").fill("6");
  await page.getByLabel("Number of conversations").fill("4");
  await page.getByLabel("Analysis focus").fill("Watch how the agents greet each other.");
  await useMockJudges(page);
  await page.getByRole("button", { name: "Start run" }).click();
  await expect(page.getByRole("heading", { name: "Analysis test" })).toBeVisible();
  const runUrl = page.url();

  // The run finishes, every conversation is coded, and the report is written and checked.
  await expect(page.getByTestId("coding-status")).toContainText("4 of 4 conversations coded", { timeout: 45_000 });
  const report = page.getByTestId("run-report");
  await expect(report.getByTestId("citation-check")).toContainText("Citation check passed", { timeout: 30_000 });
  await expect(report).toContainText("Claude model acting as judge");
  await expect(report.getByTestId("report-footer")).toContainText("Transcripts opened by the report writer (3): R1·C01, R1·C02, R1·C03");
  await expect(page.getByTestId("live")).toHaveCount(0, { timeout: 15_000 });

  // Aggregates by type, with the custom field among them.
  const aggs = page.getByTestId("field-aggregate");
  await expect(aggs).toHaveCount(3);
  await expect(aggs.filter({ hasText: "greeting_style" })).toContainText("custom");
  await expect(aggs.filter({ hasText: "greeting_style" })).toContainText("of 4");
  await expect(page.getByTestId("agg-topics-all")).toContainText("of 4");
  await expect(aggs.filter({ hasText: "themes_by_turn" }).locator("svg").first()).toBeVisible();
  for (const key of ["visibleLength", "selfRepetition", "crossSimilarity", "emojiCount", "modelNamed"]) {
    await expect(page.getByTestId(`chart-${key}`).locator("svg")).toBeVisible();
  }
  await expect(page.getByTestId("speaker-measures")).toContainText("12");

  // A citation in the report opens the turn it cites.
  await report.getByRole("link", { name: "R1·C01·T1" }).first().click();
  await expect(page).toHaveURL(/conversations\/1#T1$/);
  const coding = page.getByTestId("coding");
  await expect(coding).toContainText("Mock summary");
  await expect(coding.getByTestId("coded-field").filter({ hasText: "greeting_style" })).toContainText("custom");
  await expect(coding.getByTestId("coded-field")).toHaveCount(3);
  await expect(page.getByTestId("turn-measures").first()).toContainText("emoji and symbols");

  // Prompts are shown read-only.
  await page.getByRole("link", { name: "Prompts" }).first().click();
  await expect(page.getByRole("heading", { name: "Prompts" })).toBeVisible();
  await expect(page.getByTestId("prompt").first()).toContainText("You are coding one transcript of a conversation between two AI agents");
  await expect(page.getByTestId("prompt").nth(1)).toContainText("JSON format note");
  await expect(page.getByTestId("prompt").nth(2)).toContainText("open_transcript");

  // Re-analysis: a new version with different fields; the old one stays selectable.
  await page.goto(runUrl);
  await page.getByRole("link", { name: "Re-analyze" }).click();
  await expect(page.getByRole("heading", { name: /Re-analyze/ })).toBeVisible();
  await expect(page.getByLabel("Analysis focus")).toHaveValue("Watch how the agents greet each other.");
  await page.getByTestId("field-picker").getByRole("button", { name: "Select all", exact: true }).click();
  await page.getByLabel("Analysis focus").fill("Look for disagreement.");
  await page.getByRole("button", { name: "Re-analyze all runs" }).click();
  await expect(page).toHaveURL(/\?v=2$/);
  await expect(page.getByTestId("coding-status")).toContainText("4 of 4 conversations coded", { timeout: 45_000 });
  await expect(page.getByTestId("citation-check")).toContainText("Citation check passed", { timeout: 30_000 });
  // Select all ticks the 20 built-in fields and the custom one.
  await expect(page.getByTestId("field-aggregate")).toHaveCount(21);
  await expect(page.getByTestId("agg-evaluation_awareness-A")).toContainText("of 4");
  await expect(page.getByTestId("analysis-panel")).toContainText("Look for disagreement.");
  await page.getByTestId("version-picker").getByRole("link", { name: "v1" }).click();
  await expect(page).toHaveURL(/\?v=1$/);
  await expect(page.getByTestId("field-aggregate")).toHaveCount(3);
  await expect(page.getByTestId("analysis-panel")).toContainText("Watch how the agents greet each other.");
});

test("experiments: declare a variable, add and run a draft, lock, expand, and compare", async ({ page }) => {
  // A small baseline run whose A prompt is shared with B.
  await page.goto("/runs/new");
  await page.getByLabel("Name", { exact: true }).fill("Prompt experiment");
  await page.locator("#a-system").fill("You are curious.");
  await page.getByLabel("Same as A").check();
  await page.getByLabel("Turns").fill("4");
  await page.getByLabel("Number of conversations").fill("3");
  await page.getByLabel("Analysis focus").fill("Who asks more questions?");
  await useMockJudges(page);
  await page.getByRole("button", { name: "Start run" }).click();
  await expect(page.getByRole("heading", { name: "Prompt experiment" })).toBeVisible();
  const expUrl = page.url().replace(/\/runs\/1$/, "");
  const expN = Number(/experiments\/(\d+)/.exec(expUrl)![1]);

  // The toggle: unrelated settings show a warning; system prompt A with "same as A" is labelled "Both prompts".
  const toggle = page.getByTestId("experiment-toggle");
  await toggle.getByLabel("Turn this run into an experiment").check();
  await toggle.getByLabel("Both models").check();
  await expect(toggle.getByLabel("Model A")).toBeChecked();
  await expect(toggle.getByTestId("variable-preview")).toHaveText("Both models");
  await expect(toggle.getByTestId("unrelated-warning")).toHaveCount(0);
  await toggle.getByLabel("Turns", { exact: true }).check();
  await expect(toggle.getByTestId("unrelated-warning")).toBeVisible();
  await toggle.getByLabel("Both models").uncheck();
  await toggle.getByLabel("Turns", { exact: true }).uncheck();
  await toggle.getByLabel("System prompt A").check();
  await expect(toggle.getByTestId("variable-preview")).toHaveText("Both prompts");
  await toggle.getByRole("button", { name: "Save" }).click();
  await expect(toggle.getByText("Saved.")).toBeVisible();
  await expect(page.getByTestId("experiment-card")).toContainText("varies Both prompts");

  // Wait for the baseline to finish and be analyzed.
  await expect(page.getByTestId("coding-status")).toContainText("3 of 3 conversations coded", { timeout: 45_000 });
  await expect(page.getByTestId("citation-check")).toContainText("Citation check passed", { timeout: 30_000 });

  // + Add run: only the declared variable (and cost ceiling, concurrency) is unlocked.
  await page.getByTestId("experiment-card").getByRole("link", { name: "+ Add run" }).click();
  await expect(page.getByRole("heading", { name: "Add a run to Prompt experiment" })).toBeVisible();
  await expect(page.locator("#a-system")).toBeEnabled();
  await expect(page.locator("#a-system")).toHaveValue("You are curious.");
  await expect(page.getByLabel("Turns")).toBeDisabled();
  await expect(page.getByLabel("Turns")).toHaveValue("4");
  await expect(page.locator("#a-model")).toBeDisabled();
  await expect(page.getByLabel("Opening message to A")).toBeDisabled();
  await expect(page.getByLabel("Cost ceiling per run (USD)")).toBeEnabled();
  await expect(page.getByTestId("analysis-summary")).toContainText("Who asks more questions?");
  await page.locator("#a-system").fill("You are terse.");
  await page.getByRole("button", { name: "Save draft" }).click();

  // Back on the list, expanded (the state is in the URL), with R2 as a draft.
  await expect(page).toHaveURL(new RegExp(`\\?open=${expN}`));
  const panel = page.getByTestId("experiment-panel");
  await expect(panel.getByTestId("panel-header")).toContainText("Both prompts");
  await expect(panel.getByTestId("panel-header")).toContainText("Who asks more questions?");
  const rows = panel.getByTestId("panel-run-row");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("You are curious.");
  await expect(rows.nth(1)).toContainText("You are terse.");
  await expect(rows.nth(1)).toContainText("draft");
  await expect(rows.nth(0)).toContainText("Report");

  // Locked now: the run page shows the lock instead of the toggle.
  await rows.nth(0).getByRole("link", { name: "R1" }).click();
  await expect(page.getByTestId("locked-note")).toBeVisible();
  await expect(page.getByTestId("experiment-toggle")).toHaveCount(0);

  // Shared settings: the read-only form, with a Clone button (cloning arrives in PR 5).
  await page.getByTestId("experiment-card").getByRole("link", { name: "Shared settings" }).click();
  await expect(page.getByRole("heading", { name: /Shared settings/ })).toBeVisible();
  await expect(page.locator("#a-system")).toBeDisabled();
  await expect(page.locator("#a-system")).toHaveValue("You are curious.");
  await expect(page.getByRole("button", { name: "Clone" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Start run" })).toBeHidden();

  // Collapse and expand from the list.
  await page.goto("/");
  const expRow = page.getByTestId("experiment-row").filter({ hasText: "Prompt experiment" });
  await expect(expRow).toContainText("Both prompts");
  await expect(expRow).toContainText("2");
  await expRow.getByRole("link", { name: `Expand EXP-${String(expN).padStart(3, "0")}` }).click();
  await expect(page).toHaveURL(new RegExp(`\\?open=${expN}`));
  await expect(page.getByTestId("experiment-panel")).toBeVisible();

  // Run the draft with its Run button; the list refreshes until it is done and reported.
  const r2 = page.getByTestId("panel-run-row").nth(1);
  await r2.getByRole("button", { name: "Run", exact: true }).click();
  await expect(r2).toContainText("done", { timeout: 45_000 });
  await expect(r2.getByRole("link", { name: "Report" })).toBeVisible({ timeout: 45_000 });

  // Compare: one run is not enough; two open the comparison page.
  await page.getByLabel("Compare R1").check();
  await page.getByRole("button", { name: "Compare ticked runs" }).click();
  await expect(page.getByText("Tick two or more runs to compare.")).toBeVisible();
  await page.getByLabel("Compare R1").check();
  await page.getByLabel("Compare R2").check();
  await page.getByRole("button", { name: "Compare ticked runs" }).click();
  await expect(page).toHaveURL(/comparisons\/1$/);
  await expect(page.getByRole("heading", { name: "Comparison 1: R1 vs R2" })).toBeVisible();
  const report = page.getByTestId("comparison-report");
  await expect(report.getByTestId("citation-check")).toContainText("Citation check passed", { timeout: 30_000 });
  // Unmasked once written: each letter maps to a run, and citations use run IDs.
  const mapping = page.getByTestId("comparison-run-row");
  await expect(mapping).toHaveCount(2);
  await expect(mapping.filter({ hasText: "Run X" })).toContainText(/R[12]/);
  await expect(mapping.filter({ hasText: "You are terse." })).toContainText("R2");
  await expect(report.getByTestId("comparison-footer")).toContainText("(4)");
  await expect(report.getByRole("link", { name: /^R[12]·C\d\d·T\d+$/ }).first()).toBeVisible();
  await expect(report.getByTestId("masked-report")).toContainText("Run X", { useInnerText: false });

  // The comparison is listed in the experiment's panel, and the prompt is on the Prompts page.
  await page.getByRole("link", { name: `EXP-${String(expN).padStart(3, "0")}` }).click();
  await expect(page.getByTestId("panel-comparisons")).toContainText("Comparison 1");
  await page.goto("/prompts");
  await expect(page.getByTestId("prompt").filter({ hasText: "Comparison report (v1)" })).toContainText("Report a difference only when");
});

test("unknown pages show not found", async ({ page }) => {
  const res = await page.goto("/experiments/999/runs/1");
  expect(res?.status()).toBe(404);
  await expect(page.getByRole("heading", { name: "Not found" })).toBeVisible();
});
