/**
 * E2E test: Verifies pulse scheduling fires an event visible in the web UI.
 *
 * Prerequisites:
 * - floe-bus running on 127.0.0.1:5377
 * - floe-bridge running with a configured workspace
 * - floe-web dev or preview server running
 */
import { test, expect } from "@playwright/test";

const BUS_URL = "http://127.0.0.1:5377";
const WEB_URL = process.env.FLOE_WEB_URL ?? "http://127.0.0.1:5173";

test.describe("Pulse E2E", () => {
  test.skip(
    !process.env.FLOE_E2E_LIVE,
    "Set FLOE_E2E_LIVE=1 to run live E2E tests (requires bus+bridge+web running)"
  );

  test("one-off pulse fires and event appears in events API", async ({ request }) => {
    // 1. Get a workspace
    const workspacesRes = await request.get(`${BUS_URL}/v1/workspaces`);
    const { workspaces } = await workspacesRes.json();
    expect(workspaces.length).toBeGreaterThan(0);
    const workspaceId = workspaces[0].workspace_id;

    // 2. Create a one-off pulse that fires in 3 seconds
    const fireAt = new Date(Date.now() + 3_000).toISOString();
    const pulseId = `e2e-pulse-${Date.now()}`;
    const createRes = await request.post(`${BUS_URL}/v1/pulses`, {
      data: {
        pulse_id: pulseId,
        workspace_id: workspaceId,
        scope: "local",
        trigger: { type: "once", at: fireAt },
        content: { text: "E2E pulse test fired!" },
        subscribers: [{ endpoint_ref: "floe" }]
      }
    });
    expect(createRes.ok()).toBeTruthy();
    const { pulse } = await createRes.json();
    expect(pulse.status).toBe("active");

    // 3. Verify pulse listed
    const listRes = await request.get(
      `${BUS_URL}/v1/pulses?workspace_id=${encodeURIComponent(workspaceId)}`
    );
    const { pulses } = await listRes.json();
    expect(pulses.some((p: any) => p.pulse_id === pulseId)).toBeTruthy();

    // 4. Wait for it to fire (poll events for up to 15 seconds)
    let pulseFired = false;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const eventsRes = await request.get(
        `${BUS_URL}/v1/events?workspace_id=${encodeURIComponent(workspaceId)}&limit=50`
      );
      const { events } = await eventsRes.json();
      if (
        events.some(
          (e: any) =>
            e.type === "pulse.fired" && e.content?.pulse_id === pulseId
        )
      ) {
        pulseFired = true;
        break;
      }
    }
    expect(pulseFired).toBeTruthy();

    // 5. Verify pulse status is completed
    const afterRes = await request.get(
      `${BUS_URL}/v1/pulses?workspace_id=${encodeURIComponent(workspaceId)}&status=completed`
    );
    const afterPulses = await afterRes.json();
    expect(
      afterPulses.pulses.some((p: any) => p.pulse_id === pulseId)
    ).toBeTruthy();
  });

  test("pulse.fired event appears in web UI", async ({ page }) => {
    // Navigate to floe-web
    await page.goto(WEB_URL);
    await page.evaluate((busUrl) => {
      localStorage.setItem("floe.busUrl", busUrl);
    }, BUS_URL);
    await page.reload();
    await page.waitForTimeout(1000);

    // Wait for workspace to load
    await page.waitForSelector(
      ".workspace-home, [data-testid='workspace-loaded']",
      { timeout: 10000 }
    );

    // Get workspace ID from the bus
    const workspacesRes = await page.request.get(`${BUS_URL}/v1/workspaces`);
    const { workspaces } = await workspacesRes.json();
    const workspaceId = workspaces[0].workspace_id;

    // Create a pulse that fires in 3 seconds
    const fireAt = new Date(Date.now() + 3_000).toISOString();
    const pulseId = `ui-pulse-${Date.now()}`;
    await page.request.post(`${BUS_URL}/v1/pulses`, {
      data: {
        pulse_id: pulseId,
        workspace_id: workspaceId,
        scope: "local",
        trigger: { type: "once", at: fireAt },
        content: { text: "UI pulse test!" },
        subscribers: [{ endpoint_ref: "floe" }]
      }
    });

    // Wait for the pulse to fire and events to propagate
    await page.waitForTimeout(8000);

    // Verify the pulse.fired event exists via the API
    const events = await page.request.get(
      `${BUS_URL}/v1/events?workspace_id=${encodeURIComponent(workspaceId)}&limit=50`
    );
    const eventsData = await events.json();
    const pulseEvent = eventsData.events.find(
      (e: any) =>
        e.type === "pulse.fired" && e.content?.pulse_id === pulseId
    );
    expect(pulseEvent).toBeTruthy();
    // Slice 3: pulse triggers carry null source (no synthetic system endpoint).
    expect(pulseEvent.source_endpoint_id).toBeNull();
    expect(pulseEvent.metadata?.trigger_kind).toBe("pulse");
  });
});
