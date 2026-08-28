import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { LeftNav } from "./LeftNav.tsx";

afterEach(cleanup);

describe("LeftNav", () => {
  it("keeps substrate inventory behind deliberate developer access", () => {
    const onView = vi.fn();
    render(
      <LeftNav
        view="conversations"
        scopes={[{ scope_id: "scope-1", workspace_id: "ws-1", title: "Research", description: null, status: "active", created_at: "", updated_at: "" }]}
        selectedScopeId={null}
        actors={[]}
        selectedActorId={null}
        onView={onView}
        onSelectScope={vi.fn()}
        onSelectActor={vi.fn()}
        onNewScope={vi.fn()}
        onNewActor={vi.fn()}
        showNewActor={false}
        appMode="workspace"
        onViewSystem={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: /Conversations$/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Floe$/ })).toBeNull();
    expect(screen.queryByText("Scopes")).toBeNull();
    expect(screen.queryByText("Substrate Settings")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Conversations$/ }));
    expect(onView).toHaveBeenCalledWith("conversations");

    fireEvent.click(screen.getByRole("button", { name: /Developer tools/ }));

    expect(screen.getByText("Scopes")).toBeTruthy();
    expect(screen.getByText("Research")).toBeTruthy();
    expect(screen.getByText("Substrate Settings")).toBeTruthy();
  });

  it("distinguishes retained actor history from active actors", () => {
    render(
      <LeftNav
        view="conversations"
        scopes={[]}
        selectedScopeId={null}
        actors={[{
          endpoint_id: "actor:ws-1:old-controller",
          workspace_id: "ws-1",
          name: "Old Controller",
          agent_id: "old-controller",
          bridge_id: null,
          status: "retired",
          metadata_json: "{}",
          created_at: "",
          updated_at: "",
        }]}
        selectedActorId={null}
        onView={vi.fn()}
        onSelectScope={vi.fn()}
        onSelectActor={vi.fn()}
        onNewScope={vi.fn()}
        onNewActor={vi.fn()}
        showNewActor={false}
        appMode="workspace"
        onViewSystem={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Developer tools/ }));
    expect((screen.getByRole("button", { name: "O Old Controller (retired)" }) as HTMLButtonElement).title)
      .toBe("Historical actor identity; no longer available for work");
  });

  it("shows operator-readable health details and recovery when services stop", () => {
    const onRestartRuntime = vi.fn();
    render(
      <LeftNav
        view="conversations"
        scopes={[]}
        selectedScopeId={null}
        actors={[]}
        selectedActorId={null}
        onView={vi.fn()}
        onSelectScope={vi.fn()}
        onSelectActor={vi.fn()}
        onNewScope={vi.fn()}
        onNewActor={vi.fn()}
        showNewActor={false}
        appMode="workspace"
        onViewSystem={vi.fn()}
        runtimeHealth={{
          state: "offline",
          label: "Floe needs attention",
          detail: "Floe's local services stopped unexpectedly (exit code 1).",
          technicalDetail: "turn-end failed: 404",
        }}
        onRestartRuntime={onRestartRuntime}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Floe status: Floe needs attention" }));
    expect(screen.getByText(/exit code 1/)).toBeTruthy();
    expect(screen.getByText("Technical detail")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Restart local services" }));
    expect(onRestartRuntime).toHaveBeenCalledOnce();
  });
});
