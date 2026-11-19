import { expect, test } from "@playwright/test";

test.describe.configure({ mode: "serial" });

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

  // Real models are listed but not selectable yet.
  await expect(page.locator("#a-model option[value='claude-opus-5-5']")).toBeDisabled();
  await expect(page.locator("#a-model option[value='claude-fable-5-2']")).toBeDisabled();

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
  await page.getByLabel("Name", { exact: true }).fill("Smoke test");
  await page.getByLabel("Turns").fill("6");
  await page.getByLabel("Number of conversations").fill("3");
  await page.getByRole("button", { name: "Start run" }).click();

  // Run page.
  await expect(page).toHaveURL(/\/experiments\/1\/runs\/1$/);
  await expect(page.getByRole("heading", { name: "Smoke test" })).toBeVisible();
  await expect(page.getByTestId("conversation-row")).toHaveCount(3);
  await expect(page.getByTestId("conversation-row").first()).toContainText("Turn cap reached");
  await expect(page.getByText("If the conversation has reached a natural end").first()).toBeVisible();

  // Conversation page.
  await page.getByRole("link", { name: "C01" }).click();
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

test("unknown pages show not found", async ({ page }) => {
  const res = await page.goto("/experiments/999/runs/1");
  expect(res?.status()).toBe(404);
  await expect(page.getByRole("heading", { name: "Not found" })).toBeVisible();
});
