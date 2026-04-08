export const LIVE_SESSION_ACTIVE_STATUSES = [
  "waiting_for_owner",
  "waiting_for_customer",
  "joined"
] as const;

export const LIVE_SESSION_OWNER_ROLE = "owner" as const;
export const LIVE_SESSION_CUSTOMER_ROLE = "customer" as const;

export type LiveSessionRole = typeof LIVE_SESSION_OWNER_ROLE | typeof LIVE_SESSION_CUSTOMER_ROLE;

export function buildCustomerJoinPath(requestId: string, joinKey: string) {
  return `/call/${requestId}?joinKey=${encodeURIComponent(joinKey)}`;
}

export function getWaitingLabel(role: LiveSessionRole, ownerConnected: boolean, customerConnected: boolean) {
  if (role === LIVE_SESSION_OWNER_ROLE) {
    return customerConnected ? "Customer is here. Join with your camera on." : "Waiting for customer to arrive.";
  }

  return ownerConnected ? "Owner is on deck. Joining now..." : "Waiting for owner to join on video.";
}
