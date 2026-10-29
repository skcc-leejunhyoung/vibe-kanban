import { journalEventToWorkerEvent } from './vibe-events.mjs';

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
      const hostId = routine.action.targetHostId;
      const previous = leases.get(routine.id);
      if (!enabled && !previous) return;
      const response = await api(
        routine,
        "PUT",
        "/v1/autopilot-notification-leases",
        {
          host_id: hostId,
          routine_id: routine.id,
          instance_id: instanceId,
          kinds,
          protocol: 2,
          register: !previous || previous.hostId !== hostId,
          revoke: !enabled,
        },
      );
      if (enabled && response.protocol !== 2) {
        leases.delete(routine.id);
        await api(routine, 'PUT', '/v1/autopilot-notification-leases', {
          host_id: hostId,
          routine_id: routine.id,
          instance_id: instanceId,
          kinds,
          protocol: 2,
          revoke: true,
        });
        throw new Error('notification protocol 2 is required on the remote server');
      }
      if (enabled) leases.set(routine.id, { id: response.id, hostId });
      else leases.delete(routine.id);
    },
    async claim(routine, event) {
      if (event.notificationIntent !== "raw_event") return true;
      if (!event.notificationId || !event.notificationRevision) return false;
      const lease = leases.get(routine.id)?.id;
      if (!lease) return false;
      const key = keyOf(event);
      if (known.has(key)) return false;
      if (event.notificationClaim?.lease_id !== lease)
        event.notificationClaim = { lease_id: lease };
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
      const lease = leases.get(routine.id)?.id;
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
      const lease = leases.get(routine.id)?.id;
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
          ...journalEventToWorkerEvent({
            kind: 'cloud.notification',
            host_name: 'cloud',
            workspace_id: row.workspace_id,
            cursor: row.cursor,
            at: row.at,
            data: {
              id: row.id,
              type: row.type,
              revision: row.revision,
              intent: 'raw_event',
            },
          }),
          // Before handoff there is no queue side effect to replay. A new
          // worker must not inherit a crashed run's local exhausted receipt.
          id: `notification:${row.id}:${row.revision}:${instanceId}`,
          source: "vibe",
          type: "vk_event",
          kind: "cloud.notification",
          notificationId: row.id,
          notificationRevision: row.revision,
          notificationIntent: "raw_event",
          notificationClaim: { lease_id: lease, claim_token: row.claim_token },
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
            known.delete(key);
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
              `${row.handoff.path}/notification-handoff`,
              { lease_id: lease, handoff: row.handoff },
              true,
              row.handoff.meta,
            );
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
      if (items.length) {
        // Raw alerts always enter the durable queue, including an idle target.
        delivery.path = delivery.path.replace(/\/follow-up$/, '/queue');
        delivery.payload = {
          message: delivery.payload.message ?? delivery.payload.prompt,
          executor_config: delivery.payload.executor_config,
        };
        await request(routine, items[0], "handoff", {
          handoff_key: delivery.meta.idempotencyKey,
          handoff: delivery,
          members: delivery.members,
        });
      }
      // The receiving host stages the exact body, then atomically admits every
      // member centrally before publishing any runnable queue entry.
      const result = await api(
        routine,
        "POST",
        items.length ? `${delivery.path}/notification-handoff` : delivery.path,
        items.length
          ? { lease_id: items[0].notificationClaim.lease_id, handoff: delivery }
          : delivery.payload,
        true,
        delivery.meta,
      );
      for (const item of items) {
        known.delete(keyOf(item));
      }
      return result;
    },
  };
}
