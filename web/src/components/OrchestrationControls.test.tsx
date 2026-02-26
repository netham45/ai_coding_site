import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import { OrchestrationControls } from "./OrchestrationControls";

describe("OrchestrationControls smoke", () => {
  test("starts from selected tier", async () => {
    const user = userEvent.setup();
    const onStartFromTier = vi.fn();

    render(
      <OrchestrationControls
        onStartFromTier={onStartFromTier}
        onToggleAutoMode={() => undefined}
        onToggleAutoMerge={() => undefined}
      />
    );

    await user.selectOptions(screen.getByLabelText("Start Tier"), "phase");
    await user.click(screen.getByRole("button", { name: "Start From Tier" }));

    expect(onStartFromTier).toHaveBeenCalledTimes(1);
    expect(onStartFromTier).toHaveBeenCalledWith("phase");
  });

  test("emits automation toggle updates", async () => {
    const user = userEvent.setup();
    const onToggleAutoMode = vi.fn();
    const onToggleAutoMerge = vi.fn();

    render(
      <OrchestrationControls
        onStartFromTier={() => undefined}
        onToggleAutoMode={onToggleAutoMode}
        onToggleAutoMerge={onToggleAutoMerge}
      />
    );

    await user.click(screen.getByLabelText("Auto Mode"));
    await user.click(screen.getByLabelText("Auto Merge"));

    expect(onToggleAutoMode).toHaveBeenCalledWith(false);
    expect(onToggleAutoMerge).toHaveBeenCalledWith(false);
  });
});
