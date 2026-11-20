import { expect, test } from "@playwright/test";

test.describe.configure({ mode: "serial" });

/** Opens a collapsible section on the run page (sections are collapsed by default). */
async function openSection(page: import("@playwright/test").Page, testId: string) {
  const section = page.getByTestId(testId);
  if (!(await section.evaluate((e) => (e as HTMLDetailsElement).open))) await section.locator("summary h2").click();
  await expect(section).toHaveAttribute("open", "");
}

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
  // Explanations sit behind an (i) that shows on hover.
  const signOffInfo = page.locator("[role=tooltip]").filter({ hasText: "If the conversation has reached a natural end" });
  await expect(signOffInfo).toBeHidden();
  await signOffInfo.locator("xpath=..").hover();
  await expect(signOffInfo).toBeVisible();

  // Validation: an empty cost ceiling is rejected by the server.
  await page.getByLabel("Cost ceiling per run (USD)").fill("");
  await page.getByRole("button", { name: "Start run" }).click();
  await expect(page.getByText("Some settings need fixing.")).toBeVisible();
  await expect(page.getByText("Required", { exact: true })).toBeVisible();

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
  // R2 shares R1's [mock:flaky] prompt, so its even-numbered conversation is the one that completes.
  await expect(page.getByTestId("conversation-row").nth(1)).toContainText("Turn cap reached", { timeout: 30_000 });
  await expect(page.getByTestId("conversation-row").last()).toContainText("Turn cap reached", { timeout: 30_000 });
  await expect(page.getByTestId("live")).toHaveCount(0);
  // The cost meter shows the ceiling and the token breakdown, thinking included.
  // Sections are collapsed by default, except Conversations.
  await expect(page.getByTestId("conversations-section")).toHaveAttribute("open", "");
  await expect(page.getByTestId("config-section")).not.toHaveAttribute("open");
  await openSection(page, "cost-section");
  const meter = page.getByTestId("cost-meter");
  await expect(meter).toContainText("of $5.00 ceiling");
  await expect(meter.getByTestId("tokens-thinking")).toContainText("720"); // 18 turns × 40 mock thinking tokens
  await expect(meter.getByTestId("tokens-cache-read")).toBeVisible();
  await openSection(page, "config-section");
  await expect(page.getByTestId("config-section").getByText("If the conversation has reached a natural end").first()).toBeVisible();

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
  await expect(report.getByTestId("report-footer")).toContainText("Transcripts opened (3): R1·C01, R1·C02, R1·C03");
  await expect(report.getByTestId("report-footer")).toContainText("words");
  await expect(page.getByTestId("live")).toHaveCount(0, { timeout: 15_000 });

  // Aggregates by type, with the custom field among them.
  await openSection(page, "fields-section");
  await openSection(page, "measures-section");
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
  await openSection(page, "report-section");
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
  await openSection(page, "analysis-panel");
  await expect(page.getByTestId("analysis-panel")).toContainText("Look for disagreement.");
  await page.getByTestId("version-picker").getByRole("link", { name: "v1" }).click();
  await expect(page).toHaveURL(/\?v=1$/);
  await expect(page.getByTestId("field-aggregate")).toHaveCount(3);
  await expect(page.getByTestId("analysis-panel")).toContainText("Watch how the agents greet each other.");
});

