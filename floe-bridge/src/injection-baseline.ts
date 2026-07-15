/**
 * Inject-once dedup baseline — Slice C substrate primitive (fm/floe-instruction-inject-once).
 *
 * Keyed on (context_id, source). Records the hash of the last-injected content
 * per (context, source) pair. When a BeforeTurn hook returns
 * `{ inject: { source, content } }`:
 *
 *   - Same hash as last inject → SKIP (do not re-inject into the agent's prompt).
 *   - Content changed             → inject + update baseline.
 *   - No context_id               → always inject (can't key without a context binding).
 *
 * The baseline for a context is reset when the context history is cleared or
 * compacted so instructions re-inject into the fresh context on the next turn.
 *
 * This is an extension-agnostic substrate primitive. No snowball vocabulary here.
 */

/**
 * FNV-1a 32-bit hash — cheap, no crypto dependency, good enough for dedup key.
 * Identical to the `instructionHash` helper in pi-agent-core-adapter (kept local
 * here so this module stays independent).
 */
function contentHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export class InjectionBaseline {
  /**
   * Outer key: context_id.
   * Inner key: injection source label (e.g. "snowball", "memory").
   * Value: hash of the last injected content string.
   */
  private baselines = new Map<string, Map<string, string>>();

  /**
   * Filter hook results through inject-once dedup.
   *
   * For each result with `inject.source` (string) + `inject.content` (string):
   *   - If the hash matches the last injected baseline → strip `inject` (skip).
   *   - Otherwise → keep and update the baseline.
   *
   * Results without `inject`, or with non-string `content`, pass through unchanged
   * (non-string payloads are rendered as JSON by renderHookInjections; we can't
   * hash them reliably so we always inject them).
   *
   * When `contextId` is null, all results pass through unchanged — there is no
   * context to key the baseline on, so dedup is not possible.
   */
  applyDedup(
    contextId: string | null,
    results: ReadonlyArray<{ inject?: Record<string, unknown> }>
  ): Array<{ inject?: Record<string, unknown> }> {
    if (contextId === null) return results as Array<{ inject?: Record<string, unknown> }>;

    return results.map(result => {
      if (!result.inject) return result;

      const source = typeof result.inject.source === "string" ? result.inject.source : "extension";
      const content = typeof result.inject.content === "string" ? result.inject.content : null;

      // Non-string content: always inject (can't hash reliably)
      if (content === null) return result;

      const hash = contentHash(content);
      let contextMap = this.baselines.get(contextId);
      const lastHash = contextMap?.get(source);

      if (lastHash === hash) {
        // Same content: skip injection
        return {};
      }

      // Content changed (or first time): inject and update baseline
      if (!contextMap) {
        contextMap = new Map();
        this.baselines.set(contextId, contextMap);
      }
      contextMap.set(source, hash);
      return result;
    });
  }

  /**
   * Reset baselines for a specific context.
   *
   * Called when a `ContextHistoryCleared` or `ContextCompacted` event fires for
   * that context. The next BeforeTurn turn in this context will re-inject all
   * content into the fresh context window.
   */
  clearContext(contextId: string): void {
    this.baselines.delete(contextId);
  }

  /** Exposed for testing: check how many contexts are currently tracked. */
  get trackedContextCount(): number {
    return this.baselines.size;
  }
}
