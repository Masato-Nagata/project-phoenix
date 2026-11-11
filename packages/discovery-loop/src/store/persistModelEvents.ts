// Connects the in-memory model (src/model) to the Evidence_Store envelopes where the design says so:
//   store_rejection       -> `store_rejection` record (component, never a value)
//   ai_content_discarded  -> `ai_content_discarded` record (field names and paths, never a value)
//   evidence              -> `evidence` record (the Evidence record itself)
// `claim_revision` events are not written here: the orchestrator writes `hypothesis_revision` records.
import type { EvidenceStore } from "../model/evidenceStore.js";
import type { StoreEvent } from "../model/types.js";
import type { Result } from "../schema/index.js";
import type { JsonObject, RecordEnvelope, RunRecordStore, WriteError } from "./runRecordStore.js";

export class ModelEventPersister {
  private cursor = 0;

  constructor(
    private readonly model: EvidenceStore,
    private readonly store: RunRecordStore,
  ) {}

  /**
   * Writes the model events that were not written yet, in order. Stops at the first write error and
   * leaves that event unwritten so a later call retries it; an event refused for a secret hit counts as
   * handled (its rejection record is written), and the call goes on after returning that error.
   */
  async flush(): Promise<Result<RecordEnvelope[], WriteError>> {
    const written: RecordEnvelope[] = [];
    const events = this.model.events();
    while (this.cursor < events.length) {
      const event = events[this.cursor] as StoreEvent;
      const mapped = this.map(event);
      if (mapped !== undefined) {
        const r = await this.store.append(mapped.kind, mapped.payload, { component: mapped.component });
        if (r.ok) written.push(r.value);
        else if (r.error.kind === "secret_rejected") this.cursor++;
        if (!r.ok) return r;
      }
      this.cursor++;
    }
    return { ok: true, value: written };
  }

  private map(event: StoreEvent): { kind: "store_rejection" | "ai_content_discarded" | "evidence"; payload: JsonObject; component: string } | undefined {
    switch (event.type) {
      case "store_rejection":
        return {
          kind: "store_rejection",
          component: event.component,
          payload: {
            attempt: event.attempt,
            component: event.component,
            reason: event.reason,
            ...(event.targetRecordId === undefined ? {} : { targetRecordId: event.targetRecordId }),
          },
        };
      case "ai_content_discarded":
        return {
          kind: "ai_content_discarded",
          component: "evidence_store",
          payload: { aiOutputRecordId: event.aiOutputRecordId, fields: event.fields.map((f) => ({ path: f.path, name: f.name })) },
        };
      case "evidence": {
        const e = this.model.getEvidence(event.evidenceId);
        if (!e.ok) return undefined;
        return { kind: "evidence", component: "evidence_store", payload: structuredClone(e.value) as unknown as JsonObject };
      }
      case "claim_revision":
        return undefined;
    }
  }
}
