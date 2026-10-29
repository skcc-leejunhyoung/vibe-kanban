// Central claims, rather than the worker's best-effort JSON cache, own held alerts.
export function createNotificationRouting({ api, instanceId }) {
  const leases = new Map();
  const known = new Map();
  const keyOf = (item) => `${item.notificationId}:${item.notificationRevision}`;
  const itemsOf = (event) =>
    (event.events || [event])
      .filter((item) => item.notificationClaim)
      .map((item) => {
        const live = known.get(keyOf(item))?.notificationClaim;
        // Retry snapshots redact tokens; hydrate only the request copy for this lease.
        return live?.claim_token &&
          live.lease_id === item.notificationClaim.lease_id
          ? { ...item, notificationClaim: { ...live } }
          : item;
      });
  const body = (item, extra = {}) => ({
    revision: item.notificationRevision,
    ...item.notificationClaim,
    instance_id: instanceId,
    ...extra,
  });
  const request = (routine, item, action, extra) =>
    api(
      routine,
      "POST",
      `/v1/notifications/${encodeURIComponent(item.notificationId)}/${action}`,
      body(item, extra),
    );

  return {
    restore(event) {
      for (const item of itemsOf(event)) known.set(keyOf(item), item);
    },
    async register(routine, kinds, enabled) {
      const previous = leases.get(routine.id);
      if (!enabled && !previous) return;
      const response = await api(
        routine,
        "PUT",
        "/v1/autopilot-notification-leases",
        {
          host_id: routine.action.targetHostId,
          routine_id: routine.id,
          instance_id: instanceId,
          kinds,
          register: !previous,
          revoke: !enabled,
        },
      );
      if (enabled) leases.set(routine.id, response.id);
      else leases.delete(routine.id);
    },
    async claim(routine, event) {
      if (event.notificationIntent !== "raw_event") return true;
      if (!event.notificationId || !event.notificationRevision) return false;
      const lease = leases.get(routine.id);
      if (!lease) return false;
      const key = keyOf(event);
      if (known.has(key)) return false;
      event.notificationClaim ||= { lease_id: lease };
      try {
        const result = await request(routine, event, "claim");
        event.notificationClaim.claim_token = result.data.claim_token;
        known.set(key, event);
        return true;
      } catch (error) {
        if ([404, 409].includes(error.status)) return false;
        throw error;
      }
    },
    async releasePending(routine, event) {
      const lease = leases.get(routine.id);
      if (
        event.notificationIntent !== "raw_event" ||
        !event.notificationId ||
        !lease
      )
        return;
      await request(
        routine,
        { ...event, notificationClaim: { lease_id: lease } },
        "release",
      ).catch((error) => {
        if (![404, 409].includes(error.status)) throw error;
      });
    },
    async release(routine, event) {
      for (const item of itemsOf(event)) {
        await request(routine, item, "release").catch((error) => {
          if (![404, 409].includes(error.status)) throw error;
        });
        known.delete(keyOf(item));
      }
    },
    async recover(routine) {
      const lease = leases.get(routine.id);
      if (!lease) return [];
      const page = await api(
        routine,
        "GET",
        `/v1/notification-claims?lease_id=${lease}&instance_id=${instanceId}`,
      );
      if ((page.claims || []).length < 500) {
        const active = new Set(
          (page.claims || []).map((row) => `${row.id}:${row.revision}`),
        );
        for (const [key, item] of known)
          if (item.notificationClaim.lease_id === lease && !active.has(key))
            known.delete(key);
      }
      const recovered = [];
      for (const row of page.claims || []) {
        const event = {
          id: `notification:${row.id}:${row.revision}`,
          source: "vibe",
          type: "vk_event",
          kind: "cloud.notification",
          notificationId: row.id,
          notificationRevision: row.revision,
          notificationIntent: "raw_event",
          notificationClaim: { lease_id: lease, claim_token: row.claim_token },
          hostId: row.host_id || null,
          workspaceId: row.workspace_id || null,
          data: { id: row.id, type: row.type },
        };
        const key = keyOf(event);
        if (row.handoff_key) {
          await request(routine, event, "renew-claim");
          // The queue receipt is authoritative even if its HTTP response was lost.
          const receipt = await api(
            routine,
            "GET",
            `/api/automation-actions/receipts/${encodeURIComponent(row.handoff_key)}`,
            undefined,
            true,
          );
          if (receipt.status === "succeeded") {
            await request(routine, event, "consume", {
              handoff_key: row.handoff_key,
            });
          } else if (receipt.status === "missing" && row.handoff) {
            const members = row.handoff.members || [];
            const first = members[0];
            const head = first
              ? {
                  ...event,
                  notificationId: first.id,
                  notificationRevision: first.revision,
                  notificationClaim: {
                    lease_id: lease,
                    claim_token: first.claim_token,
                  },
                }
              : event;
            await request(routine, head, "handoff", {
              handoff_key: row.handoff_key,
              handoff: row.handoff,
              members,
            });
            await api(
              routine,
              "POST",
              row.handoff.path,
              row.handoff.payload,
              true,
              row.handoff.meta,
            );
            await request(routine, event, "consume", {
              handoff_key: row.handoff_key,
            });
          }
          // Running or unreachable is uncertain: renew, never resend under a new key.
          continue;
        }
        if (known.has(key)) {
          known.set(key, {
            ...known.get(key),
            notificationClaim: event.notificationClaim,
          });
          await request(routine, known.get(key), "renew-claim");
          continue;
        }
        recovered.push(event);
      }
      return recovered;
    },
    async deliver(routine, event, delivery) {
      const items = itemsOf(event);
      for (const item of items) await request(routine, item, "renew-claim");
      items.sort((a, b) => a.notificationId.localeCompare(b.notificationId));
      delivery = {
        ...delivery,
        members: items.map((item) => ({
          id: item.notificationId,
          revision: item.notificationRevision,
          claim_token: item.notificationClaim.claim_token,
        })),
      };
      if (items.length)
        await request(routine, items[0], "handoff", {
          handoff_key: delivery.meta.idempotencyKey,
          handoff: delivery,
          members: delivery.members,
        });
      // A restored local buffer cannot bypass a terminal central fallback.
      const result = await api(
        routine,
        "POST",
        delivery.path,
        delivery.payload,
        true,
        delivery.meta,
      );
      for (const item of items) {
        await request(routine, item, "consume", {
          handoff_key: delivery.meta.idempotencyKey,
        });
        known.delete(keyOf(item));
      }
      return result;
    },
  };
}
