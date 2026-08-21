import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { LeftNav } from "./LeftNav.tsx";

afterEach(cleanup);

describe("LeftNav", () => {
  it("keeps substrate inventory behind deliberate developer access", () => {
    render(
      <LeftNav
        view="floe"
        scopes={[{ scope_id: "scope-1", workspace_id: "ws-1", title: "Research", description: null, created_at: "", updated_at: "" }]}
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
      />,
    );

    expect(screen.getByRole("button", { name: /Floe$/ })).toBeTruthy();
    expect(screen.queryByText("Scopes")).toBeNull();
    expect(screen.queryByText("Substrate Settings")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Developer tools/ }));

    expect(screen.getByText("Scopes")).toBeTruthy();
    expect(screen.getByText("Research")).toBeTruthy();
    expect(screen.getByText("Substrate Settings")).toBeTruthy();
  });
});