test("experiments: declare a variable, add and run a draft, lock, expand, compare, and clone", async ({ page }) => {
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
  const expN = Number(/experiments\/(\d+)/.exec(page.url())![1]);
  const expLabel = `EXP-${String(expN).padStart(3, "0")}`;

  // "Create Experiment" opens a dialog. Unrelated settings show a warning;
  // system prompt A with "same as A" is labelled "Both prompts".
  await page.getByRole("button", { name: "Create Experiment", exact: true }).click();
  const dialog = page.getByTestId("experiment-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Create experiment" })).toBeDisabled();
  await dialog.getByLabel("Both models").check();
  await expect(dialog.getByLabel("Model A")).toBeChecked();
  await expect(dialog.getByTestId("variable-preview")).toHaveText("Both models");
  await expect(dialog.getByTestId("unrelated-warning")).toHaveCount(0);
  await dialog.getByLabel("Turns", { exact: true }).check();
  await expect(dialog.getByTestId("unrelated-warning")).toBeVisible();
  await dialog.getByLabel("Both models").uncheck();
  await dialog.getByLabel("Turns", { exact: true }).uncheck();
  await dialog.getByLabel("System prompt A").check();
  await expect(dialog.getByTestId("variable-preview")).toHaveText("Both prompts");
  await dialog.getByRole("button", { name: "Create experiment" }).click();

  // The dialog closes and the list opens with the new experiment expanded.
  await expect(page).toHaveURL(new RegExp(`\\?open=${expN}`));
  const expRow = page.getByTestId("experiment-row").filter({ hasText: "Prompt experiment" });
  await expect(expRow).toContainText("Both prompts");
  // Once it is an experiment, its row has no Create Exp. or Clone Run; each run row has Clone Run.
  await expect(expRow.getByRole("button", { name: "Create Exp." })).toHaveCount(0);
  await expect(expRow.getByRole("link", { name: "Clone Run" })).toHaveCount(0);
  await expect(page.getByTestId("experiment-panel").getByRole("link", { name: "Clone Run R1" })).toBeVisible();

  // The run page no longer offers Create Experiment, and shows the variable's value.
  await page.goto(`/experiments/${expN}/runs/1`);
  await expect(page.getByRole("button", { name: "Create Experiment" })).toHaveCount(0);
  await expect(page.getByTestId("run-subtitle")).toContainText("Both prompts: You are curious.");
  // Wait for the baseline to finish and be analyzed.
  await expect(page.getByTestId("coding-status")).toContainText("3 of 3 conversations coded", { timeout: 45_000 });
  await expect(page.getByTestId("citation-check")).toContainText("Citation check passed", { timeout: 30_000 });

  // + Add run: only the declared variable (and cost ceiling, concurrency) is unlocked. Cancel goes back.
  await page.goto(`/experiments/${expN}/runs/new`);
  await page.getByRole("link", { name: "Cancel" }).click();
  await expect(page).toHaveURL(new RegExp(`\\?open=${expN}`));
  await page.getByTestId("experiment-panel").getByRole("link", { name: "+ Add run" }).click();
  await expect(page.getByRole("heading", { name: "Add run: Prompt experiment" })).toBeVisible();
  await expect(page.getByTestId("add-run-intro")).toContainText("Both prompts");
  await expect(page.locator("#a-system")).toBeEnabled();
  await expect(page.locator("#a-system")).toHaveValue("You are curious.");
  await expect(page.getByLabel("Turns")).toBeDisabled();
  await expect(page.getByLabel("Turns")).toHaveValue("4");
  await expect(page.locator("#a-model")).toBeDisabled();
  await expect(page.getByLabel("Opening message to A")).toBeDisabled();
  await expect(page.getByLabel("Cost ceiling per run (USD)")).toBeEnabled();
  await expect(page.getByTestId("analysis-summary")).toContainText("Who asks more questions?");
  await expect(page.getByRole("button", { name: "Start run" })).toBeVisible();
  await page.locator("#a-system").fill("You are terse.");
  await page.getByRole("button", { name: "Save draft" }).click();

  // Back on the list, expanded (the state is in the URL), with R2 as a draft.
  await expect(page).toHaveURL(new RegExp(`\\?open=${expN}`));
  const panel = page.getByTestId("experiment-panel");
  await expect(panel.getByTestId("panel-header")).toContainText("Both prompts");
  await expect(panel.getByTestId("panel-header")).toContainText("Who asks more questions?");
  await expect(panel.getByRole("link", { name: "Shared settings" })).toHaveCount(0);
  const rows = panel.getByTestId("panel-run-row");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("You are curious.");
  await expect(rows.nth(1)).toContainText("You are terse.");
  await expect(rows.nth(1)).toContainText("draft");
  await expect(rows.nth(0)).toContainText("Report");

  // Collapse and expand with the (bigger) triangle.
  await expRow.getByRole("link", { name: `Collapse ${expLabel}` }).click();
  await expect(page.getByTestId("experiment-panel")).toHaveCount(0);
  await expRow.getByRole("link", { name: `Expand ${expLabel}` }).click();
  await expect(page).toHaveURL(new RegExp(`\\?open=${expN}`));
  await expect(page.getByTestId("experiment-panel")).toBeVisible();

  // Run the draft with its Run button; the list refreshes until it is done and reported.
  const r2 = page.getByTestId("panel-run-row").nth(1);
  await r2.getByRole("button", { name: "Run", exact: true }).click();
  await expect(r2).toContainText("done", { timeout: 45_000 });
  await expect(r2.getByRole("link", { name: "Report" })).toBeVisible({ timeout: 45_000 });

  // Compare: one run is not enough; two open the comparison page.
  await page.getByLabel("Compare R1").check();
  await page.getByRole("button", { name: "Compare", exact: true }).click();
  await expect(page.getByText("Tick two or more runs to compare.")).toBeVisible();
  await page.getByLabel("Compare R1").check();
  await page.getByLabel("Compare R2").check();
  await page.getByRole("button", { name: "Compare", exact: true }).click();
  await expect(page).toHaveURL(/comparisons\/1$/);
  await expect(page.getByRole("heading", { name: "Comparison 1: R1 vs R2" })).toBeVisible();
  const report = page.getByTestId("comparison-report");
  await expect(report.getByTestId("citation-check")).toContainText("Citation check passed", { timeout: 30_000 });
  // Unmasked once written: each letter maps to a run, and citations use run IDs.
  const mapping = page.getByTestId("comparison-run-row");
  await expect(mapping).toHaveCount(2);
  await expect(mapping.filter({ hasText: "Run X" })).toContainText(/R[12]/);
  await expect(mapping.filter({ hasText: "You are terse." })).toContainText("R2");
  await expect(report.getByTestId("comparison-footer")).toContainText("Transcripts opened (4)");
  await expect(report.getByRole("link", { name: /^R[12]·C\d\d·T\d+$/ }).first()).toBeVisible();
  await expect(report.getByTestId("masked-report")).toContainText("Run X", { useInnerText: false });

  // The comparison is listed in the experiment's panel.
  await page.getByRole("link", { name: expLabel }).click();
  await expect(page.getByTestId("panel-comparisons")).toContainText("Comparison 1");

  // Clone Run on R1's row opens the run form pre-filled from R1, as a new standalone run.
  await page.getByTestId("experiment-panel").getByRole("link", { name: "Clone Run R1" }).click();
  await expect(page.getByTestId("clone-source")).toContainText(`${expLabel} / R1`);
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue("Prompt experiment (copy)");
  await expect(page.locator("#a-system")).toHaveValue("You are curious.");
  await expect(page.getByLabel("Turns")).toHaveValue("4");
  await expect(page.getByLabel("Analysis focus")).toHaveValue("Who asks more questions?");
  await page.getByRole("link", { name: "Cancel" }).click();
  await expect(page).toHaveURL(/\/$/);

  await page.goto("/prompts");
  await expect(page.getByTestId("prompt").filter({ hasText: "Comparison report (v2)" })).toContainText("at most 1,000 words");
});

