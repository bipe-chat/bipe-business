import type { Store } from "./store.js";

// bipe#396, ADR 0078: removing a device ends its bridge sessions at once. Its Matrix device can still sync with
// its own access token, so the device stays in the list as pending until Matrix confirms the delete.

/** The Matrix side. deleteDevice treats a device that is already gone as deleted. */
export type DeviceDeleter = { deleteDevice(deviceId: string): Promise<void> } | null | undefined;

export type Revocation = "done" | "pending";

export const RECONCILE_INTERVAL_MS = 5 * 60_000;

export async function revokeDevice(store: Store, bipe: DeviceDeleter, deviceId: string): Promise<Revocation> {
  store.requestRevocation(deviceId);
  try {
    if (!bipe) throw new Error("no Matrix side");
    await bipe.deleteDevice(deviceId);
  } catch {
    store.revocationFailed(deviceId);
    // The device ID is not secret. The error can carry request data, so it stays out of the log.
    console.error(`bridge: Matrix did not delete device ${deviceId}; it stays pending and is retried`);
    return "pending";
  }
  store.markDeviceRemoved(deviceId);
  return "done";
}

/** Asks for removal of devices whose sessions expired, then retries every pending removal. */
export async function reconcileDevices(store: Store, bipe: DeviceDeleter): Promise<{ done: number; pending: number }> {
  for (const deviceId of store.expiredDevices()) {
    store.requestRevocation(deviceId);
    store.audit("device.expired", { detail: deviceId });
  }
  let done = 0;
  let pending = 0;
  for (const deviceId of store.pendingRevocations()) {
    if ((await revokeDevice(store, bipe, deviceId)) === "done") {
      done++;
      store.audit("device.revoked", { detail: deviceId });
    } else pending++;
  }
  return { done, pending };
}
