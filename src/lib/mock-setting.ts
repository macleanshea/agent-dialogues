/**
 * Whether the Mock model can be chosen in the forms. Off unless the
 * environment variable MOCK_MODEL is "on". The click-through tests turn it on
 * (see playwright.config.ts), since CI has no API key; deployments leave it
 * off, so the Mock model is not offered there. Server-only: read it in a page
 * or action and pass the result down.
 */
export function mockModelEnabled(): boolean {
  return process.env.MOCK_MODEL === "on";
}

export const MOCK_DISABLED_MESSAGE = "The Mock model is not available on this deployment. Choose a Claude model.";