test("finishing: cost estimate, presets, retry, export, clone, and start from + Add run", async ({ page }) => {
  await page.goto("/runs/new");

  // The estimate updates as settings change: free with the Mock model, a range with a real one.
  // (The Mock model is listed only because the tests turn it on; deployments do not offer it.)
  const estimate = page.getByTestId("cost-estimate");
  await expect(estimate.getByTestId("estimate-run")).toHaveText("$0.00 (Mock model)");
  await page.locator("#a-model").selectOption("claude-opus-5-5");
  await page.locator("#b-model").selectOption("claude-opus-5-5");
  await expect(estimate.getByTestId("estimate-run")).toContainText("–");
  await page.getByLabel("Cost ceiling per run (USD)").fill("0.5");
  await expect(estimate.getByTestId("estimate-warning")).toContainText("ceiling");
  await page.getByLabel("Turns").fill("");
  await expect(estimate).toContainText("to see an estimate");
  await page.locator("#a-model").selectOption("mock");
  await page.locator("#b-model").selectOption("mock");
  await page.getByLabel("Cost ceiling per run (USD)").fill("5");

  // The three seeded presets load into the boxes.
  await page.getByLabel("System prompt A preset").selectOption({ label: "Another AI, no human" });
  await expect(page.locator("#a-system")).toHaveValue("You are in a conversation with another AI model. No human is taking part.");
  await page.getByLabel("System prompt A preset").selectOption({ label: "Blank (no system prompt)" });
  await expect(page.locator("#a-system")).toHaveValue("");
  await page.getByLabel("Opening message preset").selectOption({ label: "Act freely" });
  await expect(page.getByLabel("Opening message to A")).toHaveValue("You may act freely in this open-ended context.");

  // Save a preset from the form; it appears in B's list too.
  await page.locator("#a-system").fill("[mock:flaky]");
  await page.getByRole("button", { name: "Save System prompt A as preset" }).click();
  await page.getByLabel("Name for the System prompt A preset").fill("Flaky mock");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByLabel("System prompt B preset").locator("option", { hasText: "Flaky mock" })).toHaveCount(1);

  // A run whose odd-numbered conversations fail on their first attempt.
  await page.getByLabel("Name", { exact: true }).fill("Retry test");
  await page.getByLabel("Turns").fill("4");
  await page.getByLabel("Number of conversations").fill("3");
  await useMockJudges(page);
  await page.getByRole("button", { name: "Start run" }).click();
  await expect(page.getByRole("heading", { name: "Retry test" })).toBeVisible();
  const runUrl = page.url();
  const expN = Number(/experiments\/(\d+)/.exec(runUrl)![1]);
  const banner = page.getByTestId("retry-banner");
  await expect(banner).toContainText("2 conversations failed", { timeout: 30_000 });
  await expect(page.getByTestId("coding-status")).toContainText("1 of 1 conversations coded", { timeout: 45_000 });
  await expect(page.getByTestId("live")).toHaveCount(0, { timeout: 30_000 });

  // Retry: the two failed conversations start again and finish; the run is analyzed again.
  await banner.getByRole("button", { name: "Retry failed conversations" }).click();
  const rows = page.getByTestId("conversation-row");
  await expect(rows.nth(0)).toContainText("Turn cap reached", { timeout: 30_000 });
  await expect(rows.nth(2)).toContainText("Turn cap reached", { timeout: 30_000 });
  await expect(rows.nth(0)).toContainText("(retried)");
  await expect(rows.nth(1)).not.toContainText("(retried)");
  await expect(page.getByTestId("retry-banner")).toHaveCount(0);
  await expect(page.getByTestId("run-subtitle")).toContainText("2 conversations retried");
  await expect(page.getByTestId("coding-status")).toContainText("3 of 3 conversations coded", { timeout: 45_000 });
  await expect(page.getByTestId("citation-check")).toContainText("Citation check passed", { timeout: 30_000 });

  // Export: JSON and Markdown downloads of the run.
  const exportLinks = page.getByTestId("export-links");
  const download = page.waitForEvent("download");
  await exportLinks.getByRole("link", { name: "Export JSON" }).click();
  expect((await download).suggestedFilename()).toBe(`EXP-${String(expN).padStart(3, "0")}-R1.json`);
  const json = await page.request.get(`${runUrl}/export?format=json`);
  expect(json.headers()["content-type"]).toContain("application/json");
  const doc = await json.json();
  expect(doc.runs[0].conversations).toHaveLength(3);
  expect(doc.runs[0].conversations[0].retries).toBe(1);
  expect(doc.runs[0].conversations[0].turns[0].content[0].type).toBe("thinking");
  const md = await (await page.request.get(`${runUrl}/export?format=md`)).text();
  expect(md).toContain("# EXP-");
  expect(md).toContain("R1·C03·T4");
  expect((await page.request.get(`/experiments/${expN}/runs/9/export?format=json`)).status()).toBe(404);

  // The Presets page lists the saved preset (deletable) and the built-in ones (not).
  await page.getByRole("link", { name: "Presets" }).click();
  await expect(page.getByRole("heading", { name: "Presets" })).toBeVisible();
  const presetRows = page.getByTestId("preset-row");
  await expect(presetRows).toHaveCount(4);
  await expect(presetRows.filter({ hasText: "Act freely" }).getByRole("button", { name: /Delete/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Delete preset Flaky mock" }).click();
  await expect(presetRows).toHaveCount(3);
  await page.getByLabel("Name", { exact: true }).fill("Greeting");
  await page.getByLabel("For", { exact: true }).selectOption("opening_message");
  await page.getByLabel("Text", { exact: true }).fill("Hello, who are you?");
  await page.getByRole("button", { name: "Save preset" }).click();
  await expect(presetRows).toHaveCount(4);

  // Make it an experiment over Turns, then add a run and start it straight away.
  await page.goto(runUrl);
  await page.getByRole("button", { name: "Create Experiment", exact: true }).click();
  const dialog = page.getByTestId("experiment-dialog");
  await dialog.getByLabel("Turns", { exact: true }).check();
  await dialog.getByRole("button", { name: "Create experiment" }).click();
  await expect(page).toHaveURL(new RegExp(`\\?open=${expN}`));
  await expect(page.getByTestId("experiment-panel").getByTestId("export-links")).toBeVisible();
  await page.getByTestId("experiment-panel").getByRole("link", { name: "+ Add run" }).click();
  await expect(page.getByTestId("cost-estimate")).toContainText("from R1's actual averages");
  await page.getByLabel("Turns").fill("6");
  await page.getByRole("button", { name: "Start run" }).click();
  await expect(page).toHaveURL(new RegExp(`/experiments/${expN}/runs/2$`));
  await expect(page.getByTestId("conversation-row")).toHaveCount(3);
  // R2 shares R1's [mock:flaky] prompt, so its even-numbered conversation is the one that completes.
  await expect(page.getByTestId("conversation-row").nth(1)).toContainText("Turn cap reached", { timeout: 30_000 });

  // Clone Run on the run page copies that run's settings into a new standalone run.
  await page.getByRole("link", { name: "Clone Run" }).click();
  await expect(page.getByTestId("clone-source")).toContainText("/ R2");
  await expect(page.getByLabel("Turns")).toHaveValue("6");
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue("Retry test R2 (copy)");
});

test("unknown pages show not found", async ({ page }) => {
  const res = await page.goto("/experiments/999/runs/1");
  expect(res?.status()).toBe(404);
  await expect(page.getByRole("heading", { name: "Not found" })).toBeVisible();
});
