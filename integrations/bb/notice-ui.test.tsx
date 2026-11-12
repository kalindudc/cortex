// @vitest-environment jsdom
import { cleanup, fireEvent } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, expect, test, vi } from "vitest";
import { ErrorNotice } from "./panel/panel";
import { FailureNotice } from "./ui/parts";

afterEach(cleanup);

test.each(["legacy", "rpc"])("%s notice uses readable foreground while preserving alert structure and retry", name => {
  const retry = vi.fn();
  const component = () => name === "legacy" ? <ErrorNotice message="Notice failed" onRetry={retry} /> : <FailureNotice failure={{ code: "invalid", message: "Notice failed" }} onRetry={retry} />;
  const slot = renderSlot({ component }, {});
  const alert = slot.getByRole("alert");
  expect(alert.textContent).toContain("Notice failed");
  expect(alert.classList.contains("text-foreground")).toBe(true);
  expect(alert.classList.contains("border-destructive/40")).toBe(true);
  expect(alert.className).toMatch(/bg-(surface-destructive|destructive\/5)/);
  expect(alert.querySelector("[aria-hidden='true']")!.classList.contains("text-destructive-text")).toBe(true);
  fireEvent.click(slot.getByRole("button", { name: "Retry" }));
  expect(retry).toHaveBeenCalledTimes(1);
});
